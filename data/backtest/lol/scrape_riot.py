#!/usr/bin/env python3
"""
Scrape LoL Challenger match timelines from Riot API.
Extracts gold difference timeseries per minute for win probability analysis.

Usage:
  python3 scrape_riot.py [--limit 500] [--platform na1] [--out lol_gold_timeseries.jsonl]

Flow:
  1. Get Challenger league → PUUIDs (already in response)
  2. Collect recent ranked match IDs (deduplicated)
  3. Fetch match + timeline for each → extract gold diff per frame
  4. Write JSONL

Rate limits: 20 req/s, 100 req/2min → 1.3s between requests
"""

import argparse
import json
import os
import sys
import time
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def load_api_key():
    key_file = os.path.expanduser("~/.openclaw/workspace/.secrets/riot-api-key.txt")
    if not os.path.exists(key_file):
        print(f"ERROR: API key not found: {key_file}", file=sys.stderr)
        sys.exit(1)
    with open(key_file) as f:
        for line in f:
            line = line.strip()
            if line.startswith("RGAPI-"):
                return line
    print("ERROR: No RGAPI key in file", file=sys.stderr)
    sys.exit(1)

def api_get(url, api_key, retries=3):
    """Make Riot API GET via curl (avoids urllib SSL issues)."""
    for attempt in range(retries):
        try:
            result = subprocess.run(
                ["curl", "-s", "-w", "\n%{http_code}", url,
                 "-H", f"X-Riot-Token: {api_key}"],
                capture_output=True, text=True, timeout=20
            )
            lines = result.stdout.strip().rsplit("\n", 1)
            if len(lines) < 2:
                continue
            body, code_str = lines
            code = int(code_str)
            
            if code == 200:
                return json.loads(body)
            elif code == 429:
                retry_after = 5
                print(f"  Rate limited, waiting {retry_after}s...", file=sys.stderr, flush=True)
                time.sleep(retry_after + 1)
                continue
            elif code == 404:
                return None
            else:
                print(f"  HTTP {code} attempt {attempt+1}: {url[:80]}...", file=sys.stderr, flush=True)
                if attempt < retries - 1:
                    time.sleep(2)
                continue
        except Exception as e:
            print(f"  Error attempt {attempt+1}: {e}", file=sys.stderr, flush=True)
            if attempt < retries - 1:
                time.sleep(2)
    return None

def get_challenger_puuids(api_key, platform="na1", count=20):
    """Get PUUIDs from Challenger league (included in response)."""
    print(f"Fetching Challenger league from {platform}...", flush=True)
    url = f"https://{platform}.api.riotgames.com/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5"
    data = api_get(url, api_key)
    if not data or "entries" not in data:
        print("ERROR: Failed to fetch Challenger league", file=sys.stderr)
        return []
    
    entries = sorted(data["entries"], key=lambda x: x.get("leaguePoints", 0), reverse=True)
    puuids = [e["puuid"] for e in entries if "puuid" in e][:count]
    print(f"  Got {len(puuids)} Challenger PUUIDs (top by LP)", flush=True)
    return puuids

def get_match_ids(api_key, puuids, routing="americas", matches_per_player=30, target=500):
    """Collect unique ranked match IDs."""
    print(f"\nCollecting match IDs (target: {target})...", flush=True)
    match_ids = set()
    
    for i, puuid in enumerate(puuids):
        if len(match_ids) >= target * 1.2:  # Collect extra for dedup headroom
            break
        
        url = (f"https://{routing}.api.riotgames.com/lol/match/v5/matches/by-puuid/"
               f"{puuid}/ids?type=ranked&count={matches_per_player}")
        time.sleep(1.3)
        data = api_get(url, api_key)
        if data:
            before = len(match_ids)
            match_ids.update(data)
            new = len(match_ids) - before
            print(f"  [{i+1}/{len(puuids)}] +{new} new (total: {len(match_ids)})", flush=True)
    
    result = list(match_ids)[:target]
    print(f"  Collected {len(result)} unique match IDs", flush=True)
    return result

