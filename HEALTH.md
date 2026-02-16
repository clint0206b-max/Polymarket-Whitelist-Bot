# Health Monitoring (v1.0)

## Overview

HTTP endpoint for external observability and alerting without reading state files.

**Endpoint**: `GET http://localhost:3210/health`

**Design principles:**
- Read-only (no state mutation)
- No authentication (local-only, binds to 127.0.0.1)
- No sensitive data (no watchlist details, tokens, credentials)
- Lightweight (responds in <10ms)

## Configuration

```json
{
  "health": {
    "enabled": true,
    "port": 3210,
    "host": "127.0.0.1"
  }
}
```

Disable by setting `health.enabled: false` in `src/config/local.json`.

## Response Format

```json
{
  "status": "ok",
  "timestamp": 1707987654321,
  "uptime_seconds": 3600,
  "pid": 12345,
  "build_commit": "abc1234",

  "loop": {
    "runs": 1800,
    "last_cycle_ts": 1707987654300,
    "last_cycle_age_seconds": 2,
    "cycle_duration_ms_avg": null
  },

  "http": {
    "success_rate_percent": 99.2,
    "success_count": 5000,
    "fail_count": 40,
    "total_count": 5040,
    "rate_limited_count": 0
  },

  "staleness": {
    "percent_stale_signaled": 0,
    "max_stale_signaled_seconds": 0,
    "stale_count": 0,
    "signaled_count": 3
  },

  "persistence": {
    "last_write_ts": 1707987652000,
    "last_write_age_seconds": 2,
    "write_success_count": 720,
    "write_skipped_count": 1080
  },

  "watchlist": {
    "total": 120,
    "by_status": {
      "watching": 100,
      "pending_signal": 15,
      "signaled": 3,
      "expired": 2
    }
  }
}
```

## Field Definitions

### status
- Always `"ok"` if server is responding
- Future: could be `"degraded"` or `"error"` based on thresholds

### timestamp
- Current server time (ms since epoch)

### uptime_seconds
- Time since bot started

### pid
- Process ID (for kill/restart scripts)

### build_commit
- Git commit hash (for version tracking)

### loop
- `runs`: Total loop iterations since start
- `last_cycle_ts`: Timestamp of last loop cycle completion
- `last_cycle_age_seconds`: How long ago last cycle completed
- `cycle_duration_ms_avg`: Average cycle duration (null for now, future instrumentation)

### http
- `success_rate_percent`: Percentage of successful HTTP requests (CLOB API)
- `success_count`: Total successful requests
- `fail_count`: Total failed requests
- `total_count`: success + fail
- `rate_limited_count`: Number of 429 rate limit responses

### staleness
- `percent_stale_signaled`: % of signaled markets with stale prices (>1min old)
- `max_stale_signaled_seconds`: Oldest price age among signaled markets
- `stale_count`: Number of stale signaled markets
- `signaled_count`: Total signaled markets

### persistence
- `last_write_ts`: Timestamp of last state write
- `last_write_age_seconds`: How long ago state was written
- `write_success_count`: Total successful writes
- `write_skipped_count`: Total skipped writes (throttled)

### watchlist
- `total`: Total markets in watchlist
- `by_status`: Count by status (watching, pending_signal, signaled, expired, ignored, traded)

## Usage

### Manual Check
```bash
curl http://localhost:3210/health | jq
```

### Monitor Script
```bash
./scripts/health-check.sh
```

**Flags:**
- `--port PORT`: Custom health port (default: 3210)
- `--silent`: Only print alerts (no OK status)
- `--alert-only`: Exit 0 if OK, exit 1 if any alert fired

**Exit codes:**
- `0`: All checks passed
- `1`: At least one alert fired
- `2`: Health endpoint unreachable

### Cron Example
```cron
# Check every 2 minutes, alert on failure
*/2 * * * * /path/to/scripts/health-check.sh --alert-only || echo "ALERT: Bot health check failed" | mail -s "Polymarket Bot Alert" you@example.com
```

## Alert Thresholds

The `health-check.sh` script implements these thresholds:

| Metric | Threshold | Alert |
|--------|-----------|-------|
| HTTP success rate | < 98.5% | HTTP success rate low |
| Stale signaled markets | > 0% | Stale signaled markets detected |
| Rate limited count | > 0 | Rate limiting detected |
| Last write age | > 10s | Persistence stale |
| Last cycle age | > 10s | Loop stalled |

### Threshold Rationale

**HTTP success rate < 98.5%**
- Normal: 99%+ (CLOB API is reliable)
- Degraded: 98-99% (intermittent issues)
- Alert: <98.5% (sustained failures, check API status)

**Stale signaled markets > 0%**
- Normal: 0% (all signaled markets update every 2-3s)
- Alert: >0% for >2min (price update loop stuck)

**Rate limited count > 0**
- Normal: 0 (under rate limits)
- Alert: >0 sustained (need to reduce concurrency or add backoff)

**Last write age > 10s**
- Normal: 2-5s (throttle is 5s for non-critical changes)
- Alert: >10s (2x throttle, persistence loop stuck)

**Last cycle age > 10s**
- Normal: 2-3s (polling interval is 2s)
- Alert: >10s (main loop stuck, likely blocking on HTTP or invariants)

## Testing

**Tests**: `tests/health_server.test.mjs` (14 tests)

**Coverage:**
- ✅ Response includes all required fields
- ✅ Uptime calculation
- ✅ Status counts by watchlist
- ✅ HTTP success rate computation
- ✅ Staleness calculation for signaled markets
- ✅ Persistence stats
- ✅ Server binds and responds to GET /health
- ✅ Returns 404 for non-/health paths
- ✅ Returns 404 for non-GET methods
- ✅ Reflects live state updates

Run tests:
```bash
node --test tests/health_server.test.mjs
```

## Troubleshooting

### Endpoint unreachable
- Check if bot is running: `ps aux | grep run.mjs`
- Check if health server started: `grep "HTTP server listening" <log-file>`
- Check port not in use: `lsof -i :3210`

### High stale percentage
- Check if main loop is running: `last_cycle_age_seconds`
- Check if price updates are blocked: review `http.fail_count`
- Check logs for errors in `loopEvalHttpOnly`

### HTTP success rate low
- Check CLOB API status: https://clob.polymarket.com/
- Check rate limits: `http.rate_limited_count`
- Review `http_fallback_fail_by_reason_last_cycle` in state

### Loop stalled
- Check `last_cycle_age_seconds` > 10s
- Check if process is hung: `kill -SIGTERM <pid>` (should write state and exit)
- Review logs for blocking operations

## Security

**Local-only by default:**
- Binds to `127.0.0.1` (not accessible from network)
- No authentication required (since local-only)
- No sensitive data exposed (no market details, tokens, credentials)

**To expose on network** (⚠️ not recommended):
```json
{
  "health": {
    "host": "0.0.0.0"  // WARNING: exposes to network
  }
}
```

**Production recommendation:**
- Keep `host: "127.0.0.1"`
- Use SSH tunnel for remote monitoring: `ssh -L 3210:localhost:3210 user@host`

## Future Improvements

1. **Metrics history**: Keep last N health snapshots in memory
2. **Threshold-based status**: Return `"degraded"` or `"error"` if thresholds breached
3. **Prometheus export**: `/metrics` endpoint in Prometheus format
4. **Grafana dashboard**: Pre-built dashboard JSON
5. **Cycle duration instrumentation**: Track min/max/avg cycle duration

## References

- Commit: [TO BE FILLED]
- Tests: `tests/health_server.test.mjs`
- Script: `scripts/health-check.sh`
- Config: `src/config/defaults.json` (health section)
