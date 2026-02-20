#!/usr/bin/env python3
"""Scrape OpenDota pro matches with gold/xp timeseries. Fast & resumable."""
import urllib.request, json, sys, time, os

OUT_DIR = "data/backtest/dota2"
OUT_FILE = os.path.join(OUT_DIR, "dota2_gold_timeseries.jsonl")
os.makedirs(OUT_DIR, exist_ok=True)

BASE = "https://api.opendota.com/api"
TARGET = 500
BATCH = 100

# Load already fetched match IDs
existing_ids = set()
if os.path.exists(OUT_FILE):
    with open(OUT_FILE) as f:
        for line in f:
            try:
                rec = json.loads(line.strip())
                existing_ids.add(rec["match_id"])
            except:
                pass
    print(f"Found {len(existing_ids)} existing records", file=sys.stderr)

# Step 1: Get pro match IDs
print(f"Fetching {TARGET} pro match IDs...", file=sys.stderr)
match_ids = []
less_than_id = None

while len(match_ids) < TARGET:
    url = f"{BASE}/proMatches?limit={BATCH}"
    if less_than_id:
        url += f"&less_than_match_id={less_than_id}"
    
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            data = json.loads(urllib.request.urlopen(req, timeout=20).read())
            break
        except Exception as e:
            print(f"  Retry {attempt+1}/3 for proMatches: {e}", file=sys.stderr)
            time.sleep(2)
    else:
        print("Failed to fetch proMatches batch, stopping", file=sys.stderr)
        break
    
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
    print(f"  Got {len(match_ids)} match IDs...", file=sys.stderr)
    time.sleep(0.5)

match_ids = match_ids[:TARGET]
print(f"Got {len(match_ids)} match IDs total", file=sys.stderr)

# Filter out already fetched
to_fetch = [m for m in match_ids if m["match_id"] not in existing_ids]
print(f"Need to fetch {len(to_fetch)} new matches (skipping {len(match_ids)-len(to_fetch)} existing)", file=sys.stderr)

# Step 2: Fetch match details — append mode
processed = 0
errors = 0
skipped_no_gold = 0

with open(OUT_FILE, "a") as out:
    for i, m in enumerate(to_fetch):
        mid = m["match_id"]
        url = f"{BASE}/matches/{mid}"
        
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                resp = urllib.request.urlopen(req, timeout=30)
                data = json.loads(resp.read())
                
                gold_adv = data.get("radiant_gold_adv", [])
                xp_adv = data.get("radiant_xp_adv", [])
                
                if not gold_adv:
                    skipped_no_gold += 1
                
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
                    "gold_adv": gold_adv,
                    "xp_adv": xp_adv,
                    "has_timeseries": len(gold_adv) > 0,
                }
                
                out.write(json.dumps(record) + "\n")
                out.flush()
                processed += 1
                break
                
            except Exception as e:
                if attempt < 2:
                    time.sleep(3)
                else:
                    errors += 1
                    print(f"  FAIL {mid}: {e}", file=sys.stderr)
        
        if (i + 1) % 25 == 0:
            print(f"  {i+1}/{len(to_fetch)} ({processed} ok, {errors} err, {skipped_no_gold} no gold)", file=sys.stderr, flush=True)
        
        # OpenDota free tier: 60/min. Use 1.05s delay.
        time.sleep(1.05)

total = len(existing_ids) + processed
print(f"\nDone: {total} total ({processed} new, {errors} errors, {skipped_no_gold} without gold)", file=sys.stderr)
