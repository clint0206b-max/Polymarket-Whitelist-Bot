/**
 * Universe Selection Module (v1.0)
 * 
 * Single source of truth for "which markets enter which processing universe".
 * 
 * SPEC REQUIREMENT (commit e414f89):
 * - `signaled` markets MUST receive price updates for visibility (dashboard, observability)
 * - `signaled` markets MUST NOT re-enter signal pipeline (stage1/stage2)
 * 
 * STATUS DEFINITIONS:
 * - watching: actively monitoring, can enter pipeline
 * - pending_signal: in 2-hit confirmation window, priority pipeline entry
 * - signaled: paper position open, price updates only
 * - expired: outside date window, ignored by all universes
 * - ignored: manually excluded, eviction candidate
 * - traded: (legacy), eviction candidate
 */

/**
 * Select markets for price/liquidity updates.
 * 
 * @param {object} state - runtime state with state.watchlist
 * @param {object} cfg - config object (unused for now, for future extensibility)
 * @returns {Array} - array of market objects that need price updates
 * 
 * Includes: watching, pending_signal, signaled
 * Excludes: expired, ignored, traded, (any future statuses)
 * 
 * Rationale:
 * - watching: need fresh prices for signal evaluation
 * - pending_signal: need prices for 2nd hit confirmation
 * - signaled: MUST update for visibility (spec requirement, commit e414f89)
 */
export function selectPriceUpdateUniverse(state, cfg) {
  const wl = state.watchlist || {};
  const all = Object.values(wl).filter(Boolean);
  
  return all.filter(m => 
    m.status === "watching" || 
    m.status === "pending_signal" || 
    m.status === "signaled"
  );
}

/**
 * Select markets for signal pipeline evaluation (stage1 + stage2).
 * 
 * @param {object} state - runtime state with state.watchlist
 * @param {object} cfg - config object with cfg.polling.eval_max_markets_per_cycle
 * @returns {Array} - array of market objects for pipeline, sorted by priority
 * 
 * Includes: pending_signal (priority), watching (by vol)
 * Excludes: signaled, expired, ignored, traded
 * 
 * Priority logic (v1):
 * 1. ALL pending_signal markets first (oldest pending first, for deadline proximity)
 * 2. If any pending exist, ONLY evaluate pending this cycle (scheduling fix)
 * 3. Otherwise, evaluate top N watching markets (sorted by vol desc, lastSeen desc)
 * 
 * Rationale:
 * - pending_signal: must confirm or timeout within 6s window
 * - watching: can enter pending if 2-hit criteria met
 * - signaled: EXCLUDED — already in position, would duplicate entry
 */
export function selectPipelineUniverse(state, cfg) {
  const maxPer = Number(cfg?.polling?.eval_max_markets_per_cycle || 20);
  const wl = state.watchlist || {};
  const all = Object.values(wl).filter(Boolean);

  // v1 rule: ALWAYS include pending_signal first (to make 2 hits in-window possible)
  const pending = all
    .filter(m => m.status === "pending_signal")
    .map(m => ({ m, ps: Number(m.pending_since_ts || 0) }));

  // Deterministic order: oldest pending first (closest to expiry)
  pending.sort((a, b) => (a.ps - b.ps) || String(a.m.slug || "").localeCompare(String(b.m.slug || "")));

  // Scheduling fix: if there is ANY pending, evaluate ONLY pending this tick.
  if (pending.length > 0) return pending.map(x => x.m);

  const watching = all
    .filter(m => m.status === "watching")
    .map(m => ({
      m,
      vol: Number(m.gamma_vol24h_usd || 0),
      lastSeen: Number(m.last_seen_ts || 0)
    }));

  watching.sort((a, b) => (b.vol - a.vol) || (b.lastSeen - a.lastSeen));

  return watching.slice(0, maxPer).map(x => x.m);
}

/**
 * Helper: select all active markets (not expired).
 * 
 * Used by: Gamma date window cleanup, token resolution, etc.
 * 
 * @param {object} state - runtime state with state.watchlist
 * @returns {Array} - array of all non-expired market objects
 */
export function selectAllActive(state) {
  const wl = state.watchlist || {};
  return Object.values(wl).filter(m => m && m.status !== "expired");
}
