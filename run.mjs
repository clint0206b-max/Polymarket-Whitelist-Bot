#!/usr/bin/env node

import { loadConfig } from "./src/core/config.js";
import { acquireLock, releaseLock } from "./src/core/lockfile.js";
import { nowMs, sleepMs } from "./src/core/time.js";
import { readJson, writeJsonAtomic, resolvePath } from "./src/core/state_store.js";
import { appendJsonl, loadOpenIndex, saveOpenIndex, addOpen } from "./src/core/journal.mjs";

const cfg = loadConfig();

const STATE_PATH = resolvePath("state", "watchlist.json");
const LOCK_PATH = resolvePath("state", "watchlist.lock");

function baseState() {
  return {
    version: 1,
    polling: cfg.polling,
    filters: cfg.filters,
    watchlist: {},
    runtime: {
      last_run_ts: 0,
      runs: 0,
      candidates_found: 0,
      last_gamma_fetch_ts: 0,
      last_eval_ts: 0,
      health: {
        state_write_count: 0,
        state_write_skipped_count: 0,
        gamma_fetch_count: 0,
        gamma_fetch_fail_count: 0,
        gamma_token_parse_fail_count: 0,
        gamma_token_count_unexpected_count: 0,

        // Phase 2 health counters
        http_fallback_success_count: 0,
        http_fallback_fail_count: 0,
        rate_limited_count: 0,
        token_resolve_failed_count: 0,
        token_resolve_failed_reason_missing_score: 0,
        token_resolve_failed_reason_tie_score: 0,
        token_complement_sanity_skipped_count: 0
      }
    }
  };
}

function bumpHealthBucket(state, now, key, by = 1) {
  state.runtime = state.runtime || {};
  state.runtime.health = state.runtime.health || {};
  const health = state.runtime.health;
  const minuteStart = Math.floor(now / 60000) * 60000;
  health.buckets = health.buckets || {};
  const node = health.buckets.health || (health.buckets.health = { idx: 0, buckets: [] });
  if (!Array.isArray(node.buckets) || node.buckets.length !== 5) {
    node.buckets = Array.from({ length: 5 }, () => ({ start_ts: 0, counts: {} }));
    node.idx = 0;
  }
  const cur = node.buckets[node.idx];
  if (cur.start_ts !== minuteStart) {
    node.idx = (node.idx + 1) % 5;
    node.buckets[node.idx] = { start_ts: minuteStart, counts: {} };
  }
  const b = node.buckets[node.idx];
  b.counts[key] = (b.counts[key] || 0) + by;
}

const lock = acquireLock(LOCK_PATH);
if (!lock.ok) {
  console.error(`[LOCK] Unable to acquire lock: ${lock.reason}${lock.info ? ` (${lock.info})` : ""}`);
  process.exit(1);
}

let state = null;
try {
  state = readJson(STATE_PATH) || baseState();
} catch (e) {
  console.error(`[STATE] Failed to read state, starting fresh: ${e?.message || e}`);
  state = baseState();
}

