#!/usr/bin/env python3
"""Scrape polymarketanalytics.com API for sports traders with full WR data."""
import json, time, sys, os
import urllib.request
from collections import defaultdict

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

def api_post(url, body, retries=3):
    for attempt in range(retries):
        try:
            data = json.dumps(body).encode()
            req = urllib.request.Request(url, data=data, headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0"
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except Exception as e:
            if attempt == retries - 1:
                print(f"  Error: {e}")
                return None
            time.sleep(1)

def api_get(url, retries=2):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read())
        except:
            if attempt == retries - 1: return None
            time.sleep(0.5)

sport_map = {
    'cs2-':'cs2','lol-':'lol','dota2-':'dota2','val-':'val',
    'nba-':'nba','cbb-':'cbb','cwbb-':'cwbb','nhl-':'nhl',
    'nfl-':'nfl','mlb-':'mlb','ufc-':'ufc','epl-':'epl',
    'ucl-':'ucl','boxing-':'boxing','mma-':'mma',
}

# ============================================================
# PHASE 1: Get all sports traders from analytics API
# ============================================================
print("=" * 70)
print("PHASE 1: Fetching sports leaderboard from polymarketanalytics.com")
print("=" * 70)

API_URL = "https://polymarketanalytics.com/api/traders-tag-performance"

all_traders = []
offset = 0
limit = 50

MAX_TRADERS = 1500
while len(all_traders) < MAX_TRADERS:
    body = {
        "getGlobalRange": False,
        "tag": "Sports",
        "limit": limit,
        "offset": offset,
        "sortBy": "winRate",
        "sortOrder": "desc",
        "minTotalPositions": 20,  # At least 20 resolved positions
    }
    
    print(f"  Fetching offset={offset}...", flush=True)
    result = api_post(API_URL, body)
    
    if not result or 'data' not in result or len(result['data']) == 0:
        break
    
    batch = result['data']
    all_traders.extend(batch)
    print(f"    Got {len(batch)} traders (total: {len(all_traders)})", flush=True)
    
    if len(batch) < limit:
        break
    
    offset += limit
    time.sleep(0.3)

print(f"\nTotal traders from API: {len(all_traders)}")

# ============================================================
# PHASE 2: Enrich with trade-level data from data-api
# ============================================================
print("\n" + "=" * 70)
print("PHASE 2: Enriching with trade data")
print("=" * 70)

results = []
for i, t in enumerate(all_traders):
    addr = t.get("trader", "")
    name = t.get("trader_name", addr[:12])
    
    if i % 25 == 0:
        print(f"\n--- Progress: {i}/{len(all_traders)} ---")
    
    # Analytics data already has the key metrics
    wr = t.get("win_rate", 0)
    wins = t.get("win_count", 0)
    total_pos = t.get("total_positions", 0)
    losses = total_pos - wins if total_pos > wins else 0
    pnl = t.get("overall_gain", 0)
    active = t.get("active_positions", 0)
    win_amt = t.get("win_amount", 0)
    loss_amt = t.get("loss_amount", 0)
    
    # Get trades for sport breakdown and buy price analysis
    url = f"https://data-api.polymarket.com/trades?user={addr}&limit=2000"
    trades = api_get(url)
    
    sport_counts = defaultdict(int)
    avg_buy = 0
    fav_pct = 0
    avg_size = 0
    hold_pct = 0
    total_trades = 0
    
    if trades and isinstance(trades, list) and len(trades) > 0:
        total_trades = len(trades)
        buys = [tx for tx in trades if tx.get("side") == "BUY"]
        
        for tx in trades:
            slug = tx.get("slug", "")
            matched = False
            for prefix, sport in sport_map.items():
                if slug.startswith(prefix):
                    sport_counts[sport] += 1
                    matched = True
                    break
            if not matched:
                sport_counts["other"] += 1
        
        buy_prices = [float(tx.get("price", 0)) for tx in buys if float(tx.get("price", 0)) > 0]
        avg_buy = sum(buy_prices) / len(buy_prices) if buy_prices else 0
        fav_pct = len([p for p in buy_prices if p >= 0.70]) / len(buy_prices) * 100 if buy_prices else 0
        
        sizes = [float(tx.get("size", 0)) * float(tx.get("price", 0)) for tx in trades]
        avg_size = sum(sizes) / len(sizes) if sizes else 0
        
        # Hold to resolve
        positions = defaultdict(lambda: {"b": 0, "s": 0})
        for tx in trades:
            slug = tx.get("slug", "")
            if tx.get("side") == "BUY": positions[slug]["b"] += 1
            else: positions[slug]["s"] += 1
        buy_only = sum(1 for p in positions.values() if p["b"] > 0 and p["s"] == 0)
        hold_pct = buy_only / len(positions) * 100 if positions else 0
    
    esports_total = sum(sport_counts.get(s, 0) for s in ["cs2", "lol", "dota2", "val"])
    sports_total = sum(v for k, v in sport_counts.items() if k != "other")
    esports_pct = esports_total / total_trades * 100 if total_trades > 0 else 0
    sports_pct = sports_total / total_trades * 100 if total_trades > 0 else 0
    
    r = {
        "address": addr,
        "name": name,
        "pnl": round(pnl, 0),
        "win_rate": round(wr * 100, 1),
        "wins": wins,
        "losses": losses,
        "total_positions": total_pos,
        "active_positions": active,
        "total_trades": total_trades,
        "avg_buy_price": round(avg_buy, 3),
        "fav_pct": round(fav_pct, 1),
        "avg_size": round(avg_size, 0),
        "sports_pct": round(sports_pct, 1),
        "esports_pct": round(esports_pct, 1),
        "hold_pct": round(hold_pct, 1),
        "sport_breakdown": dict(sport_counts),
        "tags": t.get("trader_tags", ""),
    }
    results.append(r)
    
    # Print standouts
    if wr >= 0.70 and total_pos >= 30 and (esports_pct > 20 or fav_pct > 40):
        short_name = (name or addr[:12])[:20]
        sp = sorted([(k,v) for k,v in sport_counts.items() if k != 'other'], key=lambda x: -x[1])[:3]
        sp_str = ", ".join(f"{k}:{v}" for k,v in sp)
        print(f"  ⭐ {short_name}: WR={wr*100:.0f}% ({wins}W/{losses}L) PnL=${pnl:,.0f} avg$={avg_size:.0f} fav={fav_pct:.0f}% esports={esports_pct:.0f}% | {sp_str}")
    
    time.sleep(0.3)

