#!/bin/bash
# Helper script to process a saved snapshot file
# Usage: ./process_page.sh <snapshot_file> <sport> <league>

SNAPSHOT_FILE="$1"
SPORT="$2"
LEAGUE="$3"

if [ ! -f "$SNAPSHOT_FILE" ]; then
    echo "Error: Snapshot file not found: $SNAPSHOT_FILE"
    exit 1
fi

echo "Processing $SPORT / $LEAGUE from $SNAPSHOT_FILE..."
cat "$SNAPSHOT_FILE" | python3 parse_snapshot.py "$SPORT" "$LEAGUE"

# Show progress
TOTAL=$(wc -l < state/journal/historical_closing_odds.jsonl 2>/dev/null || echo "0")
echo "Total matches collected so far: $TOTAL"
