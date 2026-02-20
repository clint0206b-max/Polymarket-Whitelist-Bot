#!/usr/bin/env python3
"""
Bulk extract matches from a large snapshot file containing multiple match entries
"""
import sys
import json
import re

def parse_team_name(text):
    """Team names appear duplicated"""
    text = text.strip()
    parts = text.split()
    mid = len(parts) // 2
    if mid > 0:
        first_half = ' '.join(parts[:mid])
        second_half = ' '.join(parts[mid:])
        if first_half == second_half:
            return first_half
    return text

# Read all snapshots data from a file containing the raw match patterns
input_file = sys.argv[1] if len(sys.argv) > 1 else 'lck_2025_matches.txt'
sport = sys.argv[2] if len(sys.argv) > 2 else 'lol'
league = sys.argv[3] if len(sys.argv) > 3 else 'LCK'

output_file = "state/journal/historical_closing_odds.jsonl"

with open(input_file, 'r') as f:
    content = f.read()

# Extract all match blocks
pattern = r'link "(\d{2}:\d{2}) ([^"]+?)\s+(\d+)\s*[–—-]\s*(\d+)\s+([^"]+?)" \[ref=\w+\]:\s*\n\s*- /url: ([^\n]+)'

matches = []
for match in re.finditer(pattern, content):
    time = match.group(1)
    team1_raw = match.group(2).strip()
    score1 = match.group(3)
    score2 = match.group(4)
    team2_raw = match.group(5).strip()
    url = match.group(6).strip()
    
    # Extract match_id
    match_id_match = re.search(r'-([a-zA-Z0-9]+)/$', url)
    if not match_id_match:
        continue
    match_id = match_id_match.group(1)
    
    team1 = parse_team_name(team1_raw)
    team2 = parse_team_name(team2_raw)
    score = f"{score1}-{score2}"
    winner = 1 if int(score1) > int(score2) else 2
    
    # Find next two paragraphs with odds
    pos = match.end()
    remaining = content[pos:pos+500]
    odds_pattern = r'paragraph: "(\d+\.?\d*)"'
    odds_matches = re.findall(odds_pattern, remaining)
    
    if len(odds_matches) >= 2:
        try:
            odds1 = float(odds_matches[0])
            odds2 = float(odds_matches[1])
            
            num_books = 9  # default
            num_match = re.search(r'text: (\d+)', remaining[:200])
            if num_match:
                num_books = int(num_match.group(1))
            
            impl1 = 1 / odds1
            impl2 = 1 / odds2
            overround = impl1 + impl2 - 1
            
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
                "implied_prob1": round(impl1, 4),
                "implied_prob2": round(impl2, 4),
                "overround": round(overround, 4),
                "num_bookmakers": num_books,
                "match_url": url
            }
            matches.append(record)
        except (ValueError, ZeroDivisionError):
            pass

# Write to output
with open(output_file, 'a') as f:
    for m in matches:
        f.write(json.dumps(m) + '\n')

print(f"✓ Added {len(matches)} matches from {league}")
total = 0
with open(output_file, 'r') as f:
    total = sum(1 for _ in f)
print(f"Total: {total} matches collected")
