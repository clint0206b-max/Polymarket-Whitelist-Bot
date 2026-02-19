#!/usr/bin/env python3
"""Generic backtest analyzer (optimized). Usage: python3 analyze_sport.py <sport>
Entry: 0.80-0.94 step 0.01 | SL: 0.70 down to 0.20 step 0.01"""
import json, sys

SPORT = sys.argv[1] if len(sys.argv) > 1 else "lol"
BASE = f"/Users/andres/.openclaw/workspace/polymarket-watchlist-v1/data/backtest/{SPORT}"
IN_FILE = f"{BASE}/timeseries_all.jsonl"

markets = []
with open(IN_FILE) as f:
    for line in f:
        markets.append(json.loads(line))

print(f"[{SPORT}] Loaded {len(markets)} markets", flush=True)

entries = [round(0.80 + i*0.01, 2) for i in range(15)]  # 0.80 to 0.94
sls = [round(0.70 - i*0.01, 2) for i in range(51)]       # 0.70 down to 0.20

# Preprocess: for each market side, compute:
# - For each entry level: the index where price first >= entry
# - From that index: the min price seen after entry (to quickly check SL)
# Actually, for each outcome we need: entry_idx, and min_price_after_entry for each entry

print("Preprocessing histories...", flush=True)

# For each market outcome, precompute:
# entry_data[entry] = (entered: bool, min_after: float)
preprocessed = []  # list of (side, entry_map)

for m in markets:
    for side in ['winner', 'loser']:
        history = m.get(f'{side}_history', [])
        if not history:
            continue
        
        prices = [pt.get('p', 0) for pt in history]
        n = len(prices)
        
        # For each entry level, find first index where price >= entry
        # Then compute min price from that index onward
        entry_map = {}
        
        # Compute suffix minimums (min from index i to end)
        suffix_min = [0.0] * n
        suffix_min[-1] = prices[-1]
        for i in range(n-2, -1, -1):
            suffix_min[i] = min(prices[i], suffix_min[i+1])
        
        for entry in entries:
            # Find first index where price >= entry
            entry_idx = -1
            for i in range(n):
                if prices[i] >= entry:
                    entry_idx = i
                    break
            
            if entry_idx == -1:
                entry_map[entry] = None  # never entered
            else:
                # min price from entry_idx onward
                entry_map[entry] = suffix_min[entry_idx]
        
        preprocessed.append((side, entry_map))

print(f"Preprocessed {len(preprocessed)} outcomes", flush=True)

# Now compute results
results = {}
for entry in entries:
    for sl in sls:
        wins = 0; losses = 0; fp_sl = 0; true_sl = 0; profit = 0.0
        
        for side, entry_map in preprocessed:
            info = entry_map.get(entry)
            if info is None:
                continue  # never entered
            
            min_after = info
            hit_sl = min_after <= sl
            
            if side == 'winner':
                if hit_sl:
                    fp_sl += 1; profit -= (entry - sl)
                else:
                    wins += 1; profit += (1.0 - entry)
            else:
                if hit_sl:
                    true_sl += 1; profit -= (entry - sl)
                else:
                    losses += 1; profit -= entry

        results[(entry, sl)] = {
            'wins': wins, 'losses': losses, 'fp_sl': fp_sl, 'true_sl': true_sl,
            'net': round(profit, 2),
            'total_trades': wins + losses + fp_sl + true_sl,
            'win_rate': round(wins / max(1, wins + fp_sl + losses) * 100, 1)
        }

print("Analysis complete!", flush=True)

# === SUMMARY: Best SL per entry ===
print(f"\n{'Entry':>6} | {'Best SL':>7} | {'Net$':>8} | {'Wins':>5} | {'FP_SL':>5} | {'Losses':>6} | {'True_SL':>7} | {'Trades':>6} | {'WinR%':>5}")
print("-" * 80)
for entry in entries:
    best_sl = max(sls, key=lambda s: results[(entry, s)]['net'])
    r = results[(entry, best_sl)]
    if r['total_trades'] == 0: continue
    print(f"{entry:>6.2f} | {best_sl:>7.2f} | {r['net']:>8.2f} | {r['wins']:>5} | {r['fp_sl']:>5} | {r['losses']:>6} | {r['true_sl']:>7} | {r['total_trades']:>6} | {r['win_rate']:>5.1f}")

# === DETAILED NET GRID ===
sl_chunks = [
    [round(0.70 - i*0.01, 2) for i in range(15)],  # 0.70-0.56
    [round(0.55 - i*0.01, 2) for i in range(15)],  # 0.55-0.41
    [round(0.40 - i*0.01, 2) for i in range(15)],  # 0.40-0.26
    [round(0.25 - i*0.01, 2) for i in range(6)],    # 0.25-0.20
]

for ci, chunk in enumerate(sl_chunks):
    print(f"\n\nNet profit grid (part {ci+1}) — SL {chunk[0]:.2f} to {chunk[-1]:.2f}:")
    print(f"{'':>6}", end="")
    for sl in chunk:
        print(f" |{sl:>6.2f}", end="")
    print()
    print("-" * (7 + 8 * len(chunk)))
    for entry in entries:
        print(f"{entry:>6.2f}", end="")
        for sl in chunk:
            r = results[(entry, sl)]
            print(f" |{r['net']:>6.1f}", end="")
        print()

# === FP GRID ===
for ci, chunk in enumerate(sl_chunks):
    print(f"\n\nFP SL count (part {ci+1}) — SL {chunk[0]:.2f} to {chunk[-1]:.2f}:")
    print(f"{'':>6}", end="")
    for sl in chunk:
        print(f" |{sl:>6.2f}", end="")
    print()
    print("-" * (7 + 8 * len(chunk)))
    for entry in entries:
        print(f"{entry:>6.2f}", end="")
        for sl in chunk:
            r = results[(entry, sl)]
            print(f" |{r['fp_sl']:>6}", end="")
        print()

# === RESOLUTION LOSSES ===
print(f"\n\nResolution losses (losers not stopped):")
has_losses = False
for entry in entries:
    for sl in sls:
        if results[(entry, sl)]['losses'] > 0:
            has_losses = True
            print(f"  entry={entry:.2f} sl={sl:.2f}: {results[(entry, sl)]['losses']} losses")
if not has_losses:
    print("  ZERO resolution losses across all entry×SL combinations!")

# === TP ANALYSIS ===
print(f"\n\nTP reach analysis (winners that entered at each price):")
for entry in entries:
    total_w = 0
    reach = {0.95: 0, 0.97: 0, 0.99: 0, 0.995: 0}
    for m in markets:
        history = m.get('winner_history', [])
        entered = any(pt.get('p', 0) >= entry for pt in history)
        if not entered: continue
        total_w += 1
        max_p = max((pt.get('p', 0) for pt in history), default=0)
        for tp in reach:
            if max_p >= tp: reach[tp] += 1
    if total_w:
        pcts = " | ".join(f"{tp}→{reach[tp]/total_w*100:.1f}%" for tp in reach)
        print(f"  entry={entry:.2f}: {total_w} winners | {pcts}")
