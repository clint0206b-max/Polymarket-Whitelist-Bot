# Universe Selection Inventory

## Current State (Before Refactor)

### 1. loop_eval_http_only.mjs

**Price Update Universe** (lines ~420-431)
```javascript
function pickPriceUpdateUniverse(state, cfg) {
  const wl = state.watchlist || {};
  const all = Object.values(wl).filter(Boolean);
  
  // Include watching, pending_signal, AND signaled for price updates
  return all.filter(m => 
    m.status === "watching" || 
    m.status === "pending_signal" || 
    m.status === "signaled"
  );
}
```
- **Purpose**: Fetch prices/liquidity for markets that need current data
- **Status filters**: `watching`, `pending_signal`, `signaled`
- **Spec requirement**: signaled MUST be included for visibility (commit e414f89)

**Signal Pipeline Universe** (lines ~433-461)
```javascript
function pickEvalUniverse(state, cfg) {
  const maxPer = Number(cfg?.polling?.eval_max_markets_per_cycle || 20);
  const wl = state.watchlist || {};
  const all = Object.values(wl).filter(Boolean);

  // v1 rule: ALWAYS include pending_signal first
  const pending = all.filter(m => m.status === "pending_signal")...
  if (pending.length > 0) return pending.map(x => x.m);

  const watching = all.filter(m => m.status === "watching")...
  return watching.slice(0, maxPer).map(x => x.m);
}
```
- **Purpose**: Markets that can enter signal pipeline (stage1/stage2 evaluation)
- **Status filters**: `watching`, `pending_signal` ONLY
- **Logic**: Pending first (deterministic), then watching by vol
- **Hard gate**: `if (m.status === "signaled") continue;` before stage1/stage2 (line ~1780)

### 2. loop_gamma.mjs

**Date Window Cleanup Universe** (lines ~180-206)
```javascript
for (const m of Object.values(state.watchlist || {})) {
  if (!m || m.status === "expired") continue;
  // ... date window check, mark expired if too far
}
```
- **Purpose**: Remove stale markets from active watchlist
- **Status filter**: Operates on ALL except already-expired
- **Action**: Marks as `expired` if outside date window

**Backfill/Normalization Universe** (lines ~43-58)
```javascript
for (const m of Object.values(state.watchlist || {})) {
  // Backfill market_kind, normalize tokens
}
```
- **Purpose**: Infra/observability maintenance
- **Status filter**: NONE (operates on entire watchlist)

### 3. eviction.mjs

**Eviction Universe**
```javascript
const entries = ids.map(id => ({
  id,
  status: String(wl[id]?.status || "watching"),
  lastSeen: asNum(wl[id]?.last_seen_ts)
}));
// Rank: expired < ignored < traded < [watching/pending/signaled]
```
- **Purpose**: Evict oldest markets when watchlist exceeds max
- **Status filter**: NONE (ranks ALL, evicts lowest priority)
- **Ranking**: expired → ignored → traded → active

### 4. loop_resolution_tracker.mjs

**Paper Positions Universe**
```javascript
const idx = loadOpenIndex();
const open = idx.open || {};
```
- **Purpose**: Resolve paper positions by polling Gamma
- **Status filter**: NONE (operates on separate `open` index, not watchlist)
- **Scope**: Independent from watchlist status

### 5. watchlist_upsert.mjs

**Upsert Universe**
- **Purpose**: Insert/update market metadata
- **Status filter**: NONE (operates on single market at a time)
- **Action**: Sets initial status to `watching` if missing

## Duplication & Inconsistency Risks

1. **Status gates hardcoded in loop**: `if (m.status === "signaled") continue;` duplicates the pipeline exclusion logic
2. **Two separate functions**: `pickPriceUpdateUniverse` + `pickEvalUniverse` define similar filters in the same file
3. **No single source of truth**: If we need to add a new status (e.g., `cooling_down`), must update multiple locations
4. **Hard to audit**: Can't quickly verify "which universes include signaled?"

## Refactor Goal

**Centralize universe selection in `src/runtime/universe.mjs`:**
- `selectPriceUpdateUniverse(state, cfg)` → watching, pending_signal, signaled
- `selectPipelineUniverse(state, cfg)` → watching, pending_signal (sorted by priority)
- Document spec requirement for signaled (visibility)
- Remove hardcoded status checks from loop

**Preserve behavior exactly:**
- Price updates: same 3 statuses
- Pipeline: same 2 statuses, same priority logic (pending first, then watching by vol)
- Tests verify no behavioral change
