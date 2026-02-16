# Operational Checks - Watchlist v1

## Quick Health Check (30 seconds)

Run when opening dashboard or after any deploy:

```bash
cd ~/.openclaw/workspace/polymarket-watchlist-v1
node status.mjs | grep -A 5 "Paper Positions\|HEALTH"
```

### Three Critical Metrics

1. **`percent_stale_signaled`** (future addition to dashboard)
   - Manual check:
   ```bash
   cat state/watchlist.json | jq '[.watchlist | to_entries[] | select(.value.status == "signaled") | select(((now*1000 - .value.last_price.updated_ts) / 1000) > 30)] | length'
   ```
   - ✅ **Healthy:** 0-1 markets stale
   - ⚠️ **Degraded:** 2+ markets stale
   - 🔴 **Critical:** >50% stale

2. **`http_success_rate`**
   ```bash
   cat state/watchlist.json | jq '.runtime.health | (.http_fallback_success_count / (.http_fallback_success_count + .http_fallback_fail_count) * 100)'
   ```
   - ✅ **Healthy:** > 99%
   - ⚠️ **Degraded:** 95-99%
   - 🔴 **Critical:** < 95%

3. **`rate_limits`**
   ```bash
   cat state/watchlist.json | jq '.runtime.health.rate_limited_count'
   ```
   - ✅ **Healthy:** null or 0
   - 🔴 **Critical:** > 0

## Diagnosis Order (when percent_stale_signaled elevated)

**NEVER assume code bug first.** Follow this order:

1. **HTTP health** (5 min)
   - Check `http_fallback_fail_count` trend
   - Check `http_fallback_fail_by_reason_last_cycle`
   - Action: If >5% fail rate, reduce `clob_eval_seconds` from 2→3

2. **Latency** (5 min)
   - Check system load: `uptime`
   - Check network: `ping clob.polymarket.com`
   - Action: If latency >500ms, investigate network or reduce concurrency

3. **Capacity** (5 min)
   - Check queue drops: `http_queue_dropped_count`
   - Check concurrency saturation: compare request rate vs `http_max_concurrency`
   - Action: Increase `http_max_concurrency` from 4→6 or `http_queue_max` from 50→100

4. **Code regression** (only after above ruled out)
   - Verify `pickPriceUpdateUniverse` includes signaled
   - Check commit history for unintended filter changes
   - Run regression test: `node --test tests/signaled_price_update.test.mjs`

## Staleness Threshold Rule (Operational, not code)

**Rule:** Stale age must be > 2× polling interval to avoid false positives.

- Current: `clob_eval_seconds = 2` → **stale threshold = 30 seconds** (15× safety margin)
- If increased to 3s → keep threshold at 30s (10× margin, still safe)
- If increased to 5s → raise threshold to 60s (12× margin)

**Rationale:** Queue delays + HTTP timeout + processing can legitimately reach 10-15s in peak load.

## Proactive Monitoring (optional cron)

Add to crontab for Telegram alerts:

```bash
# Every 30 min: check signaled staleness
*/30 * * * * cd /path/to/watchlist-v1 && node tools/check-stale-signaled.mjs --alert-if-over 50
```

(Script not yet implemented — create only if manual checks become tedious)

## Post-Deploy Verification

After ANY code change to `loop_eval_http_only.mjs`:

1. Run regression test: `node --test tests/signaled_price_update.test.mjs`
2. Restart bot
3. Wait 2 minutes
4. Check Duke (or any signaled) age: must be <30s
5. Confirm no rate limits

**If ANY step fails:** Revert immediately via `git revert` + restart.
