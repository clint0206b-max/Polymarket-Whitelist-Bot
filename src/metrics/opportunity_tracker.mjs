/**
 * Opportunity Tracker — Phase 1
 *
 * Observes markets that enter the signal pipeline but get rejected.
 * Logs lifecycle events to opportunities.jsonl for post-hoc analysis.
 *
 * DESIGN PRINCIPLES:
 * - Read-only: never modifies market status, signals, or pipeline state
 * - Event-driven persistence: writes opp_tracker.json only on transitions, debounced
 * - Feature-flagged: opportunity_tracker.enabled must be true
 * - Schema-versioned: every journal entry has schema_version for evolution
 */

import { appendJsonl } from "../core/journal.mjs";
import { writeJsonAtomic, readJson } from "../core/state_store.js";

const SCHEMA_VERSION = 1;
const JOURNAL_PATH = "state/journal/opportunities.jsonl";
const STATE_PATH = "state/opp_tracker.json";

// Debounce: no more than 1 persist every N ms
const PERSIST_DEBOUNCE_MS = 10_000;

// Discontinuity: if gap between ticks > eval_interval * GAP_MULTIPLIER, mark a gap
const GAP_MULTIPLIER = 3;

// Stage fail summary: emit every N ms
const STAGE_SUMMARY_INTERVAL_MS = 5 * 60_000; // 5 minutes

/**
 * Composite key for tracking (avoids conditionId collisions across re-listings)
 */
function trackingKey(conditionId, slug) {
  return `${conditionId}::${slug}`;
}

export class OpportunityTracker {
  /**
   * @param {object} cfg - Bot config
   * @param {string} bootId - Unique boot identifier (timestamp string)
   */
  constructor(cfg, bootId) {
    this._cfg = cfg;
    this._bootId = bootId;
    this._enabled = !!cfg?.opportunity_tracker?.enabled;

    // Map<trackingKey, TrackedMarket>
    this._tracked = new Map();

    // Aggregate stage fail counters (not per-market)
    this._stageFails = {};

    // Persistence
    this._dirty = false;
    this._lastPersistTs = 0;

    // Stage summary
    this._lastStageSummaryTs = 0;
  }

  get enabled() { return this._enabled; }

  /**
   * Load persisted state from disk on boot.
   * Logs opp_boot_resume for entries that survived restart.
   */
  load() {
    if (!this._enabled) return;

    try {
      const raw = readJson(STATE_PATH);
      if (!raw || typeof raw !== "object") return;

      const entries = raw.tracked || {};
      let resumed = 0;

      for (const [key, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== "object") continue;
        // Restore Map
        this._tracked.set(key, entry);
        resumed++;
      }

      if (resumed > 0) {
        appendJsonl(JOURNAL_PATH, {
          type: "opp_boot_resume",
          schema_version: SCHEMA_VERSION,
          boot_id: this._bootId,
          ts: Date.now(),
          resumed_count: resumed,
          keys: Array.from(this._tracked.keys()).slice(0, 20), // cap for readability
        });
      }
    } catch {
      // First boot or corrupt file — start fresh
    }
  }

