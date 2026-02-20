#!/usr/bin/env python3
"""Scrape OpenDota pro matches with gold/xp timeseries. 500 matches."""
import urllib.request, json, sys, time, os

OUT_DIR = "data/backtest/dota2"
OUT_FILE = os.path.join(OUT_DIR, "dota2_gold_timeseries.jsonl")
os.makedirs(OUT_DIR, exist_ok=True)

BASE = "https://api.opendota.com/api"
TARGET = 500
BATCH = 100  # proMatches returns up to 100

# Step 1: Get pro match IDs in batches
print(f"Fetching {TARGET} pro match IDs...", file=sys.stderr)
match_ids = []
less_than_id = None

while len(match_ids) < TARGET:
    url = f"{BASE}/proMatches?limit={BATCH}"
    if less_than_id:
        url += f"&less_than_match_id={less_than_id}"
    
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    data = json.loads(urllib.request.urlopen(req, timeout=15).read())
    
    if not data:
        break
    
    for m in data:
        match_ids.append({
            "match_id": m["match_id"],
            "radiant_name": m.get("radiant_name", "?"),
            "dire_name": m.get("dire_name", "?"),
            "radiant_win": m.get("radiant_win"),
            "radiant_score": m.get("radiant_score", 0),
            "dire_score": m.get("dire_score", 0),
            "duration": m.get("duration", 0),
            "league_name": m.get("league_name", "?"),
        })
    
    less_than_id = data[-1]["match_id"]
    print(f"  Got {len(match_ids)} match IDs so far...", file=sys.stderr)
    time.sleep(1)

match_ids = match_ids[:TARGET]
print(f"Got {len(match_ids)} match IDs", file=sys.stderr)

# Step 2: Fetch detailed data for each match (gold/xp timeseries)
print(f"\nFetching match details...", file=sys.stderr)
processed = 0
errors = 0
skipped_no_gold = 0

with open(OUT_FILE, "w") as out:
    for i, m in enumerate(match_ids):
        mid = m["match_id"]
        url = f"{BASE}/matches/{mid}"
        
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            data = json.loads(urllib.request.urlopen(req, timeout=15).read())
            
            gold_adv = data.get("radiant_gold_adv", [])
            xp_adv = data.get("radiant_xp_adv", [])
            
            if not gold_adv:
                skipped_no_gold += 1
                # Still write it but mark as no timeseries
            
            record = {
                "match_id": mid,
                "radiant_name": m["radiant_name"],
                "dire_name": m["dire_name"],
                "radiant_win": m["radiant_win"],
                "radiant_score": m["radiant_score"],
                "dire_score": m["dire_score"],
                "duration_sec": data.get("duration", m["duration"]),
                "duration_min": data.get("duration", 0) // 60,
                "league_name": m["league_name"],
                "gold_adv": gold_adv,  # radiant perspective, per minute
                "xp_adv": xp_adv,
                "has_timeseries": len(gold_adv) > 0,
            }
            
            out.write(json.dumps(record) + "\n")
            processed += 1
            
        except Exception as e:
            errors += 1
            if errors <= 3:
                print(f"  ERROR {mid}: {e}", file=sys.stderr)
        
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(match_ids)} ({processed} ok, {errors} err, {skipped_no_gold} no gold)", file=sys.stderr)
        
        # Rate limit: 60 req/min = 1 per second
        time.sleep(1.1)

print(f"\nDone: {processed} ok, {errors} errors, {skipped_no_gold} without gold timeseries", file=sys.stderr)
