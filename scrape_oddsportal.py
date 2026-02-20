#!/usr/bin/env python3
"""
OddsPortal Historical Closing Odds Scraper
Extracts esports match data from browser snapshots
"""

import json
import re
import sys
from pathlib import Path

class OddsPortalParser:
    def __init__(self):
        self.output_file = Path("state/journal/historical_closing_odds.jsonl")
        self.output_file.parent.mkdir(parents=True, exist_ok=True)
        
    def parse_match_url(self, url):
        """Extract match_id from URL"""
        match = re.search(r'-([a-zA-Z0-9]+)/$', url)
        return match.group(1) if match else None
    
    def parse_team_name(self, text):
        """Team names appear duplicated, e.g., 'Dplus Kia Dplus Kia' -> 'Dplus Kia'"""
        text = text.strip()
        parts = text.split()
        # Find the midpoint and check if both halves are the same
        mid = len(parts) // 2
        if mid > 0:
            first_half = ' '.join(parts[:mid])
            second_half = ' '.join(parts[mid:])
            if first_half == second_half:
                return first_half
        return text
    
    def parse_score(self, score_text):
        """Parse '3 – 1' into (3, 1) and determine winner"""
        score_text = score_text.replace('–', '-').replace('—', '-')
        parts = score_text.split('-')
        if len(parts) == 2:
            try:
                score1 = int(parts[0].strip())
                score2 = int(parts[1].strip())
                winner = 1 if score1 > score2 else 2
                return f"{score1}-{score2}", winner
            except ValueError:
                return None, None
        return None, None
    
    def parse_snapshot_text(self, snapshot_text, sport, league):
        """Parse browser snapshot text and extract match data"""
        matches = []
        lines = snapshot_text.split('\n')
        
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            
            # Look for match links (they start with link and contain team names + score)
            if line.startswith('link "') and ' – ' in line and '/esports/' in lines[i+1] if i+1 < len(lines) else False:
                # Extract the link text and URL
                link_text = line[6:].rstrip('"')  # Remove 'link "' and trailing '"'
                if i+1 < len(lines):
                    url_line = lines[i+1].strip()
                    if url_line.startswith('/url:'):
                        url = url_line.split('/url:')[1].strip()
                        
                        # Look for the two paragraph elements with odds (should be close after the link)
                        odds1, odds2, num_books = None, None, None
                        for j in range(i+2, min(i+20, len(lines))):
                            if lines[j].strip().startswith('paragraph: "') and odds1 is None:
                                try:
                                    odds1 = float(lines[j].strip().split('paragraph: "')[1].rstrip('"'))
                                except (ValueError, IndexError):
                                    pass
                            elif lines[j].strip().startswith('paragraph: "') and odds1 is not None and odds2 is None:
                                try:
                                    odds2 = float(lines[j].strip().split('paragraph: "')[1].rstrip('"'))
                                except (ValueError, IndexError):
                                    pass
                            elif lines[j].strip().startswith('text:') and odds2 is not None:
                                try:
                                    num_text = lines[j].strip().split('text:')[1].strip().strip('"')
                                    if num_text.isdigit():
                                        num_books = int(num_text)
                                        break
                                except (ValueError, IndexError):
                                    pass
                        
                        if odds1 and odds2 and num_books:
                            match_data = self.parse_match_line(link_text, url, odds1, odds2, num_books, sport, league)
                            if match_data:
                                matches.append(match_data)
            
            i += 1
        
        return matches
    
    def parse_match_line(self, match_text, url, odds1, odds2, num_books, sport, league):
        """Parse a single match line"""
        match_id = self.parse_match_url(url)
        if not match_id:
            return None
        
        # Remove the time prefix (e.g., "05:00 ")
        match_text = re.sub(r'^\d{2}:\d{2}\s+', '', match_text)
        
        # Find the score part (contains '–')
        score_match = re.search(r'\s+(\d+)\s*[–—-]\s*(\d+)\s+', match_text)
        if not score_match:
            return None
        
        score_start = score_match.start()
        score_end = score_match.end()
        
        # Split into team1, score, team2
        team1_text = match_text[:score_start].strip()
        score_text = match_text[score_start:score_end].strip()
        team2_text = match_text[score_end:].strip()
        
        team1 = self.parse_team_name(team1_text)
        team2 = self.parse_team_name(team2_text)
        score, winner = self.parse_score(score_text)
        
        if not score or not team1 or not team2:
            return None
        
        closing_odds1 = float(odds1)
        closing_odds2 = float(odds2)
        implied_prob1 = 1 / closing_odds1
        implied_prob2 = 1 / closing_odds2
        overround = implied_prob1 + implied_prob2 - 1
        
        return {
            "match_id": match_id,
            "sport": sport,
            "league": league,
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
    
    def append_matches(self, matches):
        """Append matches to JSONL file"""
        with open(self.output_file, 'a') as f:
            for match in matches:
                f.write(json.dumps(match) + '\n')
        print(f"✓ Appended {len(matches)} matches to {self.output_file}", file=sys.stderr)
    
    def count_existing_matches(self):
        """Count how many matches are already in the file"""
        if not self.output_file.exists():
            return 0
        with open(self.output_file, 'r') as f:
            return sum(1 for _ in f)

if __name__ == "__main__":
    # Read snapshot from stdin
    snapshot_text = sys.stdin.read()
    
    # Get sport and league from command line args
    sport = sys.argv[1] if len(sys.argv) > 1 else "lol"
    league = sys.argv[2] if len(sys.argv) > 2 else "LCK"
    
    parser = OddsPortalParser()
    matches = parser.parse_snapshot_text(snapshot_text, sport, league)
    
    if matches:
        parser.append_matches(matches)
        print(f"Extracted {len(matches)} matches")
    else:
        print("No matches found in snapshot", file=sys.stderr)