  /**
   * Called when a market is in the pipeline and gets rejected by a gate
   * AFTER passing basic filters (stage1 price/spread + stage2 depth).
   *
   * @param {object} market - Watchlist market object
   * @param {string} rejectReason - Gate reject reason (e.g. "cbb_gate:not_final_period")
   * @param {object} priceSnapshot - { ask, bid, spread }
   * @param {object} depthSnapshot - { entry_depth_usd_ask, exit_depth_usd_bid }
   * @param {object} contextSnapshot - { period, minutes_left, margin, teams, score }
   * @param {number} now - Current timestamp
   */
  onGateReject(market, rejectReason, priceSnapshot, depthSnapshot, contextSnapshot, now) {
    if (!this._enabled) return;

    const key = trackingKey(market.conditionId, market.slug);
    let entry = this._tracked.get(key);

    const evalIntervalMs = Number(this._cfg?.polling?.clob_eval_seconds || 2) * 1000;
    const gapThresholdMs = evalIntervalMs * GAP_MULTIPLIER;

    if (!entry) {
      // New near-miss
      entry = {
        conditionId: String(market.conditionId || ""),
        slug: String(market.slug || ""),
        league: String(market.league || ""),
        first_seen_ts: now,
        last_tick_ts: now,
        best_ask_seen: priceSnapshot.ask,
        worst_ask_seen: priceSnapshot.ask,
        best_bid_seen: priceSnapshot.bid,
        current_reject_reason: rejectReason,
        reject_reason_counts: { [rejectReason]: 1 },
        time_in_reason_ms: { [rejectReason]: 0 },
        observed_ticks_in_range: 1,
        observed_time_in_range_ms: 0,
        gap_count: 0,
        context_at_first_reject: { ...contextSnapshot },
        dirty: true,
      };
      this._tracked.set(key, entry);

      // Log first near-miss
      this._logNearMiss(entry, priceSnapshot, depthSnapshot, contextSnapshot, null, now);
      return;
    }

    // Existing entry — update
    const tickGap = now - entry.last_tick_ts;

    // Gap detection
    if (tickGap > gapThresholdMs) {
      entry.gap_count++;
    } else {
      // Accumulate observed time (only if no gap)
      entry.observed_time_in_range_ms += tickGap;
    }

    // Accumulate time in current reason
    if (entry.current_reject_reason && tickGap <= gapThresholdMs) {
      const r = entry.current_reject_reason;
      entry.time_in_reason_ms[r] = (entry.time_in_reason_ms[r] || 0) + tickGap;
    }

    entry.last_tick_ts = now;
    entry.observed_ticks_in_range++;

    // Update price range
    if (priceSnapshot.ask != null) {
      if (entry.best_ask_seen == null || priceSnapshot.ask > entry.best_ask_seen) entry.best_ask_seen = priceSnapshot.ask;
      if (entry.worst_ask_seen == null || priceSnapshot.ask < entry.worst_ask_seen) entry.worst_ask_seen = priceSnapshot.ask;
    }
    if (priceSnapshot.bid != null) {
      if (entry.best_bid_seen == null || priceSnapshot.bid > entry.best_bid_seen) entry.best_bid_seen = priceSnapshot.bid;
    }

    // Reason transition → log
    if (rejectReason !== entry.current_reject_reason) {
      const prevReason = entry.current_reject_reason;
      entry.current_reject_reason = rejectReason;
      entry.reject_reason_counts[rejectReason] = (entry.reject_reason_counts[rejectReason] || 0) + 1;
      entry.dirty = true;

      this._logNearMiss(entry, priceSnapshot, depthSnapshot, contextSnapshot, prevReason, now);
    } else {
      // Same reason — just increment counter
      entry.reject_reason_counts[rejectReason] = (entry.reject_reason_counts[rejectReason] || 0) + 1;
    }
  }

  /**
   * Called when a market passes all filters and generates a signal.
   * Removes it from tracking (we traded it — not a miss).
   */
  onTraded(market, now) {
    if (!this._enabled) return;

    const key = trackingKey(market.conditionId, market.slug);
    const entry = this._tracked.get(key);
    if (!entry) return;

    this._logClosedTracking(entry, "traded", now);
    this._tracked.delete(key);
    this._dirty = true;
  }

  /**
   * Called when a market is removed from watchlist (purge, TTL, eviction, etc.)
   *
   * @param {object} market - Market being removed
   * @param {string} closeReason - Why it was removed (e.g. "purged_terminal", "purged_ttl")
   * @param {object|null} lastPrice - Last known price { ask, bid }
   * @param {object|null} lastContext - Last known context snapshot
   * @param {number} now - Current timestamp
   */
  onRemoved(market, closeReason, lastPrice, lastContext, now) {
    if (!this._enabled) return;

    const key = trackingKey(market.conditionId, market.slug);
    const entry = this._tracked.get(key);
    if (!entry) return;

    this._logClosedTracking(entry, closeReason, now, lastPrice, lastContext);
    this._tracked.delete(key);
    this._dirty = true;
  }

  /**
   * Record a stage-level failure (aggregate, not per-market).
   * Used to detect if the real bottleneck is stage1/stage2, not gates.
   */
  recordStageFail(league, stage, now) {
    if (!this._enabled) return;

    const key = `${league}:${stage}`;
    this._stageFails[key] = (this._stageFails[key] || 0) + 1;
  }

  /**
   * Emit stage fail summary if interval has elapsed.
   * Called once per eval cycle.
   */
  maybeFlushStageSummary(now) {
    if (!this._enabled) return;

    if (now - this._lastStageSummaryTs < STAGE_SUMMARY_INTERVAL_MS) return;
    this._lastStageSummaryTs = now;

    const counts = { ...this._stageFails };
    if (Object.keys(counts).length === 0) return;

    appendJsonl(JOURNAL_PATH, {
      type: "stage_fail_summary",
      schema_version: SCHEMA_VERSION,
      boot_id: this._bootId,
      ts: now,
      interval_ms: STAGE_SUMMARY_INTERVAL_MS,
      counts,
    });

    // Reset for next interval
    this._stageFails = {};
  }

