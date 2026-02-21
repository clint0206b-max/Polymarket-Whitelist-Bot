#!/usr/bin/env python3
"""Scrape Polymarket sports leaderboard and analyze all wallets."""
import json, re, time, sys, os
import urllib.request
from collections import defaultdict
from datetime import datetime

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

def fetch_page(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode()
    except Exception as e:
        print(f"  Error fetching {url}: {e}")
        return None

def extract_traders(html):
    match = re.search(r'__NEXT_DATA__.*?>(.*?)</script>', html)
    if not match:
        return []
    data = json.loads(match.group(1))
    queries = data.get('props',{}).get('pageProps',{}).get('dehydratedState',{}).get('queries',[])
    traders = []
    for q in queries:
        items = q.get('state',{}).get('data',[])
        if isinstance(items, list) and len(items) > 0 and ('rank' in items[0] or 'proxyWallet' in items[0]):
            traders.extend(items)
    return traders

def api_get(url, retries=2):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read())
        except:
            time.sleep(0.5)
    return None

# ============================================================
# PHASE 1: Scrape leaderboard pages
# ============================================================
print("=" * 60)
print("PHASE 1: Scraping Polymarket sports leaderboard")
print("=" * 60)

all_wallets = {}  # proxyWallet -> info

# Sports leaderboard, all time, profit-sorted
urls = [
    "https://polymarket.com/leaderboard/sports/all/profit",
    "https://polymarket.com/leaderboard/sports/monthly/profit",
    "https://polymarket.com/leaderboard/sports/weekly/profit",
    "https://polymarket.com/leaderboard/sports/all/volume",
    "https://polymarket.com/leaderboard/sports/monthly/volume",
]

for url in urls:
    print(f"\nFetching: {url}")
    html = fetch_page(url)
    if not html:
        continue
    traders = extract_traders(html)
    new = 0
    for t in traders:
        addr = t.get("proxyWallet", "")
        if addr and addr not in all_wallets:
            all_wallets[addr] = {
                "name": t.get("name", t.get("userName", "")),
                "pnl": float(t.get("pnl", 0)),
                "volume": float(t.get("volume", t.get("amount", 0))),
                "source": url.split("/")[-2] + "/" + url.split("/")[-1],
            }
            new += 1
    print(f"  Got {len(traders)} traders, {new} new. Total: {len(all_wallets)}")
    time.sleep(1)

print(f"\nTotal unique wallets from leaderboard: {len(all_wallets)}")

# ============================================================
# PHASE 2: Download trades for each wallet
# ============================================================
print("\n" + "=" * 60)
print(f"PHASE 2: Analyzing {len(all_wallets)} wallets")
print("=" * 60)

results = []

