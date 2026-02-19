import json, subprocess, time, os, sys

DATA_DIR = "/Users/andres/.openclaw/workspace/polymarket-watchlist-v1/data/backtest/cwbb"
os.makedirs(DATA_DIR, exist_ok=True)
OUT_FILE = f"{DATA_DIR}/timeseries_all.jsonl"
PROGRESS_FILE = f"{DATA_DIR}/download_progress.json"

# Load progress if resuming
done_slugs = set()
if os.path.exists(PROGRESS_FILE):
    with open(PROGRESS_FILE) as f:
        done_slugs = set(json.load(f).get('done', []))

# Get all CWBB moneyline resolved markets
markets = []
with open('/Users/andres/.openclaw/workspace/polymarket-watchlist-v1/state/journal/metadata_all.jsonl') as f:
    for line in f:
        d = json.loads(line)
        if not d.get('slug','').startswith('cwbb-'): continue
        if d.get('sportsMarketType') != 'moneyline' or not d.get('closed'): continue
        tokens = json.loads(d['clobTokenIds']) if isinstance(d['clobTokenIds'], str) else d['clobTokenIds']
        prices = json.loads(d['outcomePrices']) if isinstance(d['outcomePrices'], str) else d['outcomePrices']
        if '1' not in prices or len(tokens) < 2: continue
        if d['slug'] in done_slugs: continue
        winner_idx = prices.index('1')
        outcomes = json.loads(d['outcomes']) if isinstance(d['outcomes'], str) else d['outcomes']
        markets.append({
            'slug': d['slug'],
            'tokens': tokens,
            'winner_idx': winner_idx,
            'outcomes': outcomes,
            'volume': d.get('volumeNum', 0)
        })

print(f"Total CWBB markets: {len(markets)} remaining ({len(done_slugs)} already done)", flush=True)

def fetch_history(token_id):
    try:
        r = subprocess.run(['curl', '-s', '--max-time', '8',
            f'https://clob.polymarket.com/prices-history?market={token_id}&interval=1m&fidelity=10'],
            capture_output=True, text=True, timeout=12)
        return json.loads(r.stdout).get('history', [])
    except:
        return []

errors = 0
with open(OUT_FILE, 'a') as out:
    for i, m in enumerate(markets):
        # Fetch both outcomes
        histories = {}
        for oidx in [0, 1]:
            tag = "winner" if oidx == m['winner_idx'] else "loser"
            h = fetch_history(m['tokens'][oidx])
            histories[tag] = h
            time.sleep(0.2)
        
        # Write record
        record = {
            'slug': m['slug'],
            'winner_idx': m['winner_idx'],
            'outcomes': m['outcomes'],
            'volume': m['volume'],
            'winner_points': len(histories.get('winner', [])),
            'loser_points': len(histories.get('loser', [])),
            'winner_history': histories.get('winner', []),
            'loser_history': histories.get('loser', [])
        }
        out.write(json.dumps(record) + '\n')
        out.flush()
        
        done_slugs.add(m['slug'])
        
        # Save progress every 50
        if (i + 1) % 50 == 0:
            with open(PROGRESS_FILE, 'w') as pf:
                json.dump({'done': list(done_slugs)}, pf)
        
        if (i + 1) % 100 == 0:
            print(f"  [{i+1}/{len(markets)}] last={m['slug']} w={record['winner_points']}pts l={record['loser_points']}pts", flush=True)

    # Final progress save
    with open(PROGRESS_FILE, 'w') as pf:
        json.dump({'done': list(done_slugs)}, pf)

print(f"\nDone! {len(markets)} markets saved to {OUT_FILE}", flush=True)
