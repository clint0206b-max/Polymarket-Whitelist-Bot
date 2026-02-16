#!/bin/bash
# List all active shadow runners
# Usage: ./scripts/shadow-list.sh

cd "$(dirname "$0")/.."

echo "=== Active Runners ==="
echo ""

# Prod
if [ -f "state/watchlist.lock" ]; then
  PID=$(cut -d: -f1 "state/watchlist.lock" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    PORT=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('state/config-snapshot.json','utf8'));console.log(c.health?.port||3210)}catch{console.log(3210)}" 2>/dev/null)
    echo "  prod     PID=$PID  PORT=$PORT  state=state/"
  else
    echo "  prod     DEAD (stale lock)"
  fi
else
  echo "  prod     NOT RUNNING"
fi

# Shadows
for dir in state-*/; do
  [ -d "$dir" ] || continue
  SHADOW_ID="${dir#state-}"
  SHADOW_ID="${SHADOW_ID%/}"
  LOCK="${dir}watchlist.lock"
  
  if [ -f "$LOCK" ]; then
    PID=$(cut -d: -f1 "$LOCK" 2>/dev/null || echo "")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      PORT=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('${dir}config-snapshot.json','utf8'));console.log(c.health?.port||'?')}catch{console.log('?')}" 2>/dev/null)
      echo "  ${SHADOW_ID}  PID=$PID  PORT=$PORT  state=${dir}"
    else
      echo "  ${SHADOW_ID}  DEAD (stale lock)"
    fi
  else
    echo "  ${SHADOW_ID}  NOT RUNNING  state=${dir}"
  fi
done