def extract_gold_diff(timeline_data, match_data):
    """Extract gold diff per minute from timeline frames."""
    if not timeline_data or "info" not in timeline_data:
        return None
    
    frames = timeline_data["info"].get("frames", [])
    if len(frames) < 5:
        return None
    
    gold_diffs = []
    xp_diffs = []
    
    for frame in frames:
        pframes = frame.get("participantFrames", {})
        bg, rg, bx, rx = 0, 0, 0, 0
        for pid_str, pf in pframes.items():
            pid = int(pid_str)
            g = pf.get("totalGold", 0)
            x = pf.get("xp", 0)
            if pid <= 5:
                bg += g; bx += x
            else:
                rg += g; rx += x
        gold_diffs.append(bg - rg)
        xp_diffs.append(bx - rx)
    
    blue_win = None
    if match_data and "info" in match_data:
        for team in match_data["info"].get("teams", []):
            if team.get("teamId") == 100:
                blue_win = team.get("win", False)
                break
    
    duration = match_data["info"].get("gameDuration", 0) if match_data else 0
    
    return {
        "match_id": match_data["metadata"]["matchId"] if match_data else None,
        "game_duration_min": round(duration / 60, 1),
        "blue_win": blue_win,
        "gold_diff": gold_diffs,
        "xp_diff": xp_diffs,
        "num_frames": len(frames),
        "patch": match_data["info"].get("gameVersion", "") if match_data else "",
    }

def scrape(limit=500, platform="na1", routing="americas", out_file=None):
    api_key = load_api_key()
    if out_file is None:
        out_file = os.path.join(SCRIPT_DIR, "lol_gold_timeseries.jsonl")
    
    # Check existing
    existing_ids = set()
    if os.path.exists(out_file):
        with open(out_file) as f:
            for line in f:
                try:
                    d = json.loads(line)
                    if d.get("match_id"):
                        existing_ids.add(d["match_id"])
                except:
                    pass
        if existing_ids:
            print(f"Found {len(existing_ids)} existing matches", flush=True)
    
    # Step 1: Get PUUIDs
    num_players = min(50, max(10, limit // 10))
    puuids = get_challenger_puuids(api_key, platform, count=num_players)
    if not puuids:
        return
    
    # Step 2: Collect match IDs
    mpp = min(50, max(20, limit // len(puuids) + 5))
    match_ids = get_match_ids(api_key, puuids, routing, mpp, target=limit + len(existing_ids))
    
    # Filter already scraped
    match_ids = [m for m in match_ids if m not in existing_ids]
    remaining = limit - len(existing_ids)
    if remaining <= 0:
        print("Already have enough matches!", flush=True)
        return
    match_ids = match_ids[:remaining]
    
    print(f"\nScraping {len(match_ids)} match timelines...", flush=True)
    
    # Step 3: Fetch match + timeline (2 requests per match, 1.3s each)
    ok = 0
    err = 0
    
    with open(out_file, "a") as f:
        for i, mid in enumerate(match_ids):
            # Match detail
            url_m = f"https://{routing}.api.riotgames.com/lol/match/v5/matches/{mid}"
            time.sleep(1.3)
            match_data = api_get(url_m, api_key)
            if not match_data:
                err += 1
                print(f"  [{i+1}/{len(match_ids)}] {mid} → match FAIL", flush=True)
                continue
            
            # Timeline
            url_t = f"https://{routing}.api.riotgames.com/lol/match/v5/matches/{mid}/timeline"
            time.sleep(1.3)
            timeline = api_get(url_t, api_key)
            if not timeline:
                err += 1
                print(f"  [{i+1}/{len(match_ids)}] {mid} → timeline FAIL", flush=True)
                continue
            
            result = extract_gold_diff(timeline, match_data)
            if result:
                f.write(json.dumps(result) + "\n")
                f.flush()
                ok += 1
                total = ok + len(existing_ids)
                win_side = "blue" if result["blue_win"] else "red"
                gd = result["gold_diff"][-1]
                print(f"  [{i+1}/{len(match_ids)}] {result['game_duration_min']}min "
                      f"{win_side} win, final gold: {gd:+d} ({total} total)", flush=True)
            else:
                err += 1
                print(f"  [{i+1}/{len(match_ids)}] {mid} → too short", flush=True)
    
    print(f"\nDone! {ok} ok, {err} errors. Total: {ok + len(existing_ids)}", flush=True)

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=500)
    p.add_argument("--platform", default="na1")
    p.add_argument("--routing", default="americas")
    p.add_argument("--out", default=None)
    args = p.parse_args()
    scrape(limit=args.limit, platform=args.platform, routing=args.routing, out_file=args.out)
