#!/usr/bin/env python3
"""Fast: get sports leaderboard from analytics API, enrich only top candidates."""
import json, time, sys, os
import urllib.request
from collections import defaultdict

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

def api_post(url, body):
    try:
        data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, headers={
            "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"  ERR: {e}", flush=True)
        return None

def api_get(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except:
        return None

API = "https://polymarketanalytics.com/api/traders-tag-performance"
sport_map = {'cs2-':'cs2','lol-':'lol','dota2-':'dota2','val-':'val',
    'nba-':'nba','cbb-':'cbb','cwbb-':'cwbb','nhl-':'nhl',
    'nfl-':'nfl','mlb-':'mlb','ufc-':'ufc','epl-':'epl','ucl-':'ucl'}

# PHASE 1: Download leaderboard (fast - no trade enrichment)
print("PHASE 1: Downloading sports leaderboard...", flush=True)
all_traders = []
for offset in range(0, 2000, 50):
    r = api_post(API, {"getGlobalRange":False,"tag":"Sports","limit":50,"offset":offset,
                        "sortBy":"winRate","sortOrder":"desc","minTotalPositions":20})
    if not r or not r.get('data'): break
    all_traders.extend(r['data'])
    print(f"  {len(all_traders)} traders...", flush=True)
    time.sleep(0.3)

print(f"\nTotal: {len(all_traders)} traders with 20+ sports positions", flush=True)

# PHASE 2: Filter interesting candidates (from API data alone)
print("\nPHASE 2: Filtering...", flush=True)

# Sort by WR
all_traders.sort(key=lambda x: -x.get("win_rate", 0))

# Show full WR leaderboard from API data
print(f"\n{'#':>3} {'Name':>22} {'WR':>5} {'Wins':>5} {'Loss':>5} {'Pos':>5} {'PnL':>12} {'Active':>6}", flush=True)
print("-" * 80, flush=True)
for i, t in enumerate(all_traders[:80]):
    name = (t.get("trader_name","") or t["trader"][:12])[:22]
    wr = t.get("win_rate",0)*100
    wins = t.get("win_count",0)
    total = t.get("total_positions",0)
    losses = total - wins
    pnl = t.get("overall_gain",0)
    active = t.get("active_positions",0)
    print(f"{i+1:>3} {name:>22} {wr:>4.0f}% {wins:>5} {losses:>5} {total:>5} ${pnl:>10,.0f} {active:>6}", flush=True)

# PHASE 3: Enrich TOP 50 with trade data
print("\n\nPHASE 3: Enriching top 50 with trade-level data...", flush=True)

# Pick top 50 by WR with at least 50 positions
candidates = [t for t in all_traders if t.get("total_positions",0) >= 50][:50]

results = []
for i, t in enumerate(candidates):
    addr = t["trader"]
    name = (t.get("trader_name","") or addr[:12])[:22]
    
    trades = api_get(f"https://data-api.polymarket.com/trades?user={addr}&limit=2000")
    
    sc = defaultdict(int)
    avg_buy = fav_pct = avg_size = hold_pct = esports_pct = 0
    n_trades = 0
    
    if trades and isinstance(trades, list) and trades:
        n_trades = len(trades)
        buys = [x for x in trades if x.get("side") == "BUY"]
        for x in trades:
            slug = x.get("slug","")
            matched = False
            for pfx, sp in sport_map.items():
                if slug.startswith(pfx): sc[sp] += 1; matched = True; break
            if not matched: sc["other"] += 1
        
        bp = [float(x.get("price",0)) for x in buys if float(x.get("price",0)) > 0]
        avg_buy = sum(bp)/len(bp) if bp else 0
        fav_pct = len([p for p in bp if p >= 0.70])/len(bp)*100 if bp else 0
        sizes = [float(x.get("size",0))*float(x.get("price",0)) for x in trades]
        avg_size = sum(sizes)/len(sizes) if sizes else 0
        
        pos = defaultdict(lambda:{"b":0,"s":0})
        for x in trades:
            sl = x.get("slug","")
            if x.get("side")=="BUY": pos[sl]["b"]+=1
            else: pos[sl]["s"]+=1
        buy_only = sum(1 for p in pos.values() if p["b"]>0 and p["s"]==0)
        hold_pct = buy_only/len(pos)*100 if pos else 0
        
        esp = sum(sc.get(s,0) for s in ["cs2","lol","dota2","val"])
        esports_pct = esp/n_trades*100 if n_trades else 0
    
    wr = t.get("win_rate",0)*100
    wins = t.get("win_count",0)
    total_pos = t.get("total_positions",0)
    losses = total_pos - wins
    pnl = t.get("overall_gain",0)
    
    top_sp = sorted([(k,v) for k,v in sc.items() if k != "other"], key=lambda x:-x[1])[:4]
    sp_str = ", ".join(f"{k}:{v}" for k,v in top_sp)
    
    flag = ""
    if esports_pct > 30: flag += " 🎮"
    if fav_pct > 50: flag += " ⭐"
    
    print(f"  {i+1:>2}. {name}: WR={wr:.0f}% ({wins}W/{losses}L) PnL=${pnl:,.0f} avg_buy={avg_buy:.2f} avg$={avg_size:.0f} fav={fav_pct:.0f}% hold={hold_pct:.0f}% esports={esports_pct:.0f}%{flag}", flush=True)
    if sp_str:
        print(f"      Sports: {sp_str}", flush=True)
    
    results.append({
        "address": addr, "name": name,
        "win_rate": round(wr,1), "wins": wins, "losses": losses,
        "total_positions": total_pos, "pnl": round(pnl,0),
        "total_trades": n_trades, "avg_buy_price": round(avg_buy,3),
        "fav_pct": round(fav_pct,1), "avg_size": round(avg_size,0),
        "hold_pct": round(hold_pct,1), "esports_pct": round(esports_pct,1),
        "sport_breakdown": dict(sc), "tags": t.get("trader_tags",""),
    })
    time.sleep(0.3)

# Save
out = os.path.join(OUT_DIR, "analytics_full_results.json")
with open(out, "w") as f:
    json.dump({"total_leaderboard": len(all_traders), "enriched_top50": results,
               "raw_leaderboard": [{"trader":t["trader"],"name":t.get("trader_name",""),
                   "wr":round(t.get("win_rate",0)*100,1),"wins":t.get("win_count",0),
                   "positions":t.get("total_positions",0),"pnl":round(t.get("overall_gain",0),0)}
                   for t in all_traders]}, f, indent=2)
print(f"\nSaved to {out}", flush=True)
print("DONE!", flush=True)
