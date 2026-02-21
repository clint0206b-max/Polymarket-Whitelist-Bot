#!/usr/bin/env python3
"""
Massive Polymarket sports wallet scanner.
Downloads top 500 sports wallets from leaderboard, analyzes trading patterns.
"""

import json, time, sys, os
import urllib.request
from collections import defaultdict
from datetime import datetime

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
RESULTS_FILE = os.path.join(OUT_DIR, "massive_scan_results.json")
PROGRESS_FILE = os.path.join(OUT_DIR, "massive_scan_progress.json")

def api_get(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read())
        except Exception as e:
            if attempt == retries - 1:
                return None
            time.sleep(1)
    return None

def save_progress(phase, detail, wallets_done=0, total=0):
    with open(PROGRESS_FILE, "w") as f:
        json.dump({"phase": phase, "detail": detail, "done": wallets_done, "total": total, "ts": time.time()}, f)

# ============================================================
# PHASE 1: Download leaderboard (multiple periods to get 500+)
# ============================================================
print("=" * 60)
print("PHASE 1: Downloading sports leaderboard")
print("=" * 60)

all_wallets = {}  # address -> {name, pnl, volume, ...}

for period in ["all", "monthly", "weekly"]:
    save_progress("leaderboard", f"Fetching {period}...")
    url = f"https://data-api.polymarket.com/leaderboard?period={period}&category=sports&limit=500"
    data = api_get(url)
    if data and isinstance(data, list):
        for entry in data:
            addr = entry.get("userAddress", entry.get("proxyWallet", entry.get("address", "")))
            if not addr:
                # Try different field names
                for key in entry:
                    val = entry[key]
                    if isinstance(val, str) and val.startswith("0x") and len(val) == 42:
                        addr = val
                        break
            if addr and addr not in all_wallets:
                all_wallets[addr] = {
                    "name": entry.get("name", entry.get("pseudonym", entry.get("username", ""))),
                    "pnl": float(entry.get("pnl", entry.get("profit", entry.get("totalPnl", 0)))),
                    "volume": float(entry.get("volume", entry.get("totalVolume", 0))),
                    "source_period": period,
                    "raw": entry
                }
        print(f"  {period}: got {len(data)} entries, total unique: {len(all_wallets)}")
    else:
        print(f"  {period}: FAILED or empty response")
        if data:
            print(f"  Response type: {type(data)}, sample: {str(data)[:200]}")
    time.sleep(0.5)

# Also try without category filter and general endpoint variations
for variant_url in [
    "https://data-api.polymarket.com/leaderboard?limit=500&category=sports",
    "https://data-api.polymarket.com/leaderboard?limit=500",
]:
    if len(all_wallets) >= 200:
        break
    data = api_get(variant_url)
    if data and isinstance(data, list):
        for entry in data:
            addr = ""
            for key in entry:
                val = entry[key]
                if isinstance(val, str) and val.startswith("0x") and len(val) == 42:
                    addr = val
                    break
            if addr and addr not in all_wallets:
                all_wallets[addr] = {
                    "name": entry.get("name", entry.get("pseudonym", "")),
                    "pnl": float(entry.get("pnl", entry.get("profit", 0))),
                    "volume": float(entry.get("volume", 0)),
                    "source_period": "variant",
                    "raw": entry
                }
        print(f"  variant: got {len(data)}, total unique: {len(all_wallets)}")
    time.sleep(0.5)

print(f"\nTotal wallets collected: {len(all_wallets)}")

if len(all_wallets) == 0:
    print("\nERROR: No wallets found. Trying to debug...")
    # Try raw request to see what the API returns
    for test_url in [
        "https://data-api.polymarket.com/leaderboard",
        "https://data-api.polymarket.com/leaderboard?limit=10",
        "https://data-api.polymarket.com/leaderboard?period=all&limit=10",
    ]:
        result = api_get(test_url)
        print(f"  {test_url}")
        print(f"    Type: {type(result)}")
        if result:
            if isinstance(result, list) and len(result) > 0:
                print(f"    Keys: {list(result[0].keys())[:20]}")
                print(f"    Sample: {json.dumps(result[0], indent=2)[:500]}")
            elif isinstance(result, dict):
                print(f"    Keys: {list(result.keys())[:20]}")
                print(f"    Sample: {json.dumps(result, indent=2)[:500]}")
        time.sleep(0.5)
    sys.exit(1)

# Sort by PnL descending, take top 500
sorted_wallets = sorted(all_wallets.items(), key=lambda x: -abs(x[1]["pnl"]))[:500]
print(f"Analyzing top {len(sorted_wallets)} wallets by PnL")

# ============================================================
# PHASE 2: Download trades for each wallet
# ============================================================
print("\n" + "=" * 60)
print("PHASE 2: Downloading trades for each wallet")
print("=" * 60)

wallet_analyses = []

