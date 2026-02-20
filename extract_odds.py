import json
import re
from datetime import datetime

def parse_match_url(url):
    """Extract match_id from URL"""
    match = re.search(r'-([a-zA-Z0-9]+)/$', url)
    return match.group(1) if match else None

def parse_team_name(text):
    """Team names appear duplicated, e.g., 'Dplus Kia Dplus Kia' -> 'Dplus Kia'"""
    parts = text.strip().split()
    # Find the midpoint and check if both halves are the same
    mid = len(parts) // 2
    first_half = ' '.join(parts[:mid])
    second_half = ' '.join(parts[mid:])
    if first_half == second_half:
        return first_half
    return text.strip()

def parse_score(score_text):
    """Parse '3 – 1' into (3, 1) and determine winner"""
    parts = score_text.replace('–', '-').split('-')
    if len(parts) == 2:
        score1 = int(parts[0].strip())
        score2 = int(parts[1].strip())
        winner = 1 if score1 > score2 else 2
        return f"{score1}-{score2}", winner
    return None, None

# Sample data from current page snapshot
matches_raw = [
    ("05:00 Dplus Kia Dplus Kia 3 – 1 DN SOOPers DN SOOPers", "/esports/league-of-legends/league-of-legends-lck/dplus-kia-league-of-legends-dn-soopers-league-of-legends-zDMzdCfJ/", "1.30", "3.51", "9"),
    ("05:00 DN SOOPers DN SOOPers 3 – 1 DRX DRX", "/esports/league-of-legends/league-of-legends-lck/dn-soopers-league-of-legends-drx-league-of-legends-GEEtdpMM/", "1.80", "1.98", "9"),
    ("05:00 T1 T1 1 – 3 FearX FearX", "/esports/league-of-legends/league-of-legends-lck/t1-league-of-legends-fearx-league-of-legends-zyDQaSMc/", "1.12", "5.79", "9"),
]

output = []

for match_text, url, odds1, odds2, num_books in matches_raw:
    match_id = parse_match_url(url)
    
    # Parse match text
    parts = match_text.split()
    time = parts[0]
    
    # Find the score part (contains '–' or '-')
    score_idx = None
    for i, part in enumerate(parts):
        if '–' in part or (part.isdigit() and i+1 < len(parts) and parts[i+1] in ['–', '-']):
            score_idx = i
            break
    
    if score_idx:
        team1_parts = parts[1:score_idx]
        score_parts = parts[score_idx:score_idx+3]  # e.g., ['3', '–', '1']
        team2_parts = parts[score_idx+3:]
        
        team1 = parse_team_name(' '.join(team1_parts))
        team2 = parse_team_name(' '.join(team2_parts))
        score, winner = parse_score(' '.join(score_parts))
        
        closing_odds1 = float(odds1)
        closing_odds2 = float(odds2)
        implied_prob1 = 1 / closing_odds1
        implied_prob2 = 1 / closing_odds2
        overround = implied_prob1 + implied_prob2 - 1
        
        record = {
            "match_id": match_id,
            "sport": "lol",
            "league": "LCK",
            "team1": team1,
            "team2": team2,
            "score": score,
            "winner": winner,
            "closing_odds1": closing_odds1,
            "closing_odds2": closing_odds2,
            "implied_prob1": round(implied_prob1, 4),
            "implied_prob2": round(implied_prob2, 4),
            "overround": round(overround, 4),
            "num_bookmakers": int(num_books),
            "match_url": url
        }
        output.append(record)

for record in output:
    print(json.dumps(record))
