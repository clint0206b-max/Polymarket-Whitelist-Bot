#!/usr/bin/env python3
"""Generic backtest analyzer v2. Usage: python3 analyze_sport_v2.py <sport>
Entry: 0.80-0.94 step 0.01 | SL: 0.70 down to 0.20 step 0.01
Reports per-trade avg profit and total profit with $10 notional."""
import json, sys

SPORT = sys.argv[1] if len(sys.argv) > 1 else "lol"
NOTIONAL = 10  # dollars per trade
BASE = f"/Users/andres/.openclaw/workspace/polymarket-watchlist-v1/data/backtest/{SPORT}"
IN_FILE = f"{BASE}/timeseries_all.jsonl"

markets = []
with open(IN_FILE) as f:
    for line in f:
        markets.append(json.loads(line))

print(f"[{SPORT}] Loaded {len(markets)} markets | Notional: ${NOTIONAL}/trade", flush=True)

entries = [round(0.80 + i*0.01, 2) for i in range(15)]  # 0.80 to 0.94
sls = [round(0.70 - i*0.01, 2) for i in range(51)]       # 0.70 down to 0.20

# Preprocess
print("Preprocessing...", flush=True)
preprocessed = []
for m in markets:
    for side in ['winner', 'loser']:
        history = m.get(f'{side}_history', [])
        if not history: continue
        prices = [pt.get('p', 0) for pt in history]
        n = len(prices)
        suffix_min = [0.0] * n
        suffix_min[-1] = prices[-1]
        for i in range(n-2, -1, -1):
            suffix_min[i] = min(prices[i], suffix_min[i+1])
        entry_map = {}
        for entry in entries:
            entry_idx = -1
            for i in range(n):
                if prices[i] >= entry:
                    entry_idx = i; break
            if entry_idx == -1:
                entry_map[entry] = None
            else:
                entry_map[entry] = suffix_min[entry_idx]
        preprocessed.append((side, entry_map))

print(f"Preprocessed {len(preprocessed)} outcomes", flush=True)

results = {}
for entry in entries:
    shares_per_trade = NOTIONAL / entry  # shares you get for $NOTIONAL at entry price
    for sl in sls:
        wins = 0; losses = 0; fp_sl = 0; true_sl = 0; profit = 0.0
        
        for side, entry_map in preprocessed:
            info = entry_map.get(entry)
            if info is None: continue
            hit_sl = info <= sl
            
            if side == 'winner':
                if hit_sl:
                    fp_sl += 1
                    profit += shares_per_trade * sl - NOTIONAL  # sell at SL price
                else:
                    wins += 1
                    profit += shares_per_trade * 1.0 - NOTIONAL  # resolve at $1
            else:
                if hit_sl:
                    true_sl += 1
                    profit += shares_per_trade * sl - NOTIONAL
                else:
                    losses += 1
                    profit += shares_per_trade * 0.0 - NOTIONAL  # resolve at $0

        total_trades = wins + losses + fp_sl + true_sl
        results[(entry, sl)] = {
            'wins': wins, 'losses': losses, 'fp_sl': fp_sl, 'true_sl': true_sl,
            'net_total': round(profit, 2),
            'net_per_trade': round(profit / max(1, total_trades), 2),
            'total_trades': total_trades,
            'win_rate': round(wins / max(1, wins + fp_sl + losses) * 100, 1)
        }

# === SUMMARY ===
print(f"\n{'Entry':>6} | {'Best SL':>7} | {'Net Tot':>8} | {'$/trade':>7} | {'Wins':>5} | {'FP_SL':>5} | {'ResLoss':>7} | {'True_SL':>7} | {'Trades':>6} | {'WinR%':>5}")
print("-" * 90)
for entry in entries:
    best_sl = max(sls, key=lambda s: results[(entry, s)]['net_total'])
    r = results[(entry, best_sl)]
    if r['total_trades'] == 0: continue
    print(f"{entry:>6.2f} | {best_sl:>7.2f} | {r['net_total']:>8.2f} | {r['net_per_trade']:>7.2f} | {r['wins']:>5} | {r['fp_sl']:>5} | {r['losses']:>7} | {r['true_sl']:>7} | {r['total_trades']:>6} | {r['win_rate']:>5.1f}")

# === NET TOTAL GRID ===
sl_chunks = [
    [round(0.70 - i*0.01, 2) for i in range(15)],  # 0.70-0.56
    [round(0.55 - i*0.01, 2) for i in range(15)],  # 0.55-0.41
    [round(0.40 - i*0.01, 2) for i in range(15)],  # 0.40-0.26
    [round(0.25 - i*0.01, 2) for i in range(6)],    # 0.25-0.20
]

for ci, chunk in enumerate(sl_chunks):
    print(f"\n\nNet TOTAL ${NOTIONAL}/trade (part {ci+1}) — SL {chunk[0]:.2f} to {chunk[-1]:.2f}:")
    print(f"{'':>6}", end="")
    for sl in chunk:
        print(f" |{sl:>7.2f}", end="")
    print()
    print("-" * (7 + 9 * len(chunk)))
    for entry in entries:
        print(f"{entry:>6.2f}", end="")
        for sl in chunk:
            r = results[(entry, sl)]
            print(f" |{r['net_total']:>7.0f}", end="")
        print()

# === NET PER TRADE GRID (key zone only) ===
key_sls = [round(0.50 - i*0.01, 2) for i in range(21)]  # 0.50-0.30
print(f"\n\n$/trade (entry × SL) — SL 0.50 to 0.30:")
print(f"{'':>6}", end="")
for sl in key_sls:
    print(f" |{sl:>6.2f}", end="")
print()
print("-" * (7 + 8 * len(key_sls)))
for entry in entries:
    print(f"{entry:>6.2f}", end="")
    for sl in key_sls:
        r = results[(entry, sl)]
        print(f" |{r['net_per_trade']:>6.2f}", end="")
    print()

# === FP GRID (key zone) ===
print(f"\n\nFP SL count — SL 0.50 to 0.30:")
print(f"{'':>6}", end="")
for sl in key_sls:
    print(f" |{sl:>6.2f}", end="")
print()
print("-" * (7 + 8 * len(key_sls)))
for entry in entries:
    print(f"{entry:>6.2f}", end="")
    for sl in key_sls:
        r = results[(entry, sl)]
        print(f" |{r['fp_sl']:>6}", end="")
    print()

# === RESOLUTION LOSSES ===
print(f"\n\nResolution losses:")
has = False
for entry in entries:
    for sl in sls:
        if results[(entry, sl)]['losses'] > 0:
            has = True; print(f"  entry={entry:.2f} sl={sl:.2f}: {results[(entry, sl)]['losses']}")
if not has:
    print("  ZERO across all combinations!")

# === TP ===
print(f"\n\nTP reach (winners):")
for entry in [e for e in entries if 0.83 <= e <= 0.93]:
    total_w = 0; reach = {0.95: 0, 0.97: 0, 0.99: 0, 0.995: 0}
    for m in markets:
        h = m.get('winner_history', [])
        if not any(pt.get('p',0) >= entry for pt in h): continue
        total_w += 1
        mx = max((pt.get('p',0) for pt in h), default=0)
        for tp in reach:
            if mx >= tp: reach[tp] += 1
    if total_w:
        pcts = " | ".join(f"{tp}→{reach[tp]/total_w*100:.0f}%" for tp in reach)
        print(f"  entry={entry:.2f}: {total_w}W | {pcts}")
