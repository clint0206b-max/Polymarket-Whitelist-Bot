#!/usr/bin/env python3
"""
Scrape ESPN play-by-play for CBB games.
Extract margin snapshots at each minute of H2.
Output: cbb_h2_margins.jsonl
"""
import urllib.request, json, sys, time

IN_FILE = "data/backtest/cbb/cbb_scores.jsonl"
OUT_FILE = "data/backtest/cbb/cbb_h2_margins.jsonl"
BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary"

games = []
with open(IN_FILE) as f:
    for line in f:
        games.append(json.loads(line))

print(f"Total games to process: {len(games)}", file=sys.stderr)

errors = 0
processed = 0

with open(OUT_FILE, "w") as out:
    for i, game in enumerate(games):
        event_id = game["event_id"]
        url = f"{BASE}?event={event_id}"
        
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            resp = urllib.request.urlopen(req, timeout=15)
            data = json.loads(resp.read())
            
            plays = data.get("plays", [])
            if not plays:
                errors += 1
                continue
            
            # Figure out who is home and who is away
            # header has the teams
            header = data.get("header", {})
            comps = header.get("competitions", [{}])[0].get("competitors", [])
            
            home_team = None
            away_team = None
            for c in comps:
                if c.get("homeAway") == "home":
                    home_team = c.get("team", {}).get("displayName", "?")
                else:
                    away_team = c.get("team", {}).get("displayName", "?")
            
            # Determine winner from original data
            winner = game["team_a"]["name"] if game["final_margin_a"] > 0 else game["team_b"]["name"]
            
            # Extract margin snapshots at each clock reading in H2
            # H2 in CBB = period 2, clock goes from 20:00 to 0:00
            h2_snapshots = []
            
            for play in plays:
                period = play.get("period", {}).get("number", 0)
                if period < 2:
                    continue  # skip H1
                
                clock_str = play.get("clock", {}).get("displayValue", "")
                home_score = play.get("homeScore", 0)
                away_score = play.get("awayScore", 0)
                
                # Parse clock: "MM:SS" → minutes remaining
                try:
                    parts = clock_str.split(":")
                    minutes_left = int(parts[0]) + int(parts[1]) / 60
                except:
                    continue
                
                margin_home = home_score - away_score
                
                h2_snapshots.append({
                    "period": period,
                    "minutes_left": round(minutes_left, 1),
                    "home_score": home_score,
                    "away_score": away_score,
                    "margin_home": margin_home
                })
            
            if not h2_snapshots:
                errors += 1
                continue
            
            record = {
                "event_id": event_id,
                "date": game["date"],
                "home_team": home_team,
                "away_team": away_team,
                "winner": winner,
                "went_to_ot": game["went_to_ot"],
                "final_margin_home": h2_snapshots[-1]["margin_home"],
                "snapshots": h2_snapshots
            }
            
            out.write(json.dumps(record) + "\n")
            processed += 1
            
        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"  ERROR {event_id}: {e}", file=sys.stderr)
        
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(games)} processed ({processed} ok, {errors} errors)", file=sys.stderr)
        
        time.sleep(0.25)

print(f"\nDone: {processed} games processed, {errors} errors", file=sys.stderr)
print(f"Output: {OUT_FILE}", file=sys.stderr)
