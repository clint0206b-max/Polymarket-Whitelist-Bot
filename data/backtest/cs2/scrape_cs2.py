#!/usr/bin/env python3
"""
Parse CS2 match data scraped from HLTV into analysis-ready JSONL.
Input: raw match JSON objects (from browser scraping)
Output: per-map records with halftime scores for margin analysis
"""
import json, sys, re, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def parse_halves(halves_str):
    """Parse '(8:4; 5:7)' → {'h1_t1': 8, 'h1_t2': 4, 'h2_t1': 5, 'h2_t2': 7}"""
    if not halves_str:
        return None
    m = re.match(r'\((\d+):(\d+);\s*(\d+):(\d+)\)', halves_str)
    if not m:
        # Try overtime format: (a:b; c:d; e:f)
        m2 = re.match(r'\((\d+):(\d+);\s*(\d+):(\d+);\s*(\d+):(\d+)\)', halves_str)
        if m2:
            return {
                'h1_t1': int(m2.group(1)), 'h1_t2': int(m2.group(2)),
                'h2_t1': int(m2.group(3)), 'h2_t2': int(m2.group(4)),
                'ot_t1': int(m2.group(5)), 'ot_t2': int(m2.group(6)),
                'overtime': True
            }
        return None
    return {
        'h1_t1': int(m.group(1)), 'h1_t2': int(m.group(2)),
        'h2_t1': int(m.group(3)), 'h2_t2': int(m.group(4)),
        'overtime': False
    }

def process_match(match_data):
    """Convert raw match data to per-map analysis records."""
    records = []
    t1 = match_data.get('t1') or match_data.get('team1')
    t2 = match_data.get('t2') or match_data.get('team2')
    mid = match_data.get('id') or match_data.get('matchId')
    ev = match_data.get('ev') or match_data.get('event')
    
    maps = match_data.get('maps', [])
    played_maps = [m for m in maps if m.get('s1') is not None or m.get('score1') is not None]
    
    for i, mp in enumerate(played_maps):
        s1 = mp.get('s1') or mp.get('score1')
        s2 = mp.get('s2') or mp.get('score2')
        if s1 is None or s2 is None:
            continue
            
        halves = parse_halves(mp.get('halves'))
        if not halves:
            continue
        
        # At halftime: team1 had h1_t1 rounds, team2 had h1_t2
        ht_margin_t1 = halves['h1_t1'] - halves['h1_t2']  # positive = t1 leading
        
        # Who won the map?
        t1_won = s1 > s2
        
        records.append({
            'match_id': mid,
            'team1': t1,
            'team2': t2,
            'event': ev,
            'map_name': mp.get('map'),
            'map_num': i + 1,
            'total_maps': len(played_maps),
            'score_t1': s1,
            'score_t2': s2,
            't1_won_map': t1_won,
            'ht_t1': halves['h1_t1'],
            'ht_t2': halves['h1_t2'],
            'ht_margin_t1': ht_margin_t1,
            'h2_t1': halves['h2_t1'],
            'h2_t2': halves['h2_t2'],
            'overtime': halves.get('overtime', False),
        })
    
    return records

if __name__ == '__main__':
    # Read raw match data from stdin or file
    infile = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SCRIPT_DIR, 'raw_matches.jsonl')
    outfile = sys.argv[2] if len(sys.argv) > 2 else os.path.join(SCRIPT_DIR, 'cs2_halftime_data.jsonl')
    
    total = 0
    with open(infile) as fi, open(outfile, 'w') as fo:
        for line in fi:
            match = json.loads(line.strip())
            records = process_match(match)
            for r in records:
                fo.write(json.dumps(r) + '\n')
                total += 1
    
    print(f"Wrote {total} map records to {outfile}")
