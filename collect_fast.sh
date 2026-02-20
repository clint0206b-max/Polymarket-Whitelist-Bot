#!/bin/bash
# Fast collection script - directly append matches extracted manually from snapshots

cd /Users/andres/.openclaw/workspace/polymarket-watchlist-v1

# Helper function to add a match
add_match() {
    local id="$1" sport="$2" league="$3" t1="$4" t2="$5" score="$6" odds1="$7" odds2="$8" books="$9" url="${10}"
    
    # Parse score to determine winner
    s1=$(echo "$score" | cut -d'-' -f1)
    s2=$(echo "$score" | cut -d'-' -f2)
    if [ "$s1" -gt "$s2" ]; then winner=1; else winner=2; fi
    
    # Calculate probabilities
    python3 << EOF
import json
odds1, odds2 = $odds1, $odds2
impl1 = 1 / odds1
impl2 = 1 / odds2
overround = impl1 + impl2 - 1
record = {
    "match_id": "$id",
    "sport": "$sport",
    "league": "$league",
    "team1": "$t1",
    "team2": "$t2",
    "score": "$score",
    "winner": $winner,
    "closing_odds1": odds1,
    "closing_odds2": odds2,
    "implied_prob1": round(impl1, 4),
    "implied_prob2": round(impl2, 4),
    "overround": round(overround, 4),
    "num_bookmakers": $books,
    "match_url": "$url"
}
print(json.dumps(record))
EOF
}

# Export the function
export -f add_match

echo "Helper function ready. Use add_match to append matches."
