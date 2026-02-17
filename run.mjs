#!/usr/bin/env node

import { loadConfig, resolveRunner } from "./src/core/config.js";
import { acquireLock, releaseLock } from "./src/core/lockfile.js";
import { nowMs, sleepMs } from "./src/core/time.js";
import { readJsonWithFallback, writeJsonAtomic, resolvePath } from "./src/core/state_store.js";
import { appendJsonl, loadOpenIndex, saveOpenIndex, addOpen, reconcileIndex } from "./src/core/journal.mjs";
import { reconcileExecutionsFromSignals } from "./src/core/reconcile_journals.mjs";
import { DirtyTracker, detectChanges } from "./src/core/dirty_tracker.mjs";
import { startHealthServer } from "./src/runtime/health_server.mjs";
import { TradeBridge, validateBootConfig } from "./src/execution/trade_bridge.mjs";

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const runner = resolveRunner();
const cfg = loadConfig();
const RUNNER_ID = runner.id;
const IS_SHADOW = !runner.isProd;

// === SHADOW BOOT VALIDATION ===
if (IS_SHADOW) {
  // Ensure state dir exists
  const stateDir = resolvePath("state", ".").replace(/\/+$/, ""); // resolves to state-{id}/
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  
  // Ensure journal subdirs exist
  for (const sub of ["journal", "monitor"]) {
    const p = resolvePath("state", sub);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  // Kill switch: shadow must NEVER have real trading enabled
  if (cfg.trading?.enabled || cfg.trading?.live) {
    console.error(`[SHADOW:${RUNNER_ID}] FATAL: Shadow runner has live trading enabled. Refusing to start.`);
    process.exit(1);
  }

  // Verify state isolation: state dir must NOT be "state/"
  if (stateDir.endsWith("/state") || stateDir === "state") {
    console.error(`[SHADOW:${RUNNER_ID}] FATAL: State dir resolves to prod directory. Refusing to start.`);
    process.exit(1);
  }

  // Port guard: shadow must use a different port than prod default
  const shadowPort = Number(cfg?.health?.port || 3210);
  if (shadowPort === 3210) {
    // Auto-assign based on shadow ID hash
    const hash = createHash("md5").update(RUNNER_ID).digest();
    cfg.health = cfg.health || {};
    cfg.health.port = 3211 + (hash[0] % 50); // 3211-3260 range
    console.log(`[SHADOW:${RUNNER_ID}] Auto-assigned health port: ${cfg.health.port}`);
  }
}

// Save config snapshot at boot (for reproducibility)
{
  const configSnapshot = { ...cfg, _boot_ts: Date.now(), _runner: RUNNER_ID, _pid: process.pid };
  const snapshotPath = resolvePath("state", "config-snapshot.json");
  try { writeFileSync(snapshotPath, JSON.stringify(configSnapshot, null, 2) + "\n"); } catch {}
}

// Log effective paths at boot
console.log(`[BOOT] runner=${RUNNER_ID} shadow=${IS_SHADOW} pid=${process.pid}`);
console.log(`[BOOT] state_dir=${resolvePath("state", ".")} lock=${resolvePath("state", "watchlist.lock")}`);
console.log(`[BOOT] health_port=${cfg?.health?.port || 3210}`);

const BUILD_COMMIT = (() => { try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
const SCHEMA_VERSION = 2;

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
  state = readJsonWithFallback(STATE_PATH) || baseState();
  console.log(`[STATE] Loaded from disk: ${Object.keys(state.watchlist || {}).length} markets, runs=${state.runtime?.runs || 0}`);
  // Reset per-boot counters (keep lifetime data in state but reset session metrics)
  if (state.runtime) {
    state.runtime.runs_since_boot = 0;
    state.runtime.boot_ts = Date.now();
    if (state.runtime.health) {
      state.runtime.health.loop_metrics = null; // Reset histogram + slow loop counters
    }
  }
} catch (e) {
  console.error(`[STATE] Failed to read state, starting fresh: ${e?.message || e}`);
  state = baseState();
}

// Dirty tracker for intelligent persistence
const dirtyTracker = new DirtyTracker();

let running = true;
const shutdown = (sig) => {
  console.log(`[SHUTDOWN] ${sig}`);
  running = false;
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const started = nowMs();
const stopAfterMs = Number(process.env.STOP_AFTER_MS ?? 0); // Default: 0 = run indefinitely. Set >0 for test/debug

// --- Boot quarantine: mark terminal-looking markets to suppress from dashboard ---
// Markets in watchlist.json with bid/ask >= 0.995 may have been saved before
// the 30s anti-flicker confirmation. Instead of purging (which would bypass
// the confirmation window), we quarantine them: hidden from dashboard and
// skipped for depth fetches until the normal loop confirms and purges them.
{
  const TERMINAL_THRESHOLD = 0.995;
  const QUARANTINE_MS = 30_000;
  const now = Date.now();
  let quarantined = 0;
  for (const m of Object.values(state.watchlist || {})) {
    const bid = Number(m?.last_price?.yes_best_bid ?? 0);
    const ask = Number(m?.last_price?.yes_best_ask ?? 0);
    if (bid >= TERMINAL_THRESHOLD || ask >= TERMINAL_THRESHOLD) {
      m._boot_quarantine_until = now + QUARANTINE_MS;
      quarantined++;
    }
  }
  if (quarantined > 0) {
    console.log(`[BOOT] Quarantined ${quarantined} terminal-looking markets for ${QUARANTINE_MS / 1000}s`);
  }
}

// --- Reconcile open_index from signals.jsonl (crash recovery) ---
{
  const idx = loadOpenIndex();
  const result = reconcileIndex(idx);
  if (result.reconciled) {
    saveOpenIndex(idx);
    console.log(`[RECONCILE] Synced open_index from signals.jsonl: added=${result.added} removed=${result.removed} closedAdded=${result.closedAdded} open=${Object.keys(idx.open).length} closed=${Object.keys(idx.closed).length}`);
  } else {
    console.log(`[RECONCILE] open_index in sync (open=${Object.keys(idx.open).length} closed=${Object.keys(idx.closed).length})`);
  }
}

// --- Reconcile executions.jsonl from signals.jsonl (close divergence gaps) ---
{
  const stateDir = resolvePath("state");
  const tradingMode = cfg?.trading?.mode || "paper";
  const recon = reconcileExecutionsFromSignals(stateDir, { mode: tradingMode });
  if (recon.added > 0) {
    console.log(`[RECONCILE] Backfilled ${recon.added} missing sell entries in executions.jsonl (type=trade_reconciled)`);
    for (const item of recon.items) {
      console.log(`  → ${item.slug} (${item.close_reason}) source=${item.source}`);
    }
  }
  if (recon.warnings.length > 0) {
    for (const w of recon.warnings) {
      console.log(`[RECONCILE] WARN: ${w}`);
    }
  }
}

// --- Start health monitoring HTTP server ---
let healthServer = null;
try {
  const healthPort = Number(cfg?.health?.port || 3210);
  const healthHost = String(cfg?.health?.host || "127.0.0.1");
  healthServer = startHealthServer(state, { 
    port: healthPort, 
    host: healthHost, 
    startedMs: started, 
    buildCommit: BUILD_COMMIT 
  });
} catch (e) {
  console.error(`[HEALTH] Failed to start HTTP server: ${e?.message || e}`);
}

// --- Trade Bridge (paper / shadow_live / live) ---
let tradeBridge = null;
{
  // Kill switch: non-paper trading requires NBA gate to be blocking.
  // Per-league overrides (gate_mode_nba, gate_mode_cbb) take precedence over global gate_mode.
  const tradingMode = cfg?.trading?.mode || "paper";
  const globalGateMode = String(cfg?.context?.entry_rules?.gate_mode || "tag_only");
  const nbaGateMode = String(cfg?.context?.entry_rules?.gate_mode_nba ?? globalGateMode);
  if (tradingMode !== "paper" && nbaGateMode !== "blocking") {
    console.error(`[BOOT] FATAL: trading.mode=${tradingMode} requires NBA gate to be blocking (current: "${nbaGateMode}")`);
    console.error(`[BOOT] Fix: set "gate_mode_nba": "blocking" in src/config/local.json under context.entry_rules`);
    process.exit(1);
  }

  const bootCheck = validateBootConfig(cfg);
  if (!bootCheck.valid) {
    const mode = tradingMode;
    if (mode !== "paper") {
      console.error(`[BOOT] FATAL: trading config invalid for mode=${mode}:`);
      bootCheck.errors.forEach(e => console.error(`  - ${e}`));
      process.exit(1);
    }
    if (bootCheck.errors.length) {
      console.log(`[BOOT] Trading config warnings (paper mode, ignored): ${bootCheck.errors.join("; ")}`);
    }
  }
  
  tradeBridge = new TradeBridge(cfg, state);
  const cbbGateMode = String(cfg?.context?.entry_rules?.gate_mode_cbb ?? globalGateMode);
  console.log(`[BOOT] trading.mode=${tradingMode} | gates: nba=${nbaGateMode} cbb=${cbbGateMode} soccer=always | SL=${cfg?.paper?.stop_loss_bid || "none"} | max_pos=$${cfg?.trading?.max_position_usd || "?"}`);
  
  if (tradingMode !== "paper") {
    try {
      const initResult = await tradeBridge.init();
      console.log(`[BOOT] Trade bridge initialized | balance=$${initResult?.balance?.toFixed(2) || "?"}`);
    } catch (e) {
      console.error(`[BOOT] FATAL: Trade bridge init failed: ${e.message}`);
      process.exit(1);
    }
  }
}

try {
  while (running) {
    const loopStartMs = nowMs();
    const now = loopStartMs;
    state.runtime.runs = (state.runtime.runs || 0) + 1;
    state.runtime.runs_since_boot = (state.runtime.runs_since_boot || 0) + 1;
    state.runtime.last_run_ts = now;

    // Initialize loop timing buckets
    const loopTimings = { gamma_ms: 0, eval_ms: 0, journal_ms: 0, resolution_ms: 0, persist_ms: 0 };

    // --- Phase 1: Gamma discovery loop ---
    const lastGamma = Number(state.runtime.last_gamma_fetch_ts || 0);
    const gammaEveryMs = Number(cfg.polling?.gamma_discovery_seconds || 60) * 1000;

    // --- Phase 2: HTTP-only eval loop (/book) ---
    const lastEval = Number(state.runtime.last_eval_ts || 0);
    const evalEveryMs = Number(cfg.polling?.clob_eval_seconds || 3) * 1000;

    if (now - lastGamma >= gammaEveryMs) {
      const gammaStartMs = nowMs();
      const { loopGamma } = await import("./src/runtime/loop_gamma.mjs");
      const { checkAndFixInvariants } = await import("./src/core/invariants.js");

      // Snapshot state before operation
      const beforeWatchlistSize = Object.keys(state.watchlist || {}).length;

      const r = await loopGamma(state, cfg, now);
      checkAndFixInvariants(state, cfg, now);

      state.runtime.last_gamma_fetch_ts = now;
      state.runtime.health.watchlist_total = Object.keys(state.watchlist || {}).length;
      state.runtime.health.loop_gamma_last = r.stats;

      // Mark dirty if watchlist changed or funnel updated
      if (r.changed) {
        const afterWatchlistSize = Object.keys(state.watchlist || {}).length;
        const delta = afterWatchlistSize - beforeWatchlistSize;
        if (delta !== 0) {
          dirtyTracker.mark(`gamma:markets_${delta > 0 ? 'added' : 'removed'}:${Math.abs(delta)}`);
        } else {
          dirtyTracker.mark("gamma:markets_updated");
        }
      } else if (state._funnel) {
        // Funnel data updated even when no market changes — persist it
        dirtyTracker.mark("gamma:funnel_updated");
      }
      
      loopTimings.gamma_ms = nowMs() - gammaStartMs;
    }

    if (now - lastEval >= evalEveryMs) {
      const evalStartMs = nowMs();
      const { loopEvalHttpOnly } = await import("./src/runtime/loop_eval_http_only.mjs");
      const { checkAndFixInvariants } = await import("./src/core/invariants.js");
      const { loopResolutionTracker } = await import("./src/runtime/loop_resolution_tracker.mjs");

      // Snapshot signal buffer before eval (to detect new signals deterministically)
      const prevSignals = Array.isArray(state?.runtime?.last_signals) ? state.runtime.last_signals.slice() : [];

      const r = await loopEvalHttpOnly(state, cfg, now);
      checkAndFixInvariants(state, cfg, now);
      
      loopTimings.eval_ms = nowMs() - evalStartMs;

      // Journal: paper positions for new signals (append-only) + open_index
      const journalStartMs = nowMs();
      try {
        const curSignals = Array.isArray(state?.runtime?.last_signals) ? state.runtime.last_signals : [];
        const prevSet = new Set(prevSignals.map(s => `${Number(s?.ts || 0)}|${String(s?.slug || "")}`));
        const newOnes = curSignals.filter(s => {
          const k = `${Number(s?.ts || 0)}|${String(s?.slug || "")}`;
          return Number(s?.ts || 0) && s?.slug && !prevSet.has(k);
        });

        if (newOnes.length) {
          // Build slug→market index for outcome resolution
          const wlBySlug = new Map();
          for (const m of Object.values(state.watchlist || {})) {
            if (m?.slug) wlBySlug.set(String(m.slug), m);
          }

          const idx = loadOpenIndex();
          for (const s of newOnes) {
            const signalId = `${Number(s.ts)}|${String(s.slug)}`;
            const entryPrice = Number(s.probAsk);
            const paperNotional = Number(cfg?.paper?.notional_usd ?? 10);

            // Derive entry_outcome_name for ALL leagues (not just esports)
            let entryOutcome = null;
            // Try esports derived first
            if (s?.esports?.yes_outcome_name) {
              entryOutcome = String(s.esports.yes_outcome_name);
            }
            // Fallback: derive from watchlist outcomes + clobTokenIds + yes_token_id
            if (!entryOutcome) {
              const wm = wlBySlug.get(String(s.slug || ""));
              if (wm) {
                const outcomes = Array.isArray(wm.outcomes) ? wm.outcomes : (Array.isArray(wm.esports_ctx?.market?.outcomes) ? wm.esports_ctx.market.outcomes : null);
                const clobIds = Array.isArray(wm.tokens?.clobTokenIds) ? wm.tokens.clobTokenIds : null;
                const yesId = wm.tokens?.yes_token_id;
                if (outcomes && clobIds && yesId && outcomes.length === 2 && clobIds.length === 2) {
                  const yesIdx = clobIds.findIndex(x => String(x) === String(yesId));
                  if (yesIdx >= 0) entryOutcome = String(outcomes[yesIdx]);
                }
              }
            }

            // Get market title for readability
            const marketTitle = (() => {
              const wm = wlBySlug.get(String(s.slug || ""));
              return wm?.title || wm?.question || null;
            })();

            appendJsonl("state/journal/signals.jsonl", {
              type: "signal_open",
              runner_id: RUNNER_ID,
              schema_version: SCHEMA_VERSION,
              build_commit: BUILD_COMMIT,
              signal_id: signalId,
              ts_open: Number(s.ts),
              slug: String(s.slug),
              title: marketTitle,
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
              title: marketTitle,
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
              tp_math_reason: String(s.tp_math_reason || "no_data"),
              // Context entry gate snapshot (for resolution analysis)
              context_entry: s.ctx?.entry_gate ? {
                win_prob: s.ctx.entry_gate.win_prob ?? null,
                margin_for_yes: s.ctx.entry_gate.margin_for_yes ?? null,
                entry_allowed: s.ctx.entry_gate.entry_allowed ?? null,
                entry_blocked_reason: s.ctx.entry_gate.entry_blocked_reason ?? null,
                ev_edge: s.ctx.entry_gate.ev_edge ?? null,
              } : null
            });
            // Human-readable log
            console.log(`[SIGNAL] ${String(s.league || "").toUpperCase()} | ${marketTitle || s.slug} | ${entryOutcome || "?"} @ ${entryPrice.toFixed(2)} | spread=${Number(s.spread).toFixed(3)} | ${String(s.signal_type || "")}`);
          }
          saveOpenIndex(idx);

          // === TRADE BRIDGE: execute buys for new signals ===
          if (tradeBridge && tradeBridge.mode !== "paper") {
            for (const s of newOnes) {
              const wm = wlBySlug.get(String(s.slug || ""));
              const yesToken = wm?.tokens?.yes_token_id;
              const entryPrice = Number(s.probAsk);
              const signalId = `${s.ts}|${s.slug}`;
              try {
                await tradeBridge.handleSignalOpen({
                  signal_id: signalId,
                  slug: String(s.slug || ""),
                  entry_price: entryPrice,
                  yes_token: yesToken,
                  league: String(s.league || ""),
                });
              } catch (e) {
                console.error(`[TRADE_BRIDGE] buy error for ${s.slug}: ${e.message}`);
              }
            }
          }

          // Mark CRITICAL dirty: new paper positions opened (must persist immediately)
          dirtyTracker.mark(`eval:signals_generated:${newOnes.length}`, true);
        }
      } catch {}

      // === LIVE POSITION CHECK: SL + resolution using CLOB/WS prices (every 2s) ===
      // Gamma is NOT used for any trading decisions in live mode.
      if (tradeBridge && tradeBridge.mode !== "paper") {
        try {
          // Build price map from watchlist state (updated by WS/HTTP in eval loop)
          const pricesBySlug = new Map();
          for (const m of Object.values(state.watchlist || {})) {
            if (m?.slug && m?.last_price) {
              pricesBySlug.set(m.slug, m.last_price);
            }
          }
          const closeSignals = tradeBridge.checkPositionsFromCLOB(pricesBySlug);
          for (const sig of closeSignals) {
            try {
              const { appendJsonl } = await import("./src/core/journal.mjs");
              appendJsonl("state/journal/signals.jsonl", {
                ...sig,
                runner_id: process.env.SHADOW_ID || "prod",
                source: "clob_position_check",
              });
              const sellResult = await tradeBridge.handleSignalClose(sig);

              // Update open_index immediately after sell
              if (sellResult && sellResult.ok) {
                try {
                  const idx = loadOpenIndex();
                  const entry = idx.open?.[sig.signal_id];
                  if (entry && !entry.close_status) {
                    if (!sellResult.isPartial) {
                      // Full fill → close immediately
                      const buyKey = `buy:${sig.signal_id}`;
                      const buyTrade = tradeBridge.execState.trades[buyKey];
                      const receivedUsd = sellResult.spentUsd ?? 0;
                      const spentUsd = buyTrade?.spentUsd ?? 0;
                      const pnl = receivedUsd - spentUsd;
                      const roi = spentUsd > 0 ? pnl / spentUsd : 0;

                      addClosed(idx, sig.signal_id, {
                        slug: entry.slug, title: entry.title || null,
                        ts_open: entry.ts_open, ts_close: Date.now(),
                        league: entry.league || "",
                        entry_price: entry.entry_price,
                        paper_notional_usd: entry.paper_notional_usd,
                        entry_outcome_name: entry.entry_outcome_name || null,
                        close_reason: sig.close_reason || "resolved",
                        resolve_method: "clob_position_check",
                        win: pnl >= 0,
                        pnl_usd: Math.round(pnl * 100) / 100,
                        roi: Math.round(roi * 10000) / 10000,
                        price_provisional: sellResult.priceProvisional || false,
                      });
                      removeOpen(idx, sig.signal_id);
                      saveOpenIndex(idx);
                      console.log(`[CLOSED] ${sig.slug} | full fill | PnL=$${pnl.toFixed(2)}${sellResult.priceProvisional ? " (provisional)" : ""}`);
                    } else {
                      // Partial fill → mark pending, reconcile later
                      entry.close_status = "sell_executed";
                      entry.close_ts = Date.now();
                      entry.close_reason = sig.close_reason || "unknown";
                      entry.close_fill = {
                        filledShares: sellResult.filledShares ?? 0,
                        avgFillPrice: sellResult.avgFillPrice ?? null,
                        receivedUsd: sellResult.spentUsd ?? null,
                        isPartial: true,
                        orderID: sellResult.orderID || null,
                        priceProvisional: sellResult.priceProvisional || false,
                      };
                      saveOpenIndex(idx);
                      console.log(`[CLOSE_PENDING] ${sig.slug} | partial fill (${sellResult.filledShares} shares) | awaiting reconciliation`);
                    }
                  }
                } catch (idxErr) {
                  console.error(`[CLOSE_UPDATE] failed to update open_index for ${sig.slug}: ${idxErr.message}`);
                }
              }
            } catch (e) {
              console.error(`[POSITION_CHECK] sell error for ${sig.slug}: ${e.message}`);
            }
          }
        } catch (e) {
          console.error(`[POSITION_CHECK] error: ${e.message}`);
        }
      }

      loopTimings.journal_ms = nowMs() - journalStartMs;

      // Resolve paper positions (cheap: only open signals)
      const resolutionStartMs = nowMs();
      let resolutionClosedSignals = []; // capture closes for trade bridge
      try {
        const lastRes = Number(state.runtime?.last_resolution_ts || 0);
        const everyResMs = Number(cfg?.paper?.resolution_poll_seconds ?? 60) * 1000;
        if (!lastRes || (now - lastRes) >= everyResMs) {
          await loopResolutionTracker(cfg, state);
          state.runtime.last_resolution_ts = now;
          
          // === TRADE BRIDGE: execute sells for closed signals ===
          // Read recent closes from signals.jsonl (last 20 lines) to find new closes
          if (tradeBridge && tradeBridge.mode !== "paper") {
            try {
              const { readFileSync } = await import("node:fs");
              const raw = readFileSync("state/journal/signals.jsonl", "utf8");
              const lines = raw.trim().split("\n").slice(-20);
              for (const line of lines) {
                try {
                  const obj = JSON.parse(line);
                  if (obj.type === "signal_close" && obj.ts_close && (now - obj.ts_close) < 120000) {
                    await tradeBridge.handleSignalClose(obj);
                  }
                } catch {}
              }
            } catch {}
            
            // Periodic reconciliation
            await tradeBridge.reconcilePositions();

            // === Reconcile close_pending entries in open_index ===
            // Check if on-chain position is zero → move to closed
            try {
              const idx = loadOpenIndex();
              const pending = Object.entries(idx.open).filter(([_, e]) => e.close_status === "sell_executed");
              let idxChanged = false;
              for (const [sigId, entry] of pending) {
                const buyKey = `buy:${sigId}`;
                const buyTrade = tradeBridge.execState.trades[buyKey];
                if (!buyTrade?.tokenId) continue;

                try {
                  const { getConditionalBalance: getCondBal, fetchRealFillPrice: fetchReal } = await import("./src/execution/order_executor.mjs");
                  const balance = await getCondBal(tradeBridge.client, buyTrade.tokenId);

                  if (balance >= 0.01) {
                    // Position still open — partial fill or resting order
                    continue;
                  }

                  // Position confirmed zero on-chain
                  const fill = entry.close_fill || {};

                  // Try to reconcile real fill price if still provisional
                  let exitPrice = fill.avgFillPrice;
                  let priceStillProvisional = fill.priceProvisional || false;
                  if (priceStillProvisional && fill.orderID) {
                    try {
                      const real = await fetchReal(tradeBridge.client, fill.orderID, { maxRetries: 1, delayMs: 300 });
                      if (real != null) {
                        exitPrice = real;
                        priceStillProvisional = false;
                        console.log(`[RECONCILE_PRICE] ${entry.slug} | real avg=${real.toFixed(4)}`);
                      }
                    } catch {}
                  }

                  const filledShares = fill.filledShares || 0;
                  const receivedUsd = exitPrice != null && filledShares > 0
                    ? filledShares * exitPrice : (fill.receivedUsd ?? 0);
                  const spentUsd = buyTrade.spentUsd || 0;
                  const pnl = receivedUsd - spentUsd;
                  const roi = spentUsd > 0 ? pnl / spentUsd : 0;

                  addClosed(idx, sigId, {
                    slug: entry.slug,
                    title: entry.title || null,
                    ts_open: entry.ts_open,
                    ts_close: entry.close_ts || Date.now(),
                    league: entry.league || "",
                    entry_price: entry.entry_price,
                    paper_notional_usd: entry.paper_notional_usd,
                    entry_outcome_name: entry.entry_outcome_name || null,
                    close_reason: entry.close_reason || "resolved",
                    resolve_method: "clob_position_check",
                    win: pnl >= 0,
                    pnl_usd: Math.round(pnl * 100) / 100,
                    roi: Math.round(roi * 10000) / 10000,
                    price_provisional: priceStillProvisional,
                  });
                  removeOpen(idx, sigId);
                  idxChanged = true;
                  console.log(`[CLOSE_CONFIRMED] ${entry.slug} | on-chain balance=0 | PnL=$${pnl.toFixed(2)}${priceStillProvisional ? " (provisional)" : ""}`);
                } catch (e) {
                  console.error(`[CLOSE_RECONCILE] error checking ${entry.slug}: ${e.message}`);
                }
              }
              if (idxChanged) saveOpenIndex(idx);
            } catch (e) {
              console.error(`[CLOSE_RECONCILE] error: ${e.message}`);
            }
          }
        }
      } catch {}
      
      // Reconcile: signaled markets without open paper position → expired
      // Prevents "stuck signaled" when paper trade closes but watchlist status never updates
      try {
        const { loadOpenIndex } = await import("./src/core/journal.mjs");
        const openIdx = loadOpenIndex();
        const openSlugs = new Set(Object.values(openIdx.open || {}).map(p => p.slug));
        const SIGNALED_ORPHAN_GRACE_MS = 120000; // 2min grace after resolve
        
        for (const [key, m] of Object.entries(state.watchlist || {})) {
          if (m.status !== "signaled") continue;
          if (openSlugs.has(m.slug)) continue; // Still has open position — leave it
          
          // Grace period: don't expire immediately (resolution tracker may need a cycle)
          const resolvedTs = m.tokens?.resolved_ts || 0;
          if (resolvedTs && (now - resolvedTs) > SIGNALED_ORPHAN_GRACE_MS) {
            m.status = "expired";
            m.expired_at_ts = now;
            m.expired_reason = "signaled_orphan_reconciled";
            state.runtime.health.signaled_orphan_reconciled = (state.runtime.health.signaled_orphan_reconciled || 0) + 1;
            console.log(`[RECONCILE] ${m.slug} | signaled without paper position | resolved ${((now - resolvedTs)/60000).toFixed(0)}min ago`);
          }
        }
      } catch {}
      
      loopTimings.resolution_ms = nowMs() - resolutionStartMs;

      // Expose trade bridge status on state for health endpoint
      if (tradeBridge) {
        state.runtime.trade_bridge = tradeBridge.getStatus();
      }

      state.runtime.last_eval_ts = now;

      // Mark dirty if eval changed state (status transitions, etc.)
      if (r.changed) {
        dirtyTracker.mark("eval:state_changed");
      }
    }

    // Persist strategy (v2: dirty tracking with fsync + backup):
    // - ALWAYS persist critical changes immediately (new signals, resolutions)
    // - Otherwise persist if dirty AND >= 5s since last write (throttled)
    // - Skip persist if not dirty and throttle window not elapsed
    const shouldPersist = dirtyTracker.shouldPersist(now, { throttleMs: 5000 });
    
    if (shouldPersist) {
      const persistStartMs = nowMs();
      state.runtime.health.state_write_count = (state.runtime.health.state_write_count || 0) + 1;
      state.runtime.last_state_write_ts = now;
      bumpHealthBucket(state, now, "state_write", 1);

      // Prepare state for serialization: exclude non-serializable runtime objects
      const wsClient = state.runtime?.wsClient;
      if (wsClient) delete state.runtime.wsClient;

      // Size guardrail: warn if state exceeds 1MB (regression detection)
      const stateJson = JSON.stringify(state);
      const stateSizeKB = Math.round(stateJson.length / 1024);
      if (stateJson.length > 1_000_000) {
        const runtimeKB = Math.round(JSON.stringify(state.runtime || {}).length / 1024);
        const cacheKB = Math.round(JSON.stringify(state.runtime?.context_cache || {}).length / 1024);
        console.warn(`[SIZE_WARN] watchlist.json=${stateSizeKB}KB (runtime=${runtimeKB}KB, cache=${cacheKB}KB) — exceeds 1MB guardrail`);
        state.runtime.health.state_size_warn_count = (state.runtime.health.state_size_warn_count || 0) + 1;
        bumpHealthBucket(state, now, "state_size_warn", 1);
      }

      // Write with atomic tmp+rename + fsync + backup
      writeJsonAtomic(STATE_PATH, state);
      
      // Restore wsClient after persist
      if (wsClient) state.runtime.wsClient = wsClient;
      
      // Debug: log reasons for observability (BEFORE clear, or reasons are lost)
      const reasons = dirtyTracker.getReasons();
      const wasCritical = dirtyTracker.isCritical();
      
      dirtyTracker.clear(now);

      if (reasons.length > 0 && wasCritical) {
        console.log(`[PERSIST] Critical write: ${reasons.join(", ")}`);
      }
      
      loopTimings.persist_ms = nowMs() - persistStartMs;
    } else {
      state.runtime.health.state_write_skipped_count = (state.runtime.health.state_write_skipped_count || 0) + 1;
    }

    // === Loop Performance Metrics ===
    const loopEndMs = nowMs();
    const loopTotalMs = loopEndMs - loopStartMs;
    
    // Initialize loop metrics in health
    if (!state.runtime.health.loop_metrics) {
      state.runtime.health.loop_metrics = {
        histogram: { "0-500ms": 0, "500-1000ms": 0, "1000-2000ms": 0, "2000-3000ms": 0, "3000-5000ms": 0, "5000ms+": 0 },
        slow_loops: 0,
        very_slow_loops: 0,
        last_loop_ms: 0,
        last_breakdown: {}
      };
    }
    
    const metrics = state.runtime.health.loop_metrics;
    metrics.last_loop_ms = loopTotalMs;
    metrics.last_breakdown = loopTimings;
    
    // Update histogram
    if (loopTotalMs < 500) metrics.histogram["0-500ms"]++;
    else if (loopTotalMs < 1000) metrics.histogram["500-1000ms"]++;
    else if (loopTotalMs < 2000) metrics.histogram["1000-2000ms"]++;
    else if (loopTotalMs < 3000) metrics.histogram["2000-3000ms"]++;
    else if (loopTotalMs < 5000) metrics.histogram["3000-5000ms"]++;
    else metrics.histogram["5000ms+"]++;
    
    // Slow loop detection & logging (with memory metrics)
    if (loopTotalMs >= 3000) {
      const mem = process.memoryUsage();
      const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
      const externalMB = Math.round(mem.external / 1024 / 1024);
      const marketCount = Object.keys(state.watchlist || {}).length;
      
      const tag = loopTotalMs >= 5000 ? 'VERY_SLOW_LOOP' : 'SLOW_LOOP';
      if (loopTotalMs >= 5000) metrics.very_slow_loops++;
      else metrics.slow_loops++;
      console.warn(`[${tag}] ${loopTotalMs}ms | gamma=${loopTimings.gamma_ms}ms eval=${loopTimings.eval_ms}ms journal=${loopTimings.journal_ms}ms resolution=${loopTimings.resolution_ms}ms persist=${loopTimings.persist_ms}ms | markets=${marketCount} heapUsed=${heapMB}MB heapTotal=${heapTotalMB}MB external=${externalMB}MB`);
    }

    if (stopAfterMs > 0 && now - started >= stopAfterMs) {
      console.log(`[DONE] run complete (${Math.round(stopAfterMs/1000)}s)`);
      break;
    }

    // Daily snapshot (every 5 minutes)
    if (!state.runtime._lastSnapshotTs || (now - state.runtime._lastSnapshotTs) >= 300_000) {
      try {
        const { buildDailySnapshot } = await import("./src/metrics/daily_snapshot.mjs");
        buildDailySnapshot(state, cfg);
        state.runtime._lastSnapshotTs = now;
      } catch (e) {
        console.warn(`[SNAPSHOT] Error: ${e?.message || e}`);
      }
    }

    await sleepMs(Number(cfg.polling?.clob_eval_seconds || 2) * 1000);
  }
} finally {
  try {
    const now = nowMs();
    state.runtime.last_state_write_ts = now;
    bumpHealthBucket(state, now, "state_write", 1);
    console.log("[PERSIST] Shutdown: writing final state...");
    
    // Exclude non-serializable runtime objects
    const wsClient = state.runtime?.wsClient;
    if (wsClient) {
      delete state.runtime.wsClient;
      wsClient.close(); // Clean shutdown of WebSocket
    }
    
    writeJsonAtomic(STATE_PATH, state);
    console.log("[PERSIST] Shutdown complete");
  } catch (e) {
    console.error(`[PERSIST] Shutdown write failed: ${e?.message || e}`);
  }

  // Close health server
  if (healthServer?.server) {
    try {
      healthServer.server.close();
      console.log("[HEALTH] HTTP server closed");
    } catch (e) {
      console.error(`[HEALTH] Failed to close server: ${e?.message || e}`);
    }
  }

  releaseLock(LOCK_PATH);
}
