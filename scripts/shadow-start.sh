#!/bin/bash
# Start a shadow runner with isolated state
# Usage: ./scripts/shadow-start.sh <shadow-id> [config-override-json]
# Example: ./scripts/shadow-start.sh minprob090 '{"strategy":{"min_prob":0.90}}'

set -euo pipefail

SHADOW_ID="${1:-}"
CONFIG_JSON="${2:-}"

if [ -z "$SHADOW_ID" ]; then
  echo "Usage: $0 <shadow-id> [config-override-json]"
  echo "Example: $0 minprob090 '{\"strategy\":{\"min_prob\":0.90}}'"
  exit 1
fi

if [ "$SHADOW_ID" = "prod" ]; then
  echo "ERROR: 'prod' is reserved for the production runner"
  exit 1
fi

cd "$(dirname "$0")/.."
STATE_DIR="state-${SHADOW_ID}"

# Create state dir structure
mkdir -p "$STATE_DIR/journal" "$STATE_DIR/monitor"

# Write config override if provided
if [ -n "$CONFIG_JSON" ]; then
  echo "$CONFIG_JSON" | node -e "
    const j = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(JSON.stringify(j, null, 2) + '\n');
  " > "$STATE_DIR/config-override.json"
  echo "Config override written to $STATE_DIR/config-override.json"
fi

# Check if already running
LOCK_FILE="$STATE_DIR/watchlist.lock"
if [ -f "$LOCK_FILE" ]; then
  PID=$(cut -d: -f1 "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Shadow '$SHADOW_ID' already running (PID $PID)"
    exit 1
  fi
  rm -f "$LOCK_FILE"
fi

# Start shadow runner
echo "Starting shadow runner: $SHADOW_ID"
echo "  State dir: $STATE_DIR"
echo "  Config override: ${CONFIG_JSON:-<none>}"

SHADOW_ID="$SHADOW_ID" nohup node run.mjs \
  > "$STATE_DIR/runner.log" 2>&1 &

SHADOW_PID=$!
echo "  PID: $SHADOW_PID"
echo "  Log: $STATE_DIR/runner.log"
echo ""
echo "Monitor: tail -f $STATE_DIR/runner.log"
echo "Stop: ./scripts/shadow-stop.sh $SHADOW_ID"
