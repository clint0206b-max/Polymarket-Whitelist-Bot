#!/usr/bin/env python3
"""
Parse OddsPortal browser snapshot and extract match data
Works directly with the exact snapshot format
"""

import json
import re
import sys
from pathlib import Path

def parse_team_name(text):
    """Team names appear duplicated, e.g., 'Dplus Kia Dplus Kia' -> 'Dplus Kia'"""
    text = text.strip()
    parts = text.split()
    mid = len(parts) // 2
    if mid > 0:
        first_half = ' '.join(parts[:mid])
        second_half = ' '.join(parts[mid:])
        if first_half == second_half:
            return first_half
    return text

def extract_matches(snapshot_text, sport, league):
    """Extract all match entries from snapshot"""
    matches = []
    
    # Use regex to find all match links
    pattern = r'link "(\d{2}:\d{2}) ([^"]+?)\s+(\d+)\s*[–—-]\s*(\d+)\s+([^"]+?)" \[ref=\w+\]:\s*\n\s*- /url: ([^\n]+)'
    
    for match in re.finditer(pattern, snapshot_text):
        time = match.group(1)
        team1_raw = match.group(2).strip()
        score1 = match.group(3)
        score2 = match.group(4)
        team2_raw = match.group(5).strip()
        url = match.group(6).strip()
        
        # Extract match_id from URL
        match_id_match = re.search(r'-([a-zA-Z0-9]+)/$', url)
        if not match_id_match:
            continue
        match_id = match_id_match.group(1)
        
        team1 = parse_team_name(team1_raw)
        team2 = parse_team_name(team2_raw)
        score = f"{score1}-{score2}"
        winner = 1 if int(score1) > int(score2) else 2
        
        # Find the next two paragraph elements after this match URL
        # Look for odds in the text after the URL
        pos = match.end()
        remaining = snapshot_text[pos:pos+500]  # Look ahead 500 chars
        
        # Find paragraphs with odds (decimal numbers in quotes)
        odds_pattern = r'paragraph: "(\d+\.?\d*)"'
        odds_matches = re.findall(odds_pattern, remaining)
        
        if len(odds_matches) >= 2:
            try:
                odds1 = float(odds_matches[0])
                odds2 = float(odds_matches[1])
                
                # Look for bookmaker count
                num_books = 9  # default
                num_match = re.search(r'text: (\d+)', remaining[:200])
                if num_match:
                    num_books = int(num_match.group(1))
                
                implied_prob1 = 1 / odds1
                implied_prob2 = 1 / odds2
                overround = implied_prob1 + implied_prob2 - 1
                
                record = {
                    "match_id": match_id,
                    "sport": sport,
                    "league": league,
                    "team1": team1,
                    "team2": team2,
                    "score": score,
                    "winner": winner,
                    "closing_odds1": odds1,
                    "closing_odds2": odds2,
                    "implied_prob1": round(implied_prob1, 4),
                    "implied_prob2": round(implied_prob2, 4),
                    "overround": round(overround, 4),
                    "num_bookmakers": num_books,
                    "match_url": url
                }
                matches.append(record)
            except (ValueError, ZeroDivisionError):
                pass
    
    return matches

def append_to_jsonl(matches, output_file="state/journal/historical_closing_odds.jsonl"):
    """Append matches to JSONL file"""
    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'a') as f:
        for match in matches:
            f.write(json.dumps(match) + '\n')
    
    print(f"✓ Added {len(matches)} matches to {output_file}", file=sys.stderr)

if __name__ == "__main__":
    snapshot_text = sys.stdin.read()
    sport = sys.argv[1] if len(sys.argv) > 1 else "lol"
    league = sys.argv[2] if len(sys.argv) > 2 else "LCK"
    
    matches = extract_matches(snapshot_text, sport, league)
    
    if matches:
        append_to_jsonl(matches)
        for m in matches:
            print(f"{m['team1']} vs {m['team2']}: {m['score']} (odds: {m['closing_odds1']} / {m['closing_odds2']})")
    else:
        print("No matches found", file=sys.stderr)
        sys.exit(1)
