/**
 * Dirty Flag Tracker for State Persistence
 * 
 * Tracks when state has "important" changes that need to be persisted immediately
 * vs "cosmetic" changes that can wait until the next scheduled write.
 * 
 * IMPORTANT CHANGES (immediate persist):
 * - Status transitions (watching → pending_signal → signaled)
 * - Markets added/removed from watchlist
 * - Signals generated (paper positions opened)
 * - Resolution events (paper positions closed)
 * 
 * COSMETIC CHANGES (can wait):
 * - Context cache updates
 * - Health counters (except critical ones)
 * - Runtime timestamps
 * - Loop run counters
 * 
 * STRATEGY:
 * - Mark dirty with reason when important change occurs
 * - Persist immediately if critical flag is set
 * - Otherwise persist every N seconds (throttled)
 * - Clear dirty after successful write
 */

export class DirtyTracker {
  constructor() {
    this.dirty = false;
    this.critical = false;
    this.reasons = new Set();
    this.lastWrite = 0;
  }

  /**
   * Mark state as dirty with a reason.
   * 
   * @param {string} reason - why state changed
   * @param {boolean} critical - if true, requires immediate persist
   */
  mark(reason, critical = false) {
    this.dirty = true;
    this.reasons.add(reason);
    if (critical) this.critical = true;
  }

  /**
   * Check if state has any dirty changes.
   * @returns {boolean}
   */
  isDirty() {
    return this.dirty;
  }

  /**
   * Check if state has critical changes requiring immediate persist.
   * @returns {boolean}
   */
  isCritical() {
    return this.critical;
  }

  /**
   * Decide if we should persist now.
   * 
   * Rules:
   * - Always persist if critical
   * - Otherwise, persist if dirty AND enough time passed since last write
   * - Otherwise, skip (wait for next cycle)
   * 
   * @param {number} now - current timestamp (ms)
   * @param {object} opts - options { throttleMs: 5000 }
   * @returns {boolean}
   */
  shouldPersist(now, opts = {}) {
    const throttleMs = opts.throttleMs || 5000; // default: 5s

    // Always persist critical changes immediately
    if (this.critical) return true;

    // Persist if dirty and enough time passed
    if (this.dirty && (now - this.lastWrite >= throttleMs)) return true;

    return false;
  }

  /**
   * Clear dirty flag after successful write.
   * @param {number} now - current timestamp (ms)
   */
  clear(now) {
    this.dirty = false;
    this.critical = false;
    this.reasons.clear();
    this.lastWrite = now;
  }

  /**
   * Get dirty reasons for debugging.
   * @returns {Array<string>}
   */
  getReasons() {
    return Array.from(this.reasons);
  }
}

/**
 * Detect important changes in state by comparing before/after.
 * 
 * Returns reasons why state changed (for observability).
 * 
 * @param {object} before - state before operation
 * @param {object} after - state after operation
 * @returns {Array<string>} - list of change reasons
 */
export function detectChanges(before, after) {
  const reasons = [];

  // Watchlist size changed (markets added/removed)
  const beforeCount = Object.keys(before?.watchlist || {}).length;
  const afterCount = Object.keys(after?.watchlist || {}).length;
  if (beforeCount !== afterCount) {
    reasons.push(`watchlist_size_changed:${beforeCount}→${afterCount}`);
  }

  // Status transitions (watching → pending_signal → signaled)
  const statusBefore = {};
  const statusAfter = {};
  for (const [id, m] of Object.entries(before?.watchlist || {})) {
    if (m?.status) statusBefore[id] = m.status;
  }
  for (const [id, m] of Object.entries(after?.watchlist || {})) {
    if (m?.status) statusAfter[id] = m.status;
  }
  for (const id of Object.keys(statusAfter)) {
    if (statusBefore[id] !== statusAfter[id]) {
      reasons.push(`status_transition:${id}:${statusBefore[id] || "?"}→${statusAfter[id]}`);
    }
  }

  // Signals generated (paper positions opened)
  const signalsBefore = (before?.runtime?.last_signals || []).length;
  const signalsAfter = (after?.runtime?.last_signals || []).length;
  if (signalsAfter > signalsBefore) {
    reasons.push(`signals_generated:${signalsAfter - signalsBefore}`);
  }

  return reasons;
}
