#!/usr/bin/env bash
#
# Health Check Script for Polymarket Watchlist Bot
#
# Usage:
#   ./scripts/health-check.sh [--port PORT] [--silent] [--alert-only]
#
# Flags:
#   --port PORT      Custom health port (default: 3210)
#   --silent         Only print alerts (no OK status)
#   --alert-only     Exit 0 if OK, exit 1 if any alert fired
#
# Exit codes:
#   0 = all checks passed (or no alerts)
#   1 = at least one alert fired
#   2 = health endpoint unreachable

set -euo pipefail

PORT="${HEALTH_PORT:-3210}"
HOST="${HEALTH_HOST:-127.0.0.1}"
SILENT=0
ALERT_ONLY=0

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)
      PORT="$2"
      shift 2
      ;;
    --silent)
      SILENT=1
      shift
      ;;
    --alert-only)
      ALERT_ONLY=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

# Fetch health JSON
HEALTH_URL="http://${HOST}:${PORT}/health"
RESPONSE=$(curl -sf "$HEALTH_URL" 2>/dev/null) || {
  echo "ALERT: Health endpoint unreachable at $HEALTH_URL" >&2
  exit 2
}

# Extract fields with jq
HTTP_SUCCESS_RATE=$(echo "$RESPONSE" | jq -r '.http.success_rate_percent // 0')
PERCENT_STALE=$(echo "$RESPONSE" | jq -r '.staleness.percent_stale_signaled // 0')
RATE_LIMITED=$(echo "$RESPONSE" | jq -r '.http.rate_limited_count // 0')
LAST_WRITE_AGE=$(echo "$RESPONSE" | jq -r '.persistence.last_write_age_seconds // 0')
LAST_CYCLE_AGE=$(echo "$RESPONSE" | jq -r '.loop.last_cycle_age_seconds // 0')

# Thresholds
HTTP_SUCCESS_THRESHOLD=98.5
STALE_THRESHOLD=0
STALE_SUSTAINED_SECONDS=120  # 2 minutes
RATE_LIMITED_THRESHOLD=0
WRITE_AGE_THRESHOLD=10  # 2x throttle (5s)
CYCLE_AGE_THRESHOLD=10  # 10 seconds

ALERTS=()

# Alert logic
check_threshold() {
  local value=$1
  local threshold=$2
  local op=$3  # "lt" or "gt"
  local message=$4

  if [[ "$op" == "lt" ]]; then
    awk -v val="$value" -v thr="$threshold" 'BEGIN { exit (val < thr) ? 0 : 1 }' && ALERTS+=("$message")
  elif [[ "$op" == "gt" ]]; then
    awk -v val="$value" -v thr="$threshold" 'BEGIN { exit (val > thr) ? 0 : 1 }' && ALERTS+=("$message")
  fi
}

# Run checks
check_threshold "$HTTP_SUCCESS_RATE" "$HTTP_SUCCESS_THRESHOLD" "lt" \
  "HTTP success rate low: ${HTTP_SUCCESS_RATE}% (threshold: ${HTTP_SUCCESS_THRESHOLD}%)"

check_threshold "$PERCENT_STALE" "$STALE_THRESHOLD" "gt" \
  "Stale signaled markets detected: ${PERCENT_STALE}% stale"

check_threshold "$RATE_LIMITED" "$RATE_LIMITED_THRESHOLD" "gt" \
  "Rate limiting detected: ${RATE_LIMITED} requests rate limited"

check_threshold "$LAST_WRITE_AGE" "$WRITE_AGE_THRESHOLD" "gt" \
  "Persistence stale: last write ${LAST_WRITE_AGE}s ago (threshold: ${WRITE_AGE_THRESHOLD}s)"

check_threshold "$LAST_CYCLE_AGE" "$CYCLE_AGE_THRESHOLD" "gt" \
  "Loop stalled: last cycle ${LAST_CYCLE_AGE}s ago (threshold: ${CYCLE_AGE_THRESHOLD}s)"

# Output
if [[ ${#ALERTS[@]} -eq 0 ]]; then
  if [[ $SILENT -eq 0 ]]; then
    echo "OK: All health checks passed"
    echo "  HTTP success rate: ${HTTP_SUCCESS_RATE}%"
    echo "  Stale signaled: ${PERCENT_STALE}%"
    echo "  Rate limited: ${RATE_LIMITED}"
    echo "  Last write age: ${LAST_WRITE_AGE}s"
    echo "  Last cycle age: ${LAST_CYCLE_AGE}s"
  fi
  exit 0
else
  for alert in "${ALERTS[@]}"; do
    echo "ALERT: $alert" >&2
  done
  exit 1
fi
