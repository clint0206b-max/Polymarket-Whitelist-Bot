# Health Metrics - Watchlist v1

## Critical: Signaled Markets Staleness

### Metric: `percent_stale_signaled`
**Definition:** Percentage of signaled markets with `last_price.updated_ts` older than 30 seconds.

**Threshold:**
- ✅ **Healthy:** < 10%
- ⚠️ **Degraded:** 10-50%
- 🔴 **Critical:** > 50%

**Cause analysis when elevated:**
1. Rate limits (check `rate_limited_count`)
2. HTTP failures (check `http_fallback_fail_count`)
3. Queue saturation (check queue drop counters)
4. Network issues

**Implementation:**
```javascript
const signaled = Object.values(state.watchlist).filter(m => m.status === "signaled");
const stale = signaled.filter(m => (now - m.last_price?.updated_ts) > 30000);
const percent = signaled.length ? (stale.length / signaled.length * 100) : 0;
```

**Dashboard placement:**
Add to `status.mjs` HEALTH section:
```
=== HEALTH ===
  ...
  signaled_markets: 5
  signaled_stale (>30s): 2 (40.0%)  ⚠️
```

## Related Metrics

### HTTP Health
- `http_fallback_success_count` / (`success + fail`) = success rate
- `rate_limited_count` > 0 → immediate alert
- Target: > 99% success rate

### State Persistence
- `state_write_count` / `runs` = write ratio
- Target: 30-70% (avoid both extremes)
- Too high (>80%) → throttle writes
- Too low (<20%) → verify dirty detection

### Price Update Coverage
- Markets with fresh quotes (`age < 5s`) / total active
- Target: > 95% for watching + pending_signal
- Target: > 90% for signaled (acceptable lag)

## Post-Fix Baseline (2026-02-16)

After fix e414f89:
- Signaled markets: 1
- Stale (>30s): 0 (0%)
- HTTP success: 99.1%
- Write ratio: 51%
- Rate limits: 0

**Regression detection:** If stale% > 50%, investigate immediately.
