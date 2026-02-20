#!/usr/bin/env python3
"""Scrape ESPN PBP — H1 + H2 + OT. First 221 games only."""
import urllib.request, json, sys, time

IN_FILE = "data/backtest/cbb/cbb_scores.jsonl"
OUT_FILE = "data/backtest/cbb/cbb_full_margins.jsonl"
BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary"
MAX_GAMES = 221

games = []
with open(IN_FILE) as f:
    for line in f:
        games.append(json.loads(line))
        if len(games) >= MAX_GAMES:
            break

print(f"Processing {len(games)} games", file=sys.stderr)
errors = 0
processed = 0

with open(OUT_FILE, "w") as out:
    for i, game in enumerate(games):
        event_id = game["event_id"]
        url = f"{BASE}?event={event_id}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            data = json.loads(urllib.request.urlopen(req, timeout=15).read())
            plays = data.get("plays", [])
            if not plays:
                errors += 1; continue
            
            header = data.get("header", {})
            comps = header.get("competitions", [{}])[0].get("competitors", [])
            home_team = away_team = "?"
            for c in comps:
                if c.get("homeAway") == "home":
                    home_team = c.get("team", {}).get("displayName", "?")
                else:
                    away_team = c.get("team", {}).get("displayName", "?")
            
            winner = game["team_a"]["name"] if game["final_margin_a"] > 0 else game["team_b"]["name"]
            
            snapshots = []
            for play in plays:
                period = play.get("period", {}).get("number", 0)
                clock_str = play.get("clock", {}).get("displayValue", "")
                home_score = play.get("homeScore", 0)
                away_score = play.get("awayScore", 0)
                try:
                    parts = clock_str.split(":")
                    minutes_left = int(parts[0]) + int(parts[1]) / 60
                except:
                    continue
                
                snapshots.append({
                    "period": period,
                    "minutes_left": round(minutes_left, 1),
                    "home_score": home_score,
                    "away_score": away_score,
                    "margin_home": home_score - away_score
                })
            
            if not snapshots:
                errors += 1; continue
            
            out.write(json.dumps({
                "event_id": event_id,
                "date": game["date"],
                "home_team": home_team,
                "away_team": away_team,
                "winner": winner,
                "went_to_ot": game["went_to_ot"],
                "final_margin_home": snapshots[-1]["margin_home"],
                "snapshots": snapshots
            }) + "\n")
            processed += 1
        except Exception as e:
            errors += 1
            if errors <= 3: print(f"  ERROR {event_id}: {e}", file=sys.stderr)
        
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(games)} ({processed} ok, {errors} err)", file=sys.stderr)
        time.sleep(0.2)

print(f"\nDone: {processed} ok, {errors} errors", file=sys.stderr)
