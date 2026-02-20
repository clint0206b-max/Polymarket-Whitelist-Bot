#!/usr/bin/env python3
"""
Scrape ESPN CBB completed games with halftime & final scores.
Output: cbb_scores.jsonl — one line per completed game.
"""
import urllib.request, json, sys, time
from datetime import datetime, timedelta

OUT = "data/backtest/cbb/cbb_scores.jsonl"
BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard"

# Scrape from Nov 1 2025 through Feb 19 2026 (full CBB season)
start = datetime(2025, 11, 1)
end = datetime(2026, 2, 19)

total_games = 0
total_days = 0
errors = 0

with open(OUT, "w") as f:
    d = start
    while d <= end:
        date_str = d.strftime("%Y%m%d")
        url = f"{BASE}?dates={date_str}&limit=200"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            resp = urllib.request.urlopen(req, timeout=15)
            data = json.loads(resp.read())
            
            day_count = 0
            for ev in data.get("events", []):
                comp = ev.get("competitions", [{}])[0]
                status = comp.get("status", {})
                state = status.get("type", {}).get("state", "")
                
                # Only completed games
                if state != "post":
                    continue
                
                competitors = comp.get("competitors", [])
                if len(competitors) != 2:
                    continue
                
                teams = []
                for c in competitors:
                    linescores = c.get("linescores", [])
                    h1 = None
                    h2 = None
                    for ls in linescores:
                        p = ls.get("period", 0)
                        if p == 1:
                            h1 = int(ls.get("value", 0))
                        elif p == 2:
                            h2 = int(ls.get("value", 0))
                    
                    total_score = int(c.get("score", 0))
                    ot_points = total_score - (h1 or 0) - (h2 or 0) if h1 is not None and h2 is not None else None
                    
                    teams.append({
                        "name": c.get("team", {}).get("displayName", "?"),
                        "short": c.get("team", {}).get("shortDisplayName", "?"),
                        "home_away": c.get("homeAway", "?"),
                        "winner": c.get("winner", False),
                        "total": total_score,
                        "h1": h1,
                        "h2": h2,
                        "ot_points": ot_points if ot_points and ot_points > 0 else 0
                    })
                
                # Skip if missing halftime data
                if teams[0]["h1"] is None or teams[1]["h1"] is None:
                    continue
                
                periods = status.get("period", 2)
                
                record = {
                    "date": date_str,
                    "event_id": ev.get("id"),
                    "team_a": teams[0],
                    "team_b": teams[1],
                    "periods": periods,
                    "went_to_ot": periods > 2,
                    "h1_margin_a": teams[0]["h1"] - teams[1]["h1"],
                    "h2_start_margin_a": teams[0]["h1"] - teams[1]["h1"],  # same as h1_margin
                    "final_margin_a": teams[0]["total"] - teams[1]["total"],
                }
                
                f.write(json.dumps(record) + "\n")
                day_count += 1
            
            total_games += day_count
            total_days += 1
            if total_days % 10 == 0:
                print(f"  {date_str}: {day_count} games (total: {total_games})", file=sys.stderr)
                
        except Exception as e:
            errors += 1
            print(f"  ERROR {date_str}: {e}", file=sys.stderr)
        
        d += timedelta(days=1)
        time.sleep(0.3)  # Rate limit

print(f"\nDone: {total_games} games over {total_days} days, {errors} errors", file=sys.stderr)
print(f"Output: {OUT}", file=sys.stderr)
