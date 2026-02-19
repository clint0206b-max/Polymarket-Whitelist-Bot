import json, asyncio, aiohttp, os, time, sys

DATA_DIR = "/Users/andres/.openclaw/workspace/polymarket-watchlist-v1/data/backtest/cwbb"
OUT_FILE = f"{DATA_DIR}/timeseries_all.jsonl"
PROGRESS_FILE = f"{DATA_DIR}/download_progress.json"
CONCURRENCY = 10  # parallel requests
META_FILE = "/Users/andres/.openclaw/workspace/polymarket-watchlist-v1/state/journal/metadata_all.jsonl"

done_slugs = set()
if os.path.exists(PROGRESS_FILE):
    with open(PROGRESS_FILE) as f:
        done_slugs = set(json.load(f).get('done', []))

markets = []
with open(META_FILE) as f:
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
            'slug': d['slug'], 'tokens': tokens, 'winner_idx': winner_idx,
            'outcomes': outcomes, 'volume': d.get('volumeNum', 0)
        })

print(f"Remaining: {len(markets)} (already done: {len(done_slugs)})", flush=True)

async def fetch_history(session, token_id):
    url = f"https://clob.polymarket.com/prices-history?market={token_id}&interval=1m&fidelity=10"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            data = await resp.json()
            return data.get('history', [])
    except:
        return []

async def process_market(session, m, semaphore):
    async with semaphore:
        histories = {}
        for oidx in [0, 1]:
            tag = "winner" if oidx == m['winner_idx'] else "loser"
            histories[tag] = await fetch_history(session, m['tokens'][oidx])
        return {
            'slug': m['slug'], 'winner_idx': m['winner_idx'], 'outcomes': m['outcomes'],
            'volume': m['volume'],
            'winner_points': len(histories.get('winner', [])),
            'loser_points': len(histories.get('loser', [])),
            'winner_history': histories.get('winner', []),
            'loser_history': histories.get('loser', [])
        }

async def main():
    semaphore = asyncio.Semaphore(CONCURRENCY)
    connector = aiohttp.TCPConnector(limit=CONCURRENCY)
    async with aiohttp.ClientSession(connector=connector) as session:
        # Process in batches of 50
        batch_size = 50
        with open(OUT_FILE, 'a') as out:
            for batch_start in range(0, len(markets), batch_size):
                batch = markets[batch_start:batch_start + batch_size]
                tasks = [process_market(session, m, semaphore) for m in batch]
                results = await asyncio.gather(*tasks)
                
                for r in results:
                    out.write(json.dumps(r) + '\n')
                    done_slugs.add(r['slug'])
                out.flush()
                
                with open(PROGRESS_FILE, 'w') as pf:
                    json.dump({'done': list(done_slugs)}, pf)
                
                total_done = len(done_slugs)
                print(f"  [{total_done}] batch done, last={batch[-1]['slug']}", flush=True)

asyncio.run(main())
print("Done!", flush=True)
