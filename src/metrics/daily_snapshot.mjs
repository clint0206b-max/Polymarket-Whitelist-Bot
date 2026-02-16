/**
 * Daily Snapshot — persists a compact summary per day for historical analysis.
 * Written every 5min, overwrites same-day file. No JSONL parsing needed for review.
 * 
 * File: state/snapshots/YYYY-MM-DD.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function stateDir() {
  const sid = process.env.SHADOW_ID;
  return sid ? `state-${sid}` : "state";
}

function snapshotDir() {
  const dir = resolve(process.cwd(), stateDir(), "snapshots");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonlSafe(path) {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

export function buildDailySnapshot(state, cfg) {
  const now = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayStart = new Date(todayStr + "T00:00:00Z").getTime();

  // Read signals
  const signalsPath = resolve(process.cwd(), stateDir(), "journal", "signals.jsonl");
  const signals = readJsonlSafe(signalsPath);

  // Trades
  const closes = signals.filter(s => s.type === "signal_close");
  const closesToday = closes.filter(s => (s.ts_close || 0) >= todayStart);
  const wins = closesToday.filter(s => s.win === true);
  const losses = closesToday.filter(s => s.win === false);
  const pnlToday = closesToday.reduce((sum, s) => sum + (s.pnl_usd || 0), 0);
  const pnlTotal = closes.reduce((sum, s) => sum + (s.pnl_usd || 0), 0);

  // Timeouts
  const timeouts = signals.filter(s => s.type === "signal_timeout");
  const toResolved = signals.filter(s => s.type === "timeout_resolved");

  // Watchlist status counts
  const wl = state?.watchlist || {};
  const statusCounts = {};
  for (const m of Object.values(wl)) {
    const s = m?.status || "unknown";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }

  // Open positions
  let openCount = 0;
  try {
    const idxPath = resolve(process.cwd(), stateDir(), "journal", "open_index.json");
    if (existsSync(idxPath)) {
      const idx = JSON.parse(readFileSync(idxPath, "utf8"));
      openCount = Object.keys(idx?.open || {}).length;
    }
  } catch {}

  // Top reject reasons from health
  const health = state?.runtime?.health || {};
  const rejectReasons = {};
  for (const m of Object.values(wl)) {
    const lr = m?.last_reject?.reason;
    if (lr && m.status === "watching") {
      rejectReasons[lr] = (rejectReasons[lr] || 0) + 1;
    }
  }
  const topRejects = Object.entries(rejectReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  // Daily events summary by league
  const leagueSummary = {};
  try {
    const dePath = resolve(process.cwd(), stateDir(), "daily_events.json");
    if (existsSync(dePath)) {
      const de = JSON.parse(readFileSync(dePath, "utf8"));
      const dayData = de[todayStr] || {};
      for (const [league, events] of Object.entries(dayData)) {
        const entries = Object.values(events);
        leagueSummary[league] = {
          events: entries.length,
          with_quote: entries.filter(e => e.had_quote).length,
          with_tradeable: entries.filter(e => e.had_tradeable).length,
          with_signal: entries.filter(e => e.had_signal).length,
        };
      }
    }
  } catch {}

  // Loop performance
  const loopPerf = {
    runs_since_boot: health.runs_since_boot || state?.runtime?.runs_since_boot || 0,
    slow_loops: health.slow_loop_count || 0,
    avg_cycle_ms: health.loop_avg_ms || null,
  };

  const snapshot = {
    date: todayStr,
    generated_at: now,
    runner_id: process.env.SHADOW_ID || "prod",

    trades: {
      today: closesToday.length,
      wins: wins.length,
      losses: losses.length,
      pnl_today: Number(pnlToday.toFixed(2)),
      pnl_total: Number(pnlTotal.toFixed(2)),
      wr: (wins.length + losses.length) > 0
        ? Number(((wins.length / (wins.length + losses.length)) * 100).toFixed(1))
        : null,
    },

    positions_open: openCount,

    timeouts: {
      total: timeouts.length,
      resolved: toResolved.length,
      saved_us: toResolved.filter(s => s.verdict === "filter_saved_us").length,
      cost_us: toResolved.filter(s => s.verdict === "filter_cost_us").length,
    },

    watchlist: statusCounts,
    top_reject_reasons: topRejects,
    league_summary: leagueSummary,
    loop: loopPerf,
  };

  // Write snapshot
  const outPath = resolve(snapshotDir(), `${todayStr}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
}
