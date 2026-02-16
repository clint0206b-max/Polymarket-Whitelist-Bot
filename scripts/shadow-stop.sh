#!/bin/bash
# Stop a shadow runner
# Usage: ./scripts/shadow-stop.sh <shadow-id>

set -euo pipefail

SHADOW_ID="${1:-}"

if [ -z "$SHADOW_ID" ]; then
  echo "Usage: $0 <shadow-id>"
  exit 1
fi

cd "$(dirname "$0")/.."
STATE_DIR="state-${SHADOW_ID}"
LOCK_FILE="$STATE_DIR/watchlist.lock"

if [ ! -f "$LOCK_FILE" ]; then
  echo "Shadow '$SHADOW_ID' not running (no lock file)"
  exit 0
fi

PID=$(cut -d: -f1 "$LOCK_FILE" 2>/dev/null || echo "")
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  echo "Stopping shadow '$SHADOW_ID' (PID $PID)"
  kill "$PID"
  sleep 2
  if kill -0 "$PID" 2>/dev/null; then
    echo "Force killing..."
    kill -9 "$PID" 2>/dev/null || true
  fi
fi

rm -f "$LOCK_FILE"
echo "Shadow '$SHADOW_ID' stopped"