  /**
   * Persist tracked state to disk (event-driven, debounced).
   * Call after transitions or periodically.
   */
  maybePersist(now) {
    if (!this._enabled) return;
    if (!this._dirty && !this._hasAnyDirtyEntry()) return;
    if (now - this._lastPersistTs < PERSIST_DEBOUNCE_MS) return;

    this._persist(now);
  }

  /**
   * Force persist (e.g. on graceful shutdown).
   */
  forcePersist() {
    if (!this._enabled) return;
    this._persist(Date.now());
  }

  // --- Internal ---

  _hasAnyDirtyEntry() {
    for (const entry of this._tracked.values()) {
      if (entry.dirty) return true;
    }
    return false;
  }

  _persist(now) {
    const serialized = {};
    for (const [key, entry] of this._tracked) {
      // Clear dirty flags
      entry.dirty = false;
      serialized[key] = entry;
    }

    try {
      writeJsonAtomic(STATE_PATH, {
        version: SCHEMA_VERSION,
        boot_id: this._bootId,
        persisted_ts: now,
        tracked: serialized,
      });
    } catch (err) {
      // Don't crash the bot for tracker persistence failures
      console.error(`[OPP_TRACKER] persist failed: ${err.message}`);
    }

    this._dirty = false;
    this._lastPersistTs = now;
  }

  _logNearMiss(entry, priceSnapshot, depthSnapshot, contextSnapshot, prevReason, now) {
    appendJsonl(JOURNAL_PATH, {
      type: "opp_near_miss",
      schema_version: SCHEMA_VERSION,
      boot_id: this._bootId,
      ts: now,
      slug: entry.slug,
      league: entry.league,
      conditionId: entry.conditionId,
      reject_reason: entry.current_reject_reason,
      prev_reason: prevReason,
      ask: priceSnapshot.ask,
      bid: priceSnapshot.bid,
      spread: priceSnapshot.spread,
      entry_depth_usd_ask: depthSnapshot?.entry_depth_usd_ask ?? null,
      exit_depth_usd_bid: depthSnapshot?.exit_depth_usd_bid ?? null,
      context: contextSnapshot ? {
        period: contextSnapshot.period ?? null,
        minutes_left: contextSnapshot.minutes_left ?? null,
        margin: contextSnapshot.margin ?? null,
        margin_for_yes: contextSnapshot.margin_for_yes ?? null,
        win_prob: contextSnapshot.win_prob ?? null,
        state: contextSnapshot.state ?? null,
      } : null,
      time_in_range_ms: entry.observed_time_in_range_ms,
      ticks_passing_basics: entry.observed_ticks_in_range,
      gap_count: entry.gap_count,
    });
  }

  _logClosedTracking(entry, closeReason, now, lastPrice, lastContext) {
    appendJsonl(JOURNAL_PATH, {
      type: "opp_closed_tracking",
      schema_version: SCHEMA_VERSION,
      boot_id: this._bootId,
      ts: now,
      slug: entry.slug,
      league: entry.league,
      conditionId: entry.conditionId,
      close_reason: closeReason,
      tracking_duration_ms: now - entry.first_seen_ts,
      best_ask_seen: entry.best_ask_seen,
      worst_ask_seen: entry.worst_ask_seen,
      best_bid_seen: entry.best_bid_seen,
      last_reject_reason: entry.current_reject_reason,
      reject_reason_counts: { ...entry.reject_reason_counts },
      time_in_reason_ms: { ...entry.time_in_reason_ms },
      total_ticks_in_range: entry.observed_ticks_in_range,
      observed_time_in_range_ms: entry.observed_time_in_range_ms,
      gap_count: entry.gap_count,
      last_known_price: lastPrice ? {
        ask: lastPrice.ask ?? lastPrice.yes_best_ask ?? null,
        bid: lastPrice.bid ?? lastPrice.yes_best_bid ?? null,
      } : null,
      context_at_close: lastContext ? {
        period: lastContext.period ?? null,
        minutes_left: lastContext.minutes_left ?? null,
        margin: lastContext.margin ?? null,
        state: lastContext.state ?? null,
      } : null,
      context_at_first_reject: entry.context_at_first_reject || null,
    });
  }

  /**
   * Get current tracker stats (for health endpoint).
   */
  getStats() {
    return {
      enabled: this._enabled,
      tracked_count: this._tracked.size,
      boot_id: this._bootId,
    };
  }
}
