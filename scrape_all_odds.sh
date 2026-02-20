#!/bin/bash
# Master script to scrape all OddsPortal pages via OpenClaw browser tool
# This script will be called by the subagent for each page

set -e

WORKDIR="/Users/andres/.openclaw/workspace/polymarket-watchlist-v1"
cd "$WORKDIR"

# Initialize output file
OUTPUT_FILE="state/journal/historical_closing_odds.jsonl"
mkdir -p "$(dirname "$OUTPUT_FILE")"

# Clear existing file if it exists
if [ -f "$OUTPUT_FILE" ]; then
    echo "Clearing existing output file..."
    rm "$OUTPUT_FILE"
fi

echo "Starting OddsPortal scraping..."
echo "Output will be written to: $OUTPUT_FILE"
echo ""

# Function to process a snapshot (will be called from Python with snapshot data)
process_snapshot() {
    local sport="$1"
    local league="$2"
    local snapshot_file="$3"
    
    if [ ! -f "$snapshot_file" ]; then
        echo "Error: Snapshot file not found: $snapshot_file" >&2
        return 1
    fi
    
    echo "Processing $sport / $league..."
    cat "$snapshot_file" | python3 scrape_oddsportal.py "$sport" "$league"
}

# Export the function so it can be used by subprocesses
export -f process_snapshot

echo "Script ready. Use process_snapshot function to process snapshots."
