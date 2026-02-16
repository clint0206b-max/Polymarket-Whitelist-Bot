# Loop Status Filter Audit - 2026-02-16

## Purpose
Verify that no other loops exclude post-signal states when they need visibility updates.

## Audit Results

### ✅ loop_eval_http_only.mjs
**Price evaluation loop (main)**
- **Fixed in e414f89:** Now uses `pickPriceUpdateUniverse()` including signaled
- **Pipeline gate:** Correctly separates price updates from signal pipeline
- **Status:** ✅ No staleness risk

**Opportunity classification (esports)**
- Lines 1785-1795
- Filter: `m.status === "watching" || m.status === "pending_signal" || m.status === "signaled"`
- **Purpose:** Tag-only statistics, not for trading
- **Status:** ✅ Includes signaled correctly

**Opportunity classification (by league)**
- Lines 1879-1889
- Filter: `m.status === "watching" || m.status === "pending_signal" || m.status === "signaled"`
- **Purpose:** Tag-only statistics for dashboard
- **Status:** ✅ Includes signaled correctly

**Token resolver**
- Lines 645-650
- Filter: `m.status === "watching" || m.status === "pending_signal"`
- **Purpose:** Resolve token pairs only for markets entering pipeline
- **Impact:** Signaled already has tokens resolved at entry
- **Status:** ✅ Correct exclusion (no staleness risk)

### ✅ loop_gamma.mjs
**Discovery & TTL**
- Lines 60-85: Token normalization backfill
- No status filters, iterates ALL markets
- **Purpose:** Metadata cleanup and Gamma discovery
- **Status:** ✅ No filters, no staleness risk

**Market upsert**
- Lines 165+: Upserts new markets from Gamma
- No status filters (creates new markets)
- **Status:** ✅ No staleness risk

### ✅ loop_resolution_tracker.mjs
**Resolution polling**
- Reads from `state/journal/open_index.json`, not watchlist
- Uses `conditionId` to lookup Gamma data
- **Purpose:** Close paper signals when markets resolve
- **Status:** ✅ Independent of watchlist status filters

### ✅ context/ modules
**ESPN scoreboard fetching**
- Triggered from eval loop for specific markets
- No direct watchlist iteration
- **Status:** ✅ No staleness risk

### ✅ strategy/ modules
**Pure functions**
- No state access, take quote/book as input
- **Status:** ✅ No staleness risk

## Summary

**Total loops audited:** 3 main (eval, gamma, resolution)  
**Staleness vulnerabilities found:** 0  
**Safe exclusions (intentional):** 1 (token resolver)

## Protected Patterns

**Safe:** Loops that need visibility must include signaled:
```javascript
// ✅ GOOD: includes signaled for stats/visibility
const markets = Object.values(state.watchlist).filter(m =>
  m.status === "watching" || 
  m.status === "pending_signal" || 
  m.status === "signaled"
);
```

**Safe:** Loops that only process pipeline-eligible markets:
```javascript
// ✅ GOOD: excludes signaled (already processed)
const markets = pickEvalUniverse(state, cfg); // only watching + pending
```

**Dangerous:** Hard-coded filters without justification:
```javascript
// ❌ BAD: may cause staleness
const markets = Object.values(state.watchlist).filter(m =>
  m.status === "watching" || m.status === "pending_signal"
);
// Ask: does this loop need to update visibility for signaled?
```

## Maintenance Rule

When adding new loops that iterate `state.watchlist`:

1. **Ask:** Does this loop update `last_price`, `liquidity`, or any visibility field?
2. **If YES:** Include signaled in filter (use `pickPriceUpdateUniverse()`)
3. **If NO:** Explicitly document why exclusion is safe
4. **Always:** Add a comment explaining the filter scope

## Next Audit

Run this audit again:
- When adding new loops/runners
- When refactoring state machine
- After any status enum changes
- Every 6 months as hygiene

Last audit: 2026-02-16  
Next audit: 2026-08-16 (or on major refactor)