for idx, (addr, info) in enumerate(all_wallets.items()):
    if idx % 20 == 0:
        print(f"\n--- Progress: {idx}/{len(all_wallets)} ---")
    
    url = f"https://data-api.polymarket.com/trades?user={addr}&limit=1000"
    trades = api_get(url)
    
    if not trades or not isinstance(trades, list) or len(trades) == 0:
        results.append({
            "address": addr, "name": info["name"], "lb_pnl": info["pnl"],
            "lb_volume": info["volume"], "total_trades": 0, "error": "no_trades"
        })
        time.sleep(0.2)
        continue
    
    buys = [t for t in trades if t.get("side") == "BUY"]
    sells = [t for t in trades if t.get("side") == "SELL"]
    
    # Sport breakdown
    sport_map = {
        'cs2-':'cs2','lol-':'lol','dota2-':'dota2','val-':'val',
        'nba-':'nba','cbb-':'cbb','cwbb-':'cwbb','nhl-':'nhl',
        'nfl-':'nfl','mlb-':'mlb','ufc-':'ufc','epl-':'epl',
        'ucl-':'ucl','boxing-':'boxing','mma-':'mma','snhl-':'snhl',
    }
    sport_counts = defaultdict(int)
    for t in trades:
        slug = t.get("slug", "")
        matched = False
        for prefix, sport in sport_map.items():
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
    fav_pct = len([p for p in buy_prices if p >= 0.75]) / len(buy_prices) * 100 if buy_prices else 0
    
    # Trade sizes
    sizes = [float(t.get("size", 0)) * float(t.get("price", 0)) for t in trades]
    avg_size = sum(sizes) / len(sizes) if sizes else 0
    median_size = sorted(sizes)[len(sizes)//2] if sizes else 0
    
    # Hold-to-resolve
    positions = defaultdict(lambda: {"b": 0, "s": 0})
    for t in trades:
        slug = t.get("slug", "")
        if t.get("side") == "BUY": positions[slug]["b"] += 1
        else: positions[slug]["s"] += 1
    buy_only = sum(1 for p in positions.values() if p["b"] > 0 and p["s"] == 0)
    hold_pct = buy_only / len(positions) * 100 if positions else 0
    
    # Date range
    timestamps = [int(t.get("timestamp", 0)) for t in trades if t.get("timestamp")]
    days_active = 1
    tpd = len(trades)
    if timestamps:
        days_active = max((max(timestamps) - min(timestamps)) / 86400, 1)
        tpd = len(trades) / days_active
    
    # ROI
    vol = info["volume"] if info["volume"] > 0 else 1
    roi = info["pnl"] / vol if vol > 0 else 0
    
    # Score
    score = 0
    if len(trades) >= 50: score += 2
    elif len(trades) >= 20: score += 1
    if info["pnl"] > 0: score += 2
    if avg_size < 500: score += 2
    elif avg_size < 2000: score += 1
    if sports_pct > 50: score += 2
    elif sports_pct > 20: score += 1
    if hold_pct > 80: score += 2
    elif hold_pct > 50: score += 1
    if fav_pct > 50: score += 2
    elif fav_pct > 30: score += 1
    if tpd >= 3: score += 1
    if roi > 0.10: score += 3
    elif roi > 0.05: score += 2
    elif roi > 0.02: score += 1
    
    r = {
        "address": addr,
        "name": info["name"],
        "lb_pnl": round(info["pnl"], 0),
        "lb_volume": round(info["volume"], 0),
        "roi": round(roi, 4),
        "total_trades": len(trades),
        "buys": len(buys),
        "sells": len(sells),
        "avg_size": round(avg_size, 0),
        "median_size": round(median_size, 0),
        "avg_buy_price": round(avg_buy, 3),
        "fav_pct": round(fav_pct, 1),
        "unique_markets": len(slugs),
        "sports_pct": round(sports_pct, 1),
        "sport_breakdown": dict(sport_counts),
        "hold_pct": round(hold_pct, 1),
        "days_active": round(days_active, 0),
        "trades_per_day": round(tpd, 1),
        "score": score,
    }
    results.append(r)
    
    # Print interesting ones
    if score >= 10:
        name = (info["name"] or addr[:12])[:20]
        print(f"  ⭐ {name}: score={score} PnL=${info['pnl']:,.0f} ROI={roi:.1%} trades={len(trades)} avg=${avg_size:.0f} sports={sports_pct:.0f}% hold={hold_pct:.0f}% fav={fav_pct:.0f}%")
    
    time.sleep(0.3)

# ============================================================
# PHASE 3: Rank and output
# ============================================================
print("\n" + "=" * 60)
print("PHASE 3: Results")
print("=" * 60)

ranked = sorted(results, key=lambda x: (-x.get("score", 0), -x.get("lb_pnl", 0)))

# Filter active
active = [r for r in ranked if r.get("total_trades", 0) >= 10]

print(f"\nTotal analyzed: {len(results)}")
print(f"Active (10+ trades): {len(active)}")
print(f"Profitable: {len([r for r in active if r.get('lb_pnl',0) > 0])}")

print(f"\n{'#':>3} {'Name':>18} {'Score':>5} {'PnL':>12} {'ROI':>7} {'Trades':>6} {'Avg$':>7} {'Sport%':>7} {'Hold%':>6} {'Fav%':>5} {'T/d':>5}")
print("-" * 95)

for i, w in enumerate(active[:50]):
    name = (w.get("name", "") or w["address"][:12])[:18]
    print(f"{i+1:>3} {name:>18} {w.get('score',0):>5} ${w.get('lb_pnl',0):>10,.0f} {w.get('roi',0):>6.1%} {w.get('total_trades',0):>6} ${w.get('avg_size',0):>6,.0f} {w.get('sports_pct',0):>6.1f}% {w.get('hold_pct',0):>5.1f}% {w.get('fav_pct',0):>4.1f}% {w.get('trades_per_day',0):>5.1f}")

# Sport breakdown for top 15
print("\n\nSPORT BREAKDOWN - TOP 15:")
for i, w in enumerate(active[:15]):
    name = (w.get("name", "") or w["address"][:12])[:18]
    sports = w.get("sport_breakdown", {})
    sports_str = ", ".join(f"{k}:{v}" for k, v in sorted(sports.items(), key=lambda x: -x[1]) if k != "other")
    print(f"  {i+1}. {name}: {sports_str} | other:{sports.get('other',0)}")

# Save
out_file = os.path.join(OUT_DIR, "massive_scan_results.json")
with open(out_file, "w") as f:
    json.dump({
        "timestamp": datetime.now().isoformat(),
        "total_scanned": len(results),
        "active_10plus": len(active),
        "top_50": active[:50],
        "all": ranked
    }, f, indent=2)

print(f"\nSaved to {out_file}")
print("DONE!")