# ============================================================
# PHASE 3: Results
# ============================================================
print("\n" + "=" * 70)
print("RESULTS — SPORTS LEADERBOARD BY WIN RATE")
print("=" * 70)

# Sort by WR desc
results.sort(key=lambda x: (-x["win_rate"], -x["pnl"]))

# Filter: at least 30 resolved positions
active = [r for r in results if r["total_positions"] >= 30]

print(f"\nTotal: {len(results)} | 30+ positions: {len(active)}")
print(f"\n{'#':>3} {'Name':>20} {'WR':>5} {'W/L':>12} {'PnL':>12} {'Trades':>6} {'AvgBuy':>7} {'Avg$':>8} {'Sport%':>7} {'Esport%':>8} {'Fav%':>5} {'Hold%':>6}")
print("-" * 120)

for i, w in enumerate(active[:60]):
    name = (w["name"] or w["address"][:12])[:20]
    wl = f"{w['wins']}W/{w['losses']}L"
    print(f"{i+1:>3} {name:>20} {w['win_rate']:>4.0f}% {wl:>12} ${w['pnl']:>10,.0f} {w['total_trades']:>6} {w['avg_buy_price']:>7.3f} ${w['avg_size']:>7,.0f} {w['sports_pct']:>6.1f}% {w['esports_pct']:>7.1f}% {w['fav_pct']:>4.1f}% {w['hold_pct']:>5.1f}%")

# ESPORTS SPECIALISTS
print("\n\nESPORTS SPECIALISTS (>30% esports trades):")
esports = [r for r in active if r["esports_pct"] > 30]
esports.sort(key=lambda x: (-x["win_rate"], -x["pnl"]))
for w in esports:
    name = (w["name"] or w["address"][:12])[:20]
    sp = sorted([(k,v) for k,v in w["sport_breakdown"].items() if k in ["cs2","lol","dota2","val"]], key=lambda x: -x[1])
    sp_str = ", ".join(f"{k}:{v}" for k,v in sp)
    print(f"  {name}: WR={w['win_rate']:.0f}% ({w['wins']}W/{w['losses']}L) PnL=${w['pnl']:,.0f} trades={w['total_trades']} avg$={w['avg_size']:.0f} avg_buy={w['avg_buy_price']:.2f} | {sp_str}")

# FAVORITES BUYERS (>50% buys >= 0.70)
print("\nFAVORITES BUYERS (>50% buys at ≥0.70, our strategy):")
favs = [r for r in active if r["fav_pct"] >= 50 and r["sports_pct"] > 30]
favs.sort(key=lambda x: (-x["win_rate"], -x["pnl"]))
for w in favs:
    name = (w["name"] or w["address"][:12])[:20]
    sp = sorted([(k,v) for k,v in w["sport_breakdown"].items() if k != 'other'], key=lambda x: -x[1])[:4]
    sp_str = ", ".join(f"{k}:{v}" for k,v in sp)
    print(f"  {name}: WR={w['win_rate']:.0f}% ({w['wins']}W/{w['losses']}L) PnL=${w['pnl']:,.0f} avg_buy={w['avg_buy_price']:.2f} avg$={w['avg_size']:.0f} sports={w['sports_pct']:.0f}% | {sp_str}")

# COPY CANDIDATES: high WR, many trades, reasonable size, sports
print("\nBEST COPY CANDIDATES (WR>60%, 50+ positions, sports>30%):")
candidates = [r for r in active if r["win_rate"] >= 60 and r["total_positions"] >= 50 and r["sports_pct"] > 30]
candidates.sort(key=lambda x: (-x["win_rate"], -x["total_positions"]))
for w in candidates[:20]:
    name = (w["name"] or w["address"][:12])[:20]
    sp = sorted([(k,v) for k,v in w["sport_breakdown"].items() if k != 'other'], key=lambda x: -x[1])[:4]
    sp_str = ", ".join(f"{k}:{v}" for k,v in sp)
    print(f"  {name}: WR={w['win_rate']:.0f}% ({w['wins']}W/{w['losses']}L) PnL=${w['pnl']:,.0f} avg_buy={w['avg_buy_price']:.2f} avg$={w['avg_size']:.0f} | {sp_str}")

# Save
out = os.path.join(OUT_DIR, "analytics_full_results.json")
with open(out, "w") as f:
    json.dump({
        "timestamp": __import__('datetime').datetime.now().isoformat(),
        "total": len(results),
        "active_30plus": len(active),
        "all": results,
    }, f, indent=2)

print(f"\nSaved to {out}")
print("DONE!")
