#!/usr/bin/env python3
"""Look up wallet addresses by username and analyze trades."""
import json, time, sys, os
import urllib.request
from collections import defaultdict

names = [
    "MAGA.ONE", "kfkNBApro1", "-JB-", "PrinceAndrew69", "Sharky6999",
    "getrichortrying", "pelik", "praktor", "noreasapa", "T1Fakerrr",
    "anon-fake", "0x0770", "EveryMoleIsMagic", "Rock.San", "ulullu",
    "LlamaEnjoyer", "rwo", "crzu", "STAYCALM", ".kutar", "MiLive",
    "AgricultureSecretary", "nonkenny90", "professorx", "okalright", "ewww1",
]

def api_get(url, retries=2):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read())
        except Exception as e:
            if attempt == retries - 1:
                return None
            time.sleep(0.5)

def fetch_html(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read().decode()
    except:
        return None

import re

def get_address_from_profile(name):
    """Try to get wallet address from polymarket profile page."""
    url = f"https://polymarket.com/profile/{name}"
    html = fetch_html(url)
    if not html:
        return None
    # Look for proxy wallet in __NEXT_DATA__
    match = re.search(r'__NEXT_DATA__.*?>(.*?)</script>', html)
    if match:
        try:
            data = json.loads(match.group(1))
            # Navigate the data to find wallet
            pp = data.get('props', {}).get('pageProps', {})
            queries = pp.get('dehydratedState', {}).get('queries', [])
            for q in queries:
                d = q.get('state', {}).get('data', {})
                if isinstance(d, dict):
                    addr = d.get('proxyWallet', '') or d.get('address', '')
                    if addr and addr.startswith('0x'):
                        return addr
            # Try other patterns
            page_str = json.dumps(data)
            addrs = re.findall(r'"proxyWallet"\s*:\s*"(0x[a-fA-F0-9]{40})"', page_str)
            if addrs:
                return addrs[0]
        except:
            pass
    # Fallback: look for 0x address in HTML
    addrs = re.findall(r'0x[a-fA-F0-9]{40}', html)
    if addrs:
        return addrs[0]
    return None

sport_map = {
    'cs2-':'cs2','lol-':'lol','dota2-':'dota2','val-':'val',
    'nba-':'nba','cbb-':'cbb','cwbb-':'cwbb','nhl-':'nhl',
    'nfl-':'nfl','mlb-':'mlb','ufc-':'ufc','epl-':'epl',
    'ucl-':'ucl','boxing-':'boxing','mma-':'mma',
}

def analyze_wallet(addr, name):
    # Get trades
    url = f"https://data-api.polymarket.com/trades?user={addr}&limit=5000"
    trades = api_get(url)
    if not trades or not isinstance(trades, list):
        return {"name": name, "address": addr, "error": "no_trades"}
    
    buys = [t for t in trades if t.get("side") == "BUY"]
    sells = [t for t in trades if t.get("side") == "SELL"]
    
    # Sport breakdown
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
    
    # Buy prices
    buy_prices = [float(t.get("price", 0)) for t in buys if float(t.get("price", 0)) > 0]
    avg_buy = sum(buy_prices) / len(buy_prices) if buy_prices else 0
    fav_pct = len([p for p in buy_prices if p >= 0.70]) / len(buy_prices) * 100 if buy_prices else 0
    
    # Trade sizes
    sizes = [float(t.get("size", 0)) * float(t.get("price", 0)) for t in trades]
    avg_size = sum(sizes) / len(sizes) if sizes else 0
    
    # Hold-to-resolve
    positions = defaultdict(lambda: {"b": 0, "s": 0})
    for t in trades:
        slug = t.get("slug", "")
        if t.get("side") == "BUY": positions[slug]["b"] += 1
        else: positions[slug]["s"] += 1
    buy_only = sum(1 for p in positions.values() if p["b"] > 0 and p["s"] == 0)
    hold_pct = buy_only / len(positions) * 100 if positions else 0
    
    # Get closed positions for WR
    cp_url = f"https://data-api.polymarket.com/closed-positions?user={addr}&limit=5000"
    closed = api_get(cp_url)
    wins = losses = 0
    if closed and isinstance(closed, list):
        for p in closed:
            pnl = float(p.get("realizedPnl", 0))
            if pnl > 0: wins += 1
            elif pnl < 0: losses += 1
    
    wr = wins / (wins + losses) * 100 if (wins + losses) > 0 else 0
    
    return {
        "name": name,
        "address": addr,
        "total_trades": len(trades),
        "buys": len(buys),
        "sells": len(sells),
        "unique_markets": len(positions),
        "avg_buy_price": round(avg_buy, 3),
        "fav_pct": round(fav_pct, 1),
        "avg_size": round(avg_size, 0),
        "sports_pct": round(sports_pct, 1),
        "sport_breakdown": dict(sport_counts),
        "hold_pct": round(hold_pct, 1),
        "closed_positions": wins + losses,
        "wins": wins,
        "losses": losses,
        "win_rate": round(wr, 1),
    }

# =====================
# MAIN
# =====================
print(f"Looking up {len(names)} wallets...")
print()

results = []
for i, name in enumerate(names):
    sys.stdout.write(f"[{i+1}/{len(names)}] {name}... ")
    sys.stdout.flush()
    
    addr = get_address_from_profile(name)
    if not addr:
        print(f"NOT FOUND")
        results.append({"name": name, "error": "address_not_found"})
        time.sleep(0.3)
        continue
    
    print(f"addr={addr[:10]}...")
    r = analyze_wallet(addr, name)
    results.append(r)
    
    if "error" not in r:
        wr_str = f"WR={r['win_rate']:.0f}% ({r['wins']}W/{r['losses']}L)" if r['closed_positions'] > 0 else "WR=?"
        sports = r.get('sport_breakdown', {})
        top_sports = sorted([(k,v) for k,v in sports.items() if k != 'other'], key=lambda x: -x[1])[:3]
        sports_str = ", ".join(f"{k}:{v}" for k,v in top_sports)
        print(f"    trades={r['total_trades']} avg_buy={r['avg_buy_price']:.2f} avg$={r['avg_size']:.0f} sports={r['sports_pct']:.0f}% hold={r['hold_pct']:.0f}% fav={r['fav_pct']:.0f}% {wr_str}")
        print(f"    sports: {sports_str}")
    
    time.sleep(0.5)

# Summary table
print()
print(f"{'#':>2} {'Name':>22} {'Trades':>6} {'AvgBuy':>7} {'Avg$':>8} {'Sport%':>7} {'Hold%':>6} {'Fav%':>5} {'WR':>6} {'W/L':>10}")
print("-" * 100)

# Sort by WR desc, then by trades desc
valid = [r for r in results if "error" not in r and r.get("closed_positions", 0) > 5]
valid.sort(key=lambda x: (-x.get("win_rate", 0), -x.get("total_trades", 0)))

for i, w in enumerate(valid):
    name = w["name"][:22]
    wr = f"{w['win_rate']:.0f}%" if w.get('closed_positions', 0) > 0 else "?"
    wl = f"{w.get('wins',0)}W/{w.get('losses',0)}L"
    print(f"{i+1:>2} {name:>22} {w['total_trades']:>6} {w['avg_buy_price']:>7.3f} ${w['avg_size']:>7,.0f} {w['sports_pct']:>6.1f}% {w['hold_pct']:>5.1f}% {w['fav_pct']:>4.1f}% {wr:>5} {wl:>10}")

# Highlight esports wallets
print("\n\nESPORTS WALLETS (>30% esports):")
for w in valid:
    sports = w.get("sport_breakdown", {})
    esports = sum(sports.get(s, 0) for s in ["cs2", "lol", "dota2", "val"])
    esports_pct = esports / w["total_trades"] * 100 if w["total_trades"] > 0 else 0
    if esports_pct > 30:
        name = w["name"][:22]
        wr = f"{w['win_rate']:.0f}%"
        top_sp = sorted([(k,v) for k,v in sports.items() if k != 'other'], key=lambda x: -x[1])[:4]
        sp_str = ", ".join(f"{k}:{v}" for k,v in top_sp)
        print(f"  {name}: WR={wr} trades={w['total_trades']} avg$={w['avg_size']:.0f} fav={w['fav_pct']:.0f}% | {sp_str}")

# Favorites buyers (>50% buys at 0.70+)
print("\nFAVORITES BUYERS (>50% buys ≥0.70):")
for w in valid:
    if w.get("fav_pct", 0) >= 50:
        name = w["name"][:22]
        wr = f"{w['win_rate']:.0f}%"
        sports = w.get("sport_breakdown", {})
        top_sp = sorted([(k,v) for k,v in sports.items() if k != 'other'], key=lambda x: -x[1])[:4]
        sp_str = ", ".join(f"{k}:{v}" for k,v in top_sp)
        print(f"  {name}: WR={wr} trades={w['total_trades']} avg_buy={w['avg_buy_price']:.2f} avg$={w['avg_size']:.0f} sports={w['sports_pct']:.0f}% | {sp_str}")

# Save
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "analytics_wallets.json")
with open(out, "w") as f:
    json.dump(results, f, indent=2)
print(f"\nSaved to {out}")