for idx, (addr, info) in enumerate(sorted_wallets):
    save_progress("trades", f"Wallet {idx+1}/{len(sorted_wallets)}: {info['name'] or addr[:10]}", idx, len(sorted_wallets))
    
    if idx % 50 == 0:
        print(f"\n--- Progress: {idx}/{len(sorted_wallets)} ---")
    
    # Get last 1000 trades
    url = f"https://data-api.polymarket.com/trades?user={addr}&limit=1000"
    trades = api_get(url)
    
    if not trades or not isinstance(trades, list):
        wallet_analyses.append({
            "address": addr,
            "name": info["name"],
            "leaderboard_pnl": info["pnl"],
            "leaderboard_volume": info["volume"],
            "error": "no_trades",
            "total_trades": 0
        })
        time.sleep(0.2)
        continue
    
    # Analyze trades
    buys = [t for t in trades if t.get("side") == "BUY"]
    sells = [t for t in trades if t.get("side") == "SELL"]
    
    total_vol = sum(float(t.get("size", 0)) * float(t.get("price", 0)) for t in trades)
    buy_vol = sum(float(t.get("size", 0)) * float(t.get("price", 0)) for t in buys)
    
    # Sport breakdown
    sport_counts = defaultdict(int)
    sport_prefixes = {
        'cs2-': 'cs2', 'lol-': 'lol', 'dota2-': 'dota2', 'val-': 'val',
        'nba-': 'nba', 'cbb-': 'cbb', 'cwbb-': 'cwbb', 'nhl-': 'nhl',
        'nfl-': 'nfl', 'mlb-': 'mlb', 'ufc-': 'ufc', 'epl-': 'epl',
        'ucl-': 'ucl', 'boxing-': 'boxing', 'mma-': 'mma',
        'fl1-': 'fl1', 'ser-': 'ser', 'bun-': 'bun', 'lal-': 'lal'
    }
    for t in trades:
        slug = t.get("slug", "")
        matched = False
        for prefix, sport in sport_prefixes.items():
            if slug.startswith(prefix):
                sport_counts[sport] += 1
                matched = True
                break
        if not matched:
            sport_counts["other"] += 1
    
    sports_total = sum(v for k, v in sport_counts.items() if k != "other")
    sports_pct = sports_total / len(trades) * 100 if trades else 0
    
    # Unique markets
    slugs = set(t.get("slug", "") for t in trades)
    
    # Buy prices
    buy_prices = [float(t.get("price", 0)) for t in buys if float(t.get("price", 0)) > 0]
    avg_buy = sum(buy_prices) / len(buy_prices) if buy_prices else 0
    favorites_pct = len([p for p in buy_prices if p >= 0.75]) / len(buy_prices) * 100 if buy_prices else 0
    
    # Trade sizes
    sizes = [float(t.get("size", 0)) * float(t.get("price", 0)) for t in trades]
    avg_size = sum(sizes) / len(sizes) if sizes else 0
    median_size = sorted(sizes)[len(sizes)//2] if sizes else 0
    
    # Date range
    timestamps = [int(t.get("timestamp", 0)) for t in trades if t.get("timestamp")]
    days_active = 0
    trades_per_day = 0
    if timestamps:
        first = min(timestamps)
        last = max(timestamps)
        days_active = max((last - first) / 86400, 1)
        trades_per_day = len(trades) / days_active
    
    # Hold-to-resolve check
    positions = defaultdict(lambda: {"b": 0, "s": 0})
    for t in trades:
        slug = t.get("slug", "")
        if t.get("side") == "BUY":
            positions[slug]["b"] += 1
        else:
            positions[slug]["s"] += 1
    
    buy_only_mkts = sum(1 for p in positions.values() if p["b"] > 0 and p["s"] == 0)
    hold_pct = buy_only_mkts / len(positions) * 100 if positions else 0
    
    analysis = {
        "address": addr,
        "name": info["name"],
        "leaderboard_pnl": info["pnl"],
        "leaderboard_volume": info["volume"],
        "total_trades": len(trades),
        "buys": len(buys),
        "sells": len(sells),
        "total_volume": round(total_vol, 2),
        "avg_trade_size": round(avg_size, 2),
        "median_trade_size": round(median_size, 2),
        "avg_buy_price": round(avg_buy, 4),
        "favorites_pct": round(favorites_pct, 1),
        "unique_markets": len(slugs),
        "sports_pct": round(sports_pct, 1),
        "sport_breakdown": dict(sport_counts),
        "hold_to_resolve_pct": round(hold_pct, 1),
        "days_active": round(days_active, 1),
        "trades_per_day": round(trades_per_day, 1),
    }
    
    wallet_analyses.append(analysis)
    
    # Rate limit
    time.sleep(0.3)

# ============================================================
# PHASE 3: Filter and rank
# ============================================================
print("\n" + "=" * 60)
print("PHASE 3: Filtering and ranking")
print("=" * 60)

# Filter: has trades, positive PnL, >20 trades
active = [w for w in wallet_analyses if w.get("total_trades", 0) >= 20]
profitable = [w for w in active if w.get("leaderboard_pnl", 0) > 0]
small_avg = [w for w in profitable if w.get("avg_trade_size", 99999) < 500]
sports_focused = [w for w in profitable if w.get("sports_pct", 0) > 30]
holders = [w for w in profitable if w.get("hold_to_resolve_pct", 0) > 60]
favorites = [w for w in profitable if w.get("favorites_pct", 0) > 40]

print(f"Total analyzed: {len(wallet_analyses)}")
print(f"Active (>=20 trades): {len(active)}")
print(f"Profitable: {len(profitable)}")
print(f"Small avg (<$500): {len(small_avg)}")
print(f"Sports focused (>30%): {len(sports_focused)}")
print(f"Hold to resolve (>60%): {len(holders)}")
print(f"Favorites buyers (>40%): {len(favorites)}")

# Score each wallet for similarity to our strategy
for w in wallet_analyses:
    score = 0
    if w.get("total_trades", 0) >= 50: score += 2
    elif w.get("total_trades", 0) >= 20: score += 1
    if w.get("leaderboard_pnl", 0) > 0: score += 2
    if w.get("avg_trade_size", 99999) < 500: score += 2
    elif w.get("avg_trade_size", 99999) < 1000: score += 1
    if w.get("sports_pct", 0) > 50: score += 2
    elif w.get("sports_pct", 0) > 20: score += 1
    if w.get("hold_to_resolve_pct", 0) > 80: score += 2
    elif w.get("hold_to_resolve_pct", 0) > 50: score += 1
    if w.get("favorites_pct", 0) > 50: score += 2
    elif w.get("favorites_pct", 0) > 30: score += 1
    if w.get("trades_per_day", 0) >= 2: score += 1
    # ROI bonus: high PnL relative to volume
    vol = w.get("leaderboard_volume", 0)
    pnl = w.get("leaderboard_pnl", 0)
    if vol > 0 and pnl > 0:
        roi = pnl / vol
        if roi > 0.10: score += 3
        elif roi > 0.05: score += 2
        elif roi > 0.02: score += 1
    w["score"] = score
    w["roi"] = round(pnl / vol, 4) if vol > 0 else 0

# Sort by score, then PnL
ranked = sorted(wallet_analyses, key=lambda x: (-x.get("score", 0), -x.get("leaderboard_pnl", 0)))

# ============================================================
# PHASE 4: Output results
# ============================================================
print("\n" + "=" * 60)
print("TOP 30 WALLETS BY SCORE")
print("=" * 60)

print(f"\n{'#':>3} {'Name':>15} {'Score':>5} {'PnL':>12} {'ROI':>7} {'Trades':>7} {'Avg$':>7} {'Sports%':>8} {'Hold%':>6} {'Fav%':>5} {'T/day':>5}")
print("-" * 100)

for i, w in enumerate(ranked[:30]):
    name = (w.get("name", "") or w["address"][:10])[:15]
    print(f"{i+1:>3} {name:>15} {w.get('score',0):>5} ${w.get('leaderboard_pnl',0):>10,.0f} {w.get('roi',0):>6.2%} {w.get('total_trades',0):>7} ${w.get('avg_trade_size',0):>6,.0f} {w.get('sports_pct',0):>7.1f}% {w.get('hold_to_resolve_pct',0):>5.1f}% {w.get('favorites_pct',0):>4.1f}% {w.get('trades_per_day',0):>5.1f}")

# Print sport breakdown for top 10
print("\n\nSPORT BREAKDOWN - TOP 10:")
for i, w in enumerate(ranked[:10]):
    name = (w.get("name", "") or w["address"][:10])[:15]
    sports = w.get("sport_breakdown", {})
    sports_str = ", ".join(f"{k}:{v}" for k, v in sorted(sports.items(), key=lambda x: -x[1]) if k != "other")
    print(f"  {i+1}. {name}: {sports_str} | other:{sports.get('other',0)}")

# Save full results
save_progress("done", "Complete!", len(sorted_wallets), len(sorted_wallets))

with open(RESULTS_FILE, "w") as f:
    json.dump({
        "timestamp": datetime.now().isoformat(),
        "total_wallets_scanned": len(wallet_analyses),
        "top_30": ranked[:30],
        "all_results": ranked,
        "filters": {
            "active_20plus": len(active),
            "profitable": len(profitable),
            "small_avg_under_500": len(small_avg),
            "sports_over_30pct": len(sports_focused),
            "hold_over_60pct": len(holders),
            "favorites_over_40pct": len(favorites),
        }
    }, f, indent=2)

print(f"\n\nResults saved to {RESULTS_FILE}")
print("DONE!")