let running = true;
const shutdown = (sig) => {
  console.log(`[SHUTDOWN] ${sig}`);
  running = false;
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const started = nowMs();
const stopAfterMs = Number(process.env.STOP_AFTER_MS || 60000); // Phase 0: run 60s

try {
  while (running) {
    const now = nowMs();
    state.runtime.runs = (state.runtime.runs || 0) + 1;
    state.runtime.last_run_ts = now;

    // --- Phase 1: Gamma discovery loop ---
    const lastGamma = Number(state.runtime.last_gamma_fetch_ts || 0);
    const gammaEveryMs = Number(cfg.polling?.gamma_discovery_seconds || 60) * 1000;

    // --- Phase 2: HTTP-only eval loop (/book) ---
    const lastEval = Number(state.runtime.last_eval_ts || 0);
    const evalEveryMs = Number(cfg.polling?.clob_eval_seconds || 3) * 1000;

    let dirty = false;

    if (now - lastGamma >= gammaEveryMs) {
      const { loopGamma } = await import("./src/runtime/loop_gamma.mjs");
      const { checkAndFixInvariants } = await import("./src/core/invariants.js");

      const r = await loopGamma(state, cfg, now);
      checkAndFixInvariants(state, cfg, now);

      state.runtime.last_gamma_fetch_ts = now;
      state.runtime.health.watchlist_total = Object.keys(state.watchlist || {}).length;
      state.runtime.health.loop_gamma_last = r.stats;

      dirty = dirty || !!r.changed;
    }

    if (now - lastEval >= evalEveryMs) {
      const { loopEvalHttpOnly } = await import("./src/runtime/loop_eval_http_only.mjs");
      const { checkAndFixInvariants } = await import("./src/core/invariants.js");
      const { loopResolutionTracker } = await import("./src/runtime/loop_resolution_tracker.mjs");

      // Snapshot signal buffer before eval (to detect new signals deterministically)
      const prevSignals = Array.isArray(state?.runtime?.last_signals) ? state.runtime.last_signals.slice() : [];

      const r = await loopEvalHttpOnly(state, cfg, now);
      checkAndFixInvariants(state, cfg, now);

      // Journal: paper positions for new signals (append-only) + open_index
      try {
        const curSignals = Array.isArray(state?.runtime?.last_signals) ? state.runtime.last_signals : [];
        const prevSet = new Set(prevSignals.map(s => `${Number(s?.ts || 0)}|${String(s?.slug || "")}`));
        const newOnes = curSignals.filter(s => {
          const k = `${Number(s?.ts || 0)}|${String(s?.slug || "")}`;
          return Number(s?.ts || 0) && s?.slug && !prevSet.has(k);
        });

        if (newOnes.length) {
          const idx = loadOpenIndex();
          for (const s of newOnes) {
            const signalId = `${Number(s.ts)}|${String(s.slug)}`;
            const entryPrice = Number(s.probAsk);
            const paperNotional = Number(cfg?.paper?.notional_usd ?? 10);
            const entryOutcome = (s?.esports?.yes_outcome_name) ? String(s.esports.yes_outcome_name) : null;

            appendJsonl("state/journal/signals.jsonl", {
              type: "signal_open",
              signal_id: signalId,
              ts_open: Number(s.ts),
              slug: String(s.slug),
              conditionId: String(s.conditionId || ""),
              league: String(s.league || ""),
              market_kind: s.market_kind || null,
              signal_type: String(s.signal_type || ""),
              near_by: String(s.near_by || ""),
              entry_price: entryPrice,
              spread: Number(s.spread),
              entry_depth_usd_ask: Number(s.entryDepth || 0),
              exit_depth_usd_bid: Number(s.exitDepth || 0),
              paper_notional_usd: paperNotional,
              paper_shares: (entryPrice > 0) ? (paperNotional / entryPrice) : null,
              entry_outcome_name: entryOutcome,

              would_gate_apply: (s.would_gate_apply === true),
              would_gate_block: (s.would_gate_block === true),
              would_gate_reason: String(s.would_gate_reason || "not_applicable"),

              tp_bid_target: Number(s.tp_bid_target ?? null),
              tp_min_profit_per_share: Number(s.tp_min_profit_per_share ?? null),
              tp_fees_roundtrip: Number(s.tp_fees_roundtrip ?? null),
              tp_max_entry_dynamic: (s.tp_max_entry_dynamic == null ? null : Number(s.tp_max_entry_dynamic)),
              tp_math_margin: (s.tp_math_margin == null ? null : Number(s.tp_math_margin)),
              tp_math_allowed: (s.tp_math_allowed === true),
              tp_math_reason: String(s.tp_math_reason || "no_data"),

              ctx: s.ctx || null,
              esports: s.esports || null,
              status: "open"
            });

            addOpen(idx, signalId, {
              slug: String(s.slug),
              ts_open: Number(s.ts),
              league: String(s.league || ""),
              market_kind: s.market_kind || null,
              entry_price: entryPrice,
              paper_notional_usd: paperNotional,
              entry_outcome_name: entryOutcome,
              would_gate_apply: (s.would_gate_apply === true),
              would_gate_block: (s.would_gate_block === true),
              would_gate_reason: String(s.would_gate_reason || "not_applicable"),
              tp_math_allowed: (s.tp_math_allowed === true),
              tp_math_reason: String(s.tp_math_reason || "no_data")
            });
          }
          saveOpenIndex(idx);
        }
      } catch {}

      // Resolve paper positions (cheap: only open signals)
      try {
        const lastRes = Number(state.runtime?.last_resolution_ts || 0);
        const everyResMs = Number(cfg?.paper?.resolution_poll_seconds ?? 60) * 1000;
        if (!lastRes || (now - lastRes) >= everyResMs) {
          await loopResolutionTracker(cfg);
          state.runtime.last_resolution_ts = now;
        }
      } catch {}

      state.runtime.last_eval_ts = now;
      dirty = dirty || !!r.changed;
    }

    // Persist strategy:
    // - persist if dirty
    // - else persist at most every ~4s (needed for human-visible status freshness)
    const shouldPersist = dirty || (state.runtime.runs % 2 === 0);
    if (shouldPersist) {
      state.runtime.health.state_write_count = (state.runtime.health.state_write_count || 0) + 1;
      state.runtime.last_state_write_ts = now;
      bumpHealthBucket(state, now, "state_write", 1);
      writeJsonAtomic(STATE_PATH, state);
    } else {
      state.runtime.health.state_write_skipped_count = (state.runtime.health.state_write_skipped_count || 0) + 1;
    }

    if (now - started >= stopAfterMs) {
      console.log(`[DONE] run complete (${Math.round(stopAfterMs/1000)}s)`);
      break;
    }

    await sleepMs(Number(cfg.polling?.clob_eval_seconds || 2) * 1000);
  }
} finally {
  try {
    const now = nowMs();
    state.runtime.last_state_write_ts = now;
    bumpHealthBucket(state, now, "state_write", 1);
    writeJsonAtomic(STATE_PATH, state);
  } catch {}
  releaseLock(LOCK_PATH);
}
