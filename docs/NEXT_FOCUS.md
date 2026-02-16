# Next Technical Focus

## High ROI: Unify Universe Selection (2026-02-16)

### Problem
Currently `pickPriceUpdateUniverse()` and `pickEvalUniverse()` are defined inline in `loop_eval_http_only.mjs`.

If other runners/scripts need similar logic, they'll duplicate the filter → staleness risk.

### Solution
Extract to `src/runtime/universe.mjs`:

```javascript
// src/runtime/universe.mjs

/**
 * Price update universe: markets that receive price/liquidity updates
 * Includes: watching, pending_signal, signaled
 */
export function pickPriceUpdateUniverse(state, cfg) {
  const all = Object.values(state.watchlist || {}).filter(Boolean);
  return all.filter(m => 
    m.status === "watching" || 
    m.status === "pending_signal" || 
    m.status === "signaled"
  );
}

/**
 * Signal pipeline universe: markets that enter stage1/stage2/state_machine
 * Includes: watching, pending_signal
 * Excludes: signaled (already processed)
 */
export function pickEvalUniverse(state, cfg) {
  // ... existing logic from loop_eval_http_only.mjs
}

/**
 * Stats universe: markets for opportunity classification
 * Includes: watching, pending_signal, signaled
 */
export function pickStatsUniverse(state, cfg, league = null) {
  const all = pickPriceUpdateUniverse(state, cfg);
  if (!league) return all;
  return all.filter(m => m.league === league);
}
```

### Benefits
1. Single source of truth for universe definitions
2. Easier to audit (one file vs scattered)
3. Forces explicit choice when adding new loops
4. Can add JSDoc with rationale for each universe

### Effort
- **Time:** 30 minutes
- **Risk:** LOW (pure refactor, no logic change)
- **Tests:** Existing tests still pass

### Acceptance Criteria
1. Extract functions to `src/runtime/universe.mjs`
2. Update `loop_eval_http_only.mjs` imports
3. Update `LOOP_AUDIT.md` to reference universe.mjs
4. All tests pass
5. Bot runs without errors for 24h

---

## Medium ROI: Add Dashboard Health Metrics

### Problem
`percent_stale_signaled` requires manual jq command. Should be in dashboard.

### Solution
Add to `status.mjs`:

```javascript
// In HEALTH section
const signaled = Object.values(state.watchlist).filter(m => m.status === "signaled");
const stale = signaled.filter(m => (now - m.last_price?.updated_ts) > 30000);
const pct = signaled.length ? (stale.length / signaled.length * 100) : 0;

console.log(`  signaled_markets: ${signaled.length}`);
console.log(`  signaled_stale (>30s): ${stale.length} (${pct.toFixed(1)}%)${pct > 50 ? " 🔴" : pct > 10 ? " ⚠️" : ""}`);
```

### Effort
- **Time:** 15 minutes
- **Risk:** ZERO (read-only dashboard)

---

## Low Priority: Auto-Alert on Staleness

### Problem
Requires manual dashboard checks to detect staleness.

### Solution
Optional cron script that checks and alerts to Telegram/WhatsApp if `percent_stale_signaled > 50%`.

### Effort
- **Time:** 1 hour (script + test + cron)
- **Risk:** LOW (isolated script)
- **When:** Only if manual checks become tedious

---

## Recommended Order

1. **Today:** Unify universe selection (high ROI, prevents future bugs)
2. **This week:** Add dashboard metrics (quick win, operational visibility)
3. **Optional:** Auto-alert (only if needed)

---

## NOT Recommended (Low ROI)

- ❌ Implement WebSocket (premature at 50 markets, 2s polling is fine)
- ❌ Optimize HTTP batching (99.1% success rate is excellent)
- ❌ Add TP/SL automation (paper trading phase, don't rush)

Focus on operational stability and observability before adding features.
