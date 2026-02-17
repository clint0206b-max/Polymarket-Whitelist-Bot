/**
 * Health Monitoring HTTP Server
 * 
 * Exposes runtime metrics via lightweight HTTP endpoint for monitoring/alerting.
 * 
 * Design:
 * - Single endpoint: GET /health → JSON response
 * - No authentication (local-only, binds to 127.0.0.1)
 * - No state mutation (read-only view of runtime state)
 * - No sensitive data (watchlist details, tokens, credentials)
 * 
 * Usage:
 *   curl http://localhost:3210/health | jq
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function nowMs() {
  return Date.now();
}

// --- Simple TTL cache for file reads ---
const _fileCache = new Map();
function cachedReadJson(path, ttlMs = 3000) {
  const cached = _fileCache.get(path);
  if (cached && (Date.now() - cached.ts) < ttlMs) return cached.data;
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    _fileCache.set(path, { data, ts: Date.now() });
    return data;
  } catch { return null; }
}

function cachedReadJsonl(path, ttlMs = 3000) {
  const cached = _fileCache.get(path + ":jsonl");
  if (cached && (Date.now() - cached.ts) < ttlMs) return cached.data;
  try {
    if (!existsSync(path)) return { items: [], parse_errors: 0 };
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    const data = [];
    let parseErrors = 0;
    for (const l of lines) {
      try { data.push(JSON.parse(l)); } catch { parseErrors++; }
    }
    const result = { items: data, parse_errors: parseErrors };
    _fileCache.set(path + ":jsonl", { data: result, ts: Date.now() });
    return result;
  } catch { return { items: [], parse_errors: 0 }; }
}

function stateDir() {
  const sid = process.env.SHADOW_ID;
  return sid ? `state-${sid}` : "state";
}

function statePath(...parts) {
  return resolve(process.cwd(), stateDir(), ...parts);
}

/**
 * Compute staleness metrics for signaled markets.
 * 
 * @param {object} state - runtime state
 * @param {number} now - current timestamp (ms)
 * @returns {object} - { percent_stale, max_stale_seconds, stale_count, signaled_count }
 */
function computeStaleness(state, now) {
  const wl = state?.watchlist || {};
  const signaled = Object.values(wl).filter(m => m?.status === "signaled");

  if (signaled.length === 0) {
    return { percent_stale: 0, max_stale_seconds: 0, stale_count: 0, signaled_count: 0 };
  }

  const staleThresholdMs = 60000; // 1 minute
  let staleCount = 0;
  let maxStaleMs = 0;

  for (const m of signaled) {
    const lastUpdate = m?.last_price?.updated_ts || 0;
    const ageMs = now - lastUpdate;
    if (ageMs > staleThresholdMs) {
      staleCount++;
    }
    maxStaleMs = Math.max(maxStaleMs, ageMs);
  }

  return {
    percent_stale: (staleCount / signaled.length) * 100,
    max_stale_seconds: Math.round(maxStaleMs / 1000),
    stale_count: staleCount,
    signaled_count: signaled.length
  };
}

/**
 * Compute HTTP success rate over recent buckets.
 * 
 * @param {object} state - runtime state
 * @returns {object} - { success_rate, success_count, fail_count, total_count }
 */
function computeHttpSuccessRate(state) {
  const health = state?.runtime?.health || {};
  const successCount = health.http_fallback_success_count || 0;
  const failCount = health.http_fallback_fail_count || 0;
  const total = successCount + failCount;

  const successRate = total > 0 ? (successCount / total) * 100 : 100;

  return {
    success_rate: successRate,
    success_count: successCount,
    fail_count: failCount,
    total_count: total
  };
}

/**
 * Compute average cycle duration from recent health buckets.
 * 
 * @param {object} state - runtime state
 * @returns {number|null} - average cycle duration in ms, or null if no data
 */
function computeAvgCycleDuration(state) {
  // For now, return null (needs instrumentation in loop)
  // Future: track cycle_start_ts / cycle_end_ts in loop
  return null;
}

/**
 * Compute league breakdown (counts by league).
 * 
 * @param {object} state - runtime state
 * @returns {object} - { league: count }
 */
function computeLeagueBreakdown(state) {
  const wl = state?.watchlist || {};
  const counts = {};

  for (const m of Object.values(wl)) {
    if (m?.status === "expired" || m?.status === "ignored") continue; // skip inactive
    const league = m?.league || "unknown";
    counts[league] = (counts[league] || 0) + 1;
  }

  return counts;
}

/**
 * Compute reject reasons distribution (top 5 + other).
 * 
 * Uses aggregated counters from runtime.health.reject_counts_last_cycle.
 * 
 * @param {object} state - runtime state
 * @returns {object} - { top5: Array, other_count: number }
 */
function computeRejectReasons(state) {
  // Use cumulative reject counts (monotonically increasing, stable for dashboard)
  const counts = state?.runtime?.health?.reject_counts_cumulative || {};

  const entries = Object.entries(counts)
    .filter(([r]) => r !== "signaled" && r !== "pending_entered") // exclude non-reject statuses
    .map(([reason, count]) => ({ reason, count }));
  entries.sort((a, b) => b.count - a.count);

  const top5 = entries.slice(0, 5);
  const otherCount = entries.slice(5).reduce((sum, e) => sum + e.count, 0);

  return { top5, other_count: otherCount };
}

/**
 * Compute active-now league summary from watchlist (snapshot).
 */
function computeLeagueSummary(state) {
  const wl = state?.watchlist || {};
  const leagues = {};
  for (const m of Object.values(wl)) {
    if (!m) continue;
    const l = m.league || "unknown";
    if (!leagues[l]) leagues[l] = { total: 0, watching: 0, signaled: 0, pending_signal: 0, expired: 0 };
    leagues[l].total++;
    const s = m.status || "unknown";
    if (leagues[l][s] !== undefined) leagues[l][s]++;
  }
  return leagues;
}

/**
 * Compute daily utilization from signals.jsonl + watchlist.
 * Cached for 30s to avoid reparsing every health request.
 */
/**
 * Build universe funnel: gamma_available → watchlisted → signaled (all unique slugs per day)
 */
function buildUniverseFunnel(state) {
  // Try runtime Sets first (live), fallback to persisted arrays (after restart)
  const live = state?.runtime?._funnel;
  const persisted = state?._funnel;
  const funnel = live || persisted;
  if (!funnel) return null;

  const sizeOf = (v) => {
    if (v instanceof Set) return v.size;
    if (Array.isArray(v)) return v.length;
    return 0;
  };

  const du = computeDailyUtilization(state);

  const allLeagues = new Set([
    ...Object.keys(funnel.gamma_seen || {}),
    ...Object.keys(funnel.watchlisted || {}),
    ...Object.keys(du || {}),
  ]);

  const result = {};
  for (const league of allLeagues) {
    const available = sizeOf(funnel.gamma_seen?.[league]);
    const watchlisted = sizeOf(funnel.watchlisted?.[league]);
    const signaled = du?.[league]?.signaled || 0;

    result[league] = {
      available,
      watchlisted,
      signaled,
      passed: Math.max(0, available - signaled),
      capture_pct: available > 0 ? Math.round((signaled / available) * 1000) / 10 : 0,
      filter_pct: available > 0 ? Math.round((watchlisted / available) * 1000) / 10 : 0,
    };
  }

  return { day: funnel._day, by_league: result };
}

let _dailyUtilCache = { ts: 0, data: null };
const DAILY_UTIL_CACHE_MS = 30000;

function computeDailyUtilization(state) {
  const now = Date.now();
  if (_dailyUtilCache.data && (now - _dailyUtilCache.ts) < DAILY_UTIL_CACHE_MS) {
    return _dailyUtilCache.data;
  }

  // Day boundary: local Mendoza (UTC-3)
  const localNow = new Date(now - 3 * 3600 * 1000);
  const dayStr = localNow.toISOString().slice(0, 10);
  const dayStartUtc = new Date(dayStr + "T03:00:00Z").getTime(); // 00:00 Mendoza = 03:00 UTC

  // Parse signals.jsonl
  const signalsPath = statePath("journal", "signals.jsonl");
  const { items: signals } = cachedReadJsonl(signalsPath, 5000);

  // Build signal_id → league lookup from opens
  const leagueBySignalId = {};
  for (const s of signals) {
    if (s.type === "signal_open" && s.signal_id && s.league) {
      leagueBySignalId[s.signal_id] = s.league;
    }
  }

  // Per-league accumulators
  const byLeague = {};
  const ensure = (l) => {
    if (!byLeague[l]) byLeague[l] = {
      discovered_slugs: new Set(),
      signaled_slugs: new Set(),
      wins: 0, losses: 0, timeouts: 0,
      pnl: 0, timeout_cost: 0, timeout_saved: 0,
    };
    return byLeague[l];
  };

  // 1. Discovered from watchlist: markets with first_seen_ts today (still alive)
  const wl = state?.watchlist || {};
  for (const m of Object.values(wl)) {
    if (!m) continue;
    const l = m.league || "unknown";
    if (m.first_seen_ts && m.first_seen_ts >= dayStartUtc) {
      ensure(l).discovered_slugs.add(m.slug);
    }
  }

  // 2. From signals.jsonl: events today enrich both discovered and signaled
  for (const s of signals) {
    const ts = s.ts_open || s.ts_close || s.ts || s.resolve_ts || 0;
    if (ts < dayStartUtc) continue;

    const league = s.league || leagueBySignalId[s.signal_id] || "unknown";
    const d = ensure(league);

    if (s.type === "signal_open") {
      d.signaled_slugs.add(s.slug);
      d.discovered_slugs.add(s.slug); // signaled ⊂ discovered
    } else if (s.type === "signal_close") {
      if (s.win === true) { d.wins++; d.pnl += (s.pnl_usd || 0); }
      else if (s.win === false) { d.losses++; d.pnl += (s.pnl_usd || 0); }
    } else if (s.type === "signal_timeout") {
      d.timeouts++;
      if (s.slug) d.discovered_slugs.add(s.slug); // timed out = was discovered
    } else if (s.type === "timeout_resolved") {
      if (s.verdict === "filter_saved_us") d.timeout_saved++;
      else if (s.verdict === "filter_cost_us") d.timeout_cost++;
    }
  }

  // Build result: passed = discovered - signaled (derived)
  const result = {};
  for (const [league, d] of Object.entries(byLeague)) {
    const discovered = d.discovered_slugs.size;
    const signaled = d.signaled_slugs.size;
    const passed = discovered - signaled;
    const conversion = discovered > 0 ? Math.round((signaled / discovered) * 1000) / 10 : 0;
    result[league] = {
      discovered,
      signaled,
      passed,
      conversion_pct: conversion,
      wins: d.wins,
      losses: d.losses,
      pnl: Math.round(d.pnl * 100) / 100,
      timeouts: d.timeouts,
      timeout_saved: d.timeout_saved,
      timeout_cost: d.timeout_cost,
    };
  }

  _dailyUtilCache = { ts: now, data: result };
  return result;
}

/**
 * Compute time in status for signaled and pending markets (top N).
 * 
 * @param {object} state - runtime state
 * @param {number} now - current timestamp (ms)
 * @param {number} topN - how many to return
 * @returns {object} - { signaled: Array, pending: Array }
 */
function computeTimeInStatus(state, now, topN = 5) {
  const wl = state?.watchlist || {};

  const signaled = [];
  const pending = [];

  for (const m of Object.values(wl)) {
    const statusSinceTs = m?.status_since_ts || m?.first_seen_ts || 0;
    if (!statusSinceTs) continue;

    const ageSeconds = Math.round((now - statusSinceTs) / 1000);

    if (m?.status === "signaled") {
      signaled.push({ age_seconds: ageSeconds, league: m?.league || "unknown" });
    } else if (m?.status === "pending_signal") {
      pending.push({ age_seconds: ageSeconds, league: m?.league || "unknown" });
    }
  }

  // Sort by age desc (oldest first)
  signaled.sort((a, b) => b.age_seconds - a.age_seconds);
  pending.sort((a, b) => b.age_seconds - a.age_seconds);

  return {
    signaled: signaled.slice(0, topN),
    pending: pending.slice(0, topN)
  };
}

/**
 * Build health response object.
 * 
 * @param {object} state - runtime state
 * @param {number} startedMs - bot startup timestamp
 * @param {string} buildCommit - git commit hash
 * @returns {object} - health response
 */
export function buildHealthResponse(state, startedMs, buildCommit) {
  const now = nowMs();
  const uptimeSeconds = Math.round((now - startedMs) / 1000);

  const health = state?.runtime?.health || {};
  const wl = state?.watchlist || {};

  // Status counts
  const statusCounts = {};
  for (const m of Object.values(wl)) {
    const status = m?.status || "unknown";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  // Staleness
  const staleness = computeStaleness(state, now);

  // HTTP stats
  const httpStats = computeHttpSuccessRate(state);

  // Loop stats
  const lastCycleTs = state?.runtime?.last_run_ts || 0;
  const lastCycleAgeSeconds = lastCycleTs ? Math.round((now - lastCycleTs) / 1000) : null;

  // Persistence stats
  const lastWriteTs = state?.runtime?.last_state_write_ts || 0;
  const lastWriteAgeSeconds = lastWriteTs ? Math.round((now - lastWriteTs) / 1000) : null;

  // Reject reasons distribution
  const rejectReasons = computeRejectReasons(state);

  // League breakdown
  const leagueBreakdown = computeLeagueBreakdown(state);

  // Time in status (signaled/pending top 5)
  const timeInStatus = computeTimeInStatus(state, now, 5);

  return {
    status: "ok", // always "ok" if server is responding
    runner_id: process.env.SHADOW_ID || "prod",
    is_shadow: !!process.env.SHADOW_ID,
    timestamp: now,
    uptime_seconds: uptimeSeconds,
    pid: process.pid,
    build_commit: buildCommit || "unknown",
    state_dir: process.env.SHADOW_ID ? `state-${process.env.SHADOW_ID}` : "state",

    loop: {
      runs: state?.runtime?.runs || 0,
      last_cycle_ts: lastCycleTs || null,
      last_cycle_age_seconds: lastCycleAgeSeconds,
      cycle_duration_ms_avg: computeAvgCycleDuration(state),
      performance: state?.runtime?.health?.loop_metrics || null
    },

    http: {
      success_rate_percent: Math.round(httpStats.success_rate * 100) / 100,
      success_count: httpStats.success_count,
      fail_count: httpStats.fail_count,
      total_count: httpStats.total_count,
      rate_limited_count: health.rate_limited_count || 0
    },

    staleness: {
      percent_stale_signaled: Math.round(staleness.percent_stale * 100) / 100,
      max_stale_signaled_seconds: staleness.max_stale_seconds,
      stale_count: staleness.stale_count,
      signaled_count: staleness.signaled_count
    },

    persistence: {
      last_write_ts: lastWriteTs || null,
      last_write_age_seconds: lastWriteAgeSeconds,
      write_success_count: health.state_write_count || 0,
      write_skipped_count: health.state_write_skipped_count || 0
    },

    watchlist: {
      total: Object.keys(wl).length,
      by_status: statusCounts,
      by_league: leagueBreakdown
    },

    league_summary: computeLeagueSummary(state),
    daily_utilization: computeDailyUtilization(state),
    reject_reasons: {
      top5: rejectReasons.top5,
      other_count: rejectReasons.other_count
    },

    websocket: (() => {
      const wsMetrics = state?.runtime?.wsClient?.getMetrics();
      if (!wsMetrics) return null;
      
      // Sum WS vs HTTP usage from rolling buckets (last 5 minutes)
      const healthBuckets = state?.runtime?.health?.buckets?.health;
      let wsUsed = 0;
      let httpUsed = 0;
      let httpCacheMiss = 0;
      let httpStale = 0;
      
      if (healthBuckets?.buckets) {
        for (const bucket of healthBuckets.buckets) {
          if (bucket.counts) {
            wsUsed += (bucket.counts.price_source_ws_both || 0) + (bucket.counts.price_source_ws_yes || 0);
            httpUsed += bucket.counts.price_source_http_fallback || 0;
            httpCacheMiss += bucket.counts.price_source_http_fallback_cache_miss || 0;
            httpStale += bucket.counts.price_source_http_fallback_stale || 0;
          }
        }
      }
      
      const total = wsUsed + httpUsed;
      const wsRatio = total > 0 ? Math.round((wsUsed / total) * 1000) / 10 : 0; // percent with 1 decimal
      
      // Validate that cache_miss + stale = total http_fallback
      const sumBreakdown = httpCacheMiss + httpStale;
      const httpFallbackMismatch = (sumBreakdown !== httpUsed && httpUsed > 0);
      
      return {
        ...wsMetrics,
        usage: {
          ws_price_fetches: wsUsed,
          http_fallback_fetches: httpUsed,
          http_fallback_cache_miss: httpCacheMiss,
          http_fallback_stale: httpStale,
          http_fallback_mismatch: httpFallbackMismatch,
          ws_ratio_percent: wsRatio
        }
      };
    })(),

    depth_cache: (() => {
      const dc = state?.runtime?._depthCache;
      if (!dc) return null;
      const entries = Object.values(dc);
      const ages = entries.map(e => now - (e.ts || 0)).filter(a => a >= 0);
      const healthBuckets = state?.runtime?.health?.buckets?.health;
      let hits = 0, misses = 0, busts = 0;
      if (healthBuckets?.buckets) {
        for (const b of healthBuckets.buckets) {
          if (b.counts) {
            hits += b.counts.depth_cache_hit || 0;
            misses += b.counts.depth_http_fetch_after_ws || 0;
            busts += b.counts.depth_cache_bust_price_move || 0;
          }
        }
      }
      const total = hits + misses;
      return {
        size: entries.length,
        hit_rate: total > 0 ? Math.round((hits / total) * 1000) / 10 : null,
        hits, misses, busts,
        avg_age_ms: ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null,
      };
    })(),

    time_in_status: {
      signaled_top5: timeInStatus.signaled,
      pending_top5: timeInStatus.pending
    },

    trade_bridge: state?.runtime?.trade_bridge || { mode: "paper", paused: false },
    universe_funnel: buildUniverseFunnel(state),
  };
}

/**
 * Generate HTML dashboard that consumes /health endpoint.
 * 
 * @returns {string} - HTML string
 */
function generateDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Polymarket Watchlist Bot - Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 {
      font-size: 24px;
      margin-bottom: 8px;
      color: #f1f5f9;
    }
    .meta {
      font-size: 13px;
      color: #94a3b8;
      margin-bottom: 24px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 16px;
    }
    .card-title {
      font-size: 13px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    .metric {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 14px;
    }
    .metric-label { color: #cbd5e1; }
    .metric-value { font-weight: 600; color: #f1f5f9; }
    .metric-value.good { color: #10b981; }
    .metric-value.warn { color: #f59e0b; }
    .metric-value.bad { color: #ef4444; }
    .table {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .table-title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 12px;
      color: #f1f5f9;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid #334155;
      color: #94a3b8;
      font-weight: 500;
    }
    td {
      padding: 8px;
      border-bottom: 1px solid #334155;
      color: #e2e8f0;
    }
    tr:last-child td { border-bottom: none; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge.green { background: #065f46; color: #10b981; }
    .badge.yellow { background: #78350f; color: #f59e0b; }
    .badge.red { background: #7f1d1d; color: #ef4444; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Polymarket Watchlist Bot</h1>
    <div class="meta" id="meta">Loading...</div>

    <div class="cards">
      <div class="card">
        <div class="card-title">Loop</div>
        <div class="metric">
          <span class="metric-label">Runs</span>
          <span class="metric-value" id="loop-runs">-</span>
        </div>
        <div class="metric">
          <span class="metric-label">Last Cycle</span>
          <span class="metric-value" id="loop-age">-</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Staleness</div>
        <div class="metric">
          <span class="metric-label">Stale Signaled</span>
          <span class="metric-value" id="stale-percent">-</span>
        </div>
        <div class="metric">
          <span class="metric-label">Max Stale</span>
          <span class="metric-value" id="stale-max">-</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">HTTP</div>
        <div class="metric">
          <span class="metric-label">Success Rate</span>
          <span class="metric-value" id="http-success">-</span>
        </div>
        <div class="metric">
          <span class="metric-label">Rate Limited</span>
          <span class="metric-value" id="http-limited">-</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Persistence</div>
        <div class="metric">
          <span class="metric-label">Last Write</span>
          <span class="metric-value" id="persist-age">-</span>
        </div>
        <div class="metric">
          <span class="metric-label">Writes / Skipped</span>
          <span class="metric-value" id="persist-counts">-</span>
        </div>
      </div>
    </div>

    <div class="table">
      <div class="table-title">Watchlist Status</div>
      <table id="status-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <div class="table">
      <div class="table-title">League Breakdown</div>
      <table id="league-table">
        <thead>
          <tr>
            <th>League</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <div class="table">
      <div class="table-title">Top Reject Reasons (Last Cycle)</div>
      <table id="reject-table">
        <thead>
          <tr>
            <th>Reason</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <script>
    async function fetchHealth() {
      try {
        const res = await fetch('/health');
        const data = await res.json();

        // Meta
        const uptime = Math.floor(data.uptime_seconds / 60);
        document.getElementById('meta').textContent = \`Uptime: \${uptime}m | PID: \${data.pid} | Build: \${data.build_commit}\`;

        // Loop
        document.getElementById('loop-runs').textContent = data.loop.runs;
        const loopAge = data.loop.last_cycle_age_seconds;
        const loopAgeEl = document.getElementById('loop-age');
        loopAgeEl.textContent = loopAge != null ? \`\${loopAge}s ago\` : 'unknown';
        loopAgeEl.className = 'metric-value ' + (loopAge <= 5 ? 'good' : loopAge <= 10 ? 'warn' : 'bad');

        // Staleness
        const stalePercent = data.staleness.percent_stale_signaled;
        const staleEl = document.getElementById('stale-percent');
        staleEl.textContent = \`\${stalePercent.toFixed(1)}%\`;
        staleEl.className = 'metric-value ' + (stalePercent === 0 ? 'good' : 'bad');
        document.getElementById('stale-max').textContent = \`\${data.staleness.max_stale_signaled_seconds}s\`;

        // HTTP
        const httpSuccess = data.http.success_rate_percent;
        const httpEl = document.getElementById('http-success');
        httpEl.textContent = \`\${httpSuccess.toFixed(1)}%\`;
        httpEl.className = 'metric-value ' + (httpSuccess >= 99 ? 'good' : httpSuccess >= 98.5 ? 'warn' : 'bad');
        const rateLimited = data.http.rate_limited_count;
        const limitedEl = document.getElementById('http-limited');
        limitedEl.textContent = rateLimited;
        limitedEl.className = 'metric-value ' + (rateLimited === 0 ? 'good' : 'bad');

        // Persistence
        const writeAge = data.persistence.last_write_age_seconds;
        const writeEl = document.getElementById('persist-age');
        writeEl.textContent = writeAge != null ? \`\${writeAge}s ago\` : 'unknown';
        writeEl.className = 'metric-value ' + (writeAge <= 5 ? 'good' : writeAge <= 10 ? 'warn' : 'bad');
        document.getElementById('persist-counts').textContent = \`\${data.persistence.write_success_count} / \${data.persistence.write_skipped_count}\`;

        // Status table
        const statusTbody = document.getElementById('status-table').querySelector('tbody');
        statusTbody.innerHTML = '';
        for (const [status, count] of Object.entries(data.watchlist.by_status || {})) {
          const row = statusTbody.insertRow();
          row.insertCell(0).textContent = status;
          row.insertCell(1).textContent = count;
        }

        // League table
        const leagueTbody = document.getElementById('league-table').querySelector('tbody');
        leagueTbody.innerHTML = '';
        const leagues = Object.entries(data.watchlist.by_league || {});
        leagues.sort((a, b) => b[1] - a[1]); // sort by count desc
        for (const [league, count] of leagues) {
          const row = leagueTbody.insertRow();
          row.insertCell(0).textContent = league;
          row.insertCell(1).textContent = count;
        }

        // Reject reasons table
        const rejectTbody = document.getElementById('reject-table').querySelector('tbody');
        rejectTbody.innerHTML = '';
        const reasons = data.reject_reasons?.top5 || [];
        for (const { reason, count } of reasons) {
          const row = rejectTbody.insertRow();
          row.insertCell(0).textContent = reason;
          row.insertCell(1).textContent = count;
        }
        const otherCount = data.reject_reasons?.other_count || 0;
        if (otherCount > 0) {
          const row = rejectTbody.insertRow();
          row.insertCell(0).textContent = 'other';
          row.insertCell(1).textContent = otherCount;
        }
      } catch (e) {
        console.error('Failed to fetch health:', e);
      }
    }

    // Initial fetch + auto-refresh every 5s
    fetchHealth();
    setInterval(fetchHealth, 5000);
  </script>
</body>
</html>`;
}

/**
 * Start health monitoring HTTP server.
 * 
 * @param {object} state - runtime state (mutable reference, read on each request)
 * @param {object} opts - { port: 3210, host: "127.0.0.1", startedMs, buildCommit }
 * @returns {object} - { server, port, host }
 */
export function startHealthServer(state, opts = {}) {
  const port = opts.port || 3210;
  const host = opts.host || "127.0.0.1";
  const startedMs = opts.startedMs || Date.now();
  const buildCommit = opts.buildCommit || "unknown";

  // Load dashboard HTML from file (cached)
  let _dashboardHtml = null;
  let _dashboardHtmlTs = 0;
  function getDashboardHtml() {
    const now = Date.now();
    if (_dashboardHtml && (now - _dashboardHtmlTs) < 30000) return _dashboardHtml;
    try {
      const p = resolve(process.cwd(), "src", "runtime", "dashboard.html");
      _dashboardHtml = readFileSync(p, "utf8");
      _dashboardHtmlTs = now;
    } catch {
      _dashboardHtml = "<h1>Dashboard HTML not found</h1>";
    }
    return _dashboardHtml;
  }

  // API: build trades response
  function buildTradesResponse() {
    const signalsPath = statePath("journal", "signals.jsonl");
    const { items: signals, parse_errors } = cachedReadJsonl(signalsPath, 3000);

    const todayStr = new Date().toISOString().slice(0, 10);
    const todayStart = new Date(todayStr + "T00:00:00Z").getTime();

    const closes = signals.filter(s => s.type === "signal_close");
    const closesToday = closes.filter(s => (s.ts_close || 0) >= todayStart);
    const wins = closesToday.filter(s => s.win === true);
    const losses = closesToday.filter(s => s.win === false);
    const pnlToday = closesToday.reduce((sum, s) => sum + (s.pnl_usd || 0), 0);
    const winsAll = closes.filter(s => s.win === true);
    const lossesAll = closes.filter(s => s.win === false);
    const pnlTotal = closes.reduce((sum, s) => sum + (s.pnl_usd || 0), 0);
    const wrToday = (wins.length + losses.length) > 0
      ? ((wins.length / (wins.length + losses.length)) * 100).toFixed(1) + "%"
      : "n/a";
    const wrAll = (winsAll.length + lossesAll.length) > 0
      ? ((winsAll.length / (winsAll.length + lossesAll.length)) * 100).toFixed(1) + "%"
      : "n/a";

    // Timeout analysis — split by category
    const timeouts = signals.filter(s => s.type === "signal_timeout");
    const toResolved = signals.filter(s => s.type === "timeout_resolved");
    const savedUs = toResolved.filter(s => s.verdict === "filter_saved_us").length;
    const costUs = toResolved.filter(s => s.verdict === "filter_cost_us").length;

    // Infer category for old events without timeout_category
    const inferCategory = (t) => {
      if (t.timeout_category) return t.timeout_category;
      return t.timeout_reason === "fail_base_price_out_of_range" ? "price_window" : "confirmation_filter";
    };

    // Match timeout_category from signal_timeout to its timeout_resolved
    const timeoutMap = new Map(timeouts.map(t => [t.slug + "|" + t.ts, t]));
    const priceWindowResolved = toResolved.filter(r => {
      const t = timeoutMap.get(r.slug + "|" + r.timeout_ts);
      return t && inferCategory(t) === "price_window";
    });
    const confirmFilterResolved = toResolved.filter(r => {
      const t = timeoutMap.get(r.slug + "|" + r.timeout_ts);
      return !t || inferCategory(t) !== "price_window";
    });
    const priceWindowTimeouts = timeouts.filter(t => inferCategory(t) === "price_window");
    const confirmFilterTimeouts = timeouts.filter(t => inferCategory(t) !== "price_window");

    // Sub-reason breakdown for confirmation_filter
    const confirmReasonCounts = {};
    for (const t of confirmFilterTimeouts) {
      const r = t.timeout_reason || "unknown";
      confirmReasonCounts[r] = (confirmReasonCounts[r] || 0) + 1;
    }

    // First trade date
    const allOpens = signals.filter(s => s.type === "signal_open").map(s => s.ts_open || s.ts || 0).filter(Boolean);
    const firstTradeTs = allOpens.length > 0 ? Math.min(...allOpens) : null;

    return {
      as_of_ts: Date.now(),
      parse_errors,
      summary: {
        // Today
        trades_today: closesToday.length,
        wins_today: wins.length,
        losses_today: losses.length,
        pnl_today: pnlToday,
        wr_today: wrToday,
        // All-time
        trades_total: closes.length,
        wins_total: winsAll.length,
        losses_total: lossesAll.length,
        pnl_total: pnlTotal,
        wr_total: wrAll,
        first_trade_ts: firstTradeTs,
        // Timeouts (aggregate)
        timeouts_total: timeouts.length,
        timeouts_saved: savedUs,
        timeouts_cost: costUs,
        timeouts_pending: timeouts.length - toResolved.length,
        // Timeouts by category
        timeouts_price_window: {
          total: priceWindowTimeouts.length,
          cost: priceWindowResolved.filter(r => r.verdict === "filter_cost_us").length,
          saved: priceWindowResolved.filter(r => r.verdict === "filter_saved_us").length,
          pending: priceWindowTimeouts.length - priceWindowResolved.length,
          lost_pnl: +priceWindowResolved.filter(r => r.verdict === "filter_cost_us").reduce((s, r) => s + (r.hypothetical_pnl_usd || 0), 0).toFixed(2),
          saved_pnl: +priceWindowResolved.filter(r => r.verdict === "filter_saved_us").reduce((s, r) => s + Math.abs(r.hypothetical_pnl_usd || 0), 0).toFixed(2),
        },
        timeouts_confirmation: {
          total: confirmFilterTimeouts.length,
          cost: confirmFilterResolved.filter(r => r.verdict === "filter_cost_us").length,
          saved: confirmFilterResolved.filter(r => r.verdict === "filter_saved_us").length,
          pending: confirmFilterTimeouts.length - confirmFilterResolved.length,
          lost_pnl: +confirmFilterResolved.filter(r => r.verdict === "filter_cost_us").reduce((s, r) => s + (r.hypothetical_pnl_usd || 0), 0).toFixed(2),
          saved_pnl: +confirmFilterResolved.filter(r => r.verdict === "filter_saved_us").reduce((s, r) => s + Math.abs(r.hypothetical_pnl_usd || 0), 0).toFixed(2),
          by_reason: confirmReasonCounts,
        },
      },
      items: closesToday.map(c => {
        // Enrich from matching signal_open if fields missing
        const openMatch = c.signal_id
          ? signals.find(s => s.type === "signal_open" && s.signal_id === c.signal_id)
          : null;
        // Derive exit_price: explicit field > from resolution > from PnL math
        let exitPrice = c.exit_price ?? null;
        if (exitPrice == null && c.close_reason === "resolved") {
          exitPrice = c.win === true ? 1.0 : 0.0;
        }
        if (exitPrice == null && c.pnl_usd != null) {
          const ep = c.entry_price || openMatch?.entry_price;
          const notional = c.paper_notional_usd || openMatch?.paper_notional_usd || 10;
          if (ep && ep > 0) {
            const shares = notional / ep;
            exitPrice = shares > 0 ? Math.round(((c.pnl_usd / shares) + ep) * 1000) / 1000 : null;
          }
        }
        // In live mode, use actual fill price from execution_state
        let actualEntryPrice = c.entry_price || openMatch?.entry_price || null;
        const execState2 = cachedReadJson(statePath("execution_state.json"), 3000);
        const trades2 = execState2?.trades || {};
        const sigId = c.signal_id || "";
        const buyTrade2 = trades2[`buy:${sigId}`];
        if (buyTrade2?.avgFillPrice) {
          actualEntryPrice = buyTrade2.avgFillPrice;
        }
        return {
          slug: c.slug, title: c.title || openMatch?.title || null,
          league: c.league || openMatch?.league || "",
          ts_open: c.ts_open || openMatch?.ts_open || null,
          ts_close: c.ts_close,
          entry_price: actualEntryPrice,
          signal_price: c.entry_price || openMatch?.entry_price || null,
          exit_price: exitPrice,
          win: c.win, pnl_usd: c.pnl_usd, roi: c.roi,
          close_reason: c.close_reason,
        };
      }),
    };
  }

  // API: build positions response
  function buildPositionsResponse() {
    const idx = cachedReadJson(statePath("journal", "open_index.json"), 3000);
    const execState = cachedReadJson(statePath("execution_state.json"), 3000);
    const open = idx?.open || {};
    const trades = execState?.trades || {};
    return {
      as_of_ts: Date.now(),
      items: Object.values(open).map(p => {
        // In live mode, use actual fill price from execution_state (not signal price)
        let actualEntryPrice = p.entry_price;
        const buyTrade = trades[`buy:${p.signal_id || ""}`];
        if (buyTrade?.avgFillPrice) {
          actualEntryPrice = buyTrade.avgFillPrice;
        }
        return {
          slug: p.slug, title: p.title || null,
          league: p.league || "", market_kind: p.market_kind || null,
          ts_open: p.ts_open,
          entry_price: actualEntryPrice,
          signal_price: p.entry_price, // original signal price for reference
          paper_notional_usd: p.paper_notional_usd,
          entry_outcome_name: p.entry_outcome_name,
          price_tracking: p.price_tracking || null,
          actual_spent_usd: buyTrade?.spentUsd || null,
          filled_shares: buyTrade?.filledShares || null,
        };
      }),
    };
  }

  // API: build executions response (real trades from trade bridge)
  function buildExecutionsResponse(state) {
    const execPath = statePath("journal", "executions.jsonl");
    const { items: execs } = cachedReadJsonl(execPath, 5000);
    const bridge = state?.runtime?.trade_bridge || {};

    const todayStr = new Date().toISOString().slice(0, 10);
    const todayStart = new Date(todayStr + "T00:00:00Z").getTime();

    const todayExecs = execs.filter(e => (e.ts || 0) >= todayStart);
    const buys = todayExecs.filter(e => String(e.side).toUpperCase() === "BUY");
    const sells = todayExecs.filter(e => String(e.side).toUpperCase() === "SELL");
    const failed = todayExecs.filter(e => e.type === "trade_error" || e.type === "trade_failed");

    // Cross-check: signals today vs executions today
    const signalsPath = statePath("journal", "signals.jsonl");
    const { items: signals } = cachedReadJsonl(signalsPath, 5000);
    const signalOpensToday = signals.filter(s => s.type === "signal_open" && (s.ts_open || 0) >= todayStart);
    const signalClosesToday = signals.filter(s => s.type === "signal_close" && (s.ts_close || 0) >= todayStart);

    const executedBuyIds = new Set(buys.map(e => e.trade_id));
    const executedSellIds = new Set(sells.map(e => e.trade_id));

    // Divergences: signals without matching execution
    const unexecutedOpens = signalOpensToday.filter(s => {
      const tid = `buy:${s.signal_id}`;
      return !executedBuyIds.has(tid);
    });
    const unexecutedCloses = signalClosesToday.filter(s => {
      const tid = `sell:${s.signal_id}`;
      return !executedSellIds.has(tid);
    });

    const mode = bridge.mode || "paper";
    // Divergence only meaningful in live/shadow_live mode
    const divApplies = mode !== "paper";

    return {
      as_of_ts: Date.now(),
      mode,
      paused: bridge.paused || false,
      balance_usd: bridge.balance_usd ?? null,
      summary: {
        buys_today: buys.length,
        sells_today: sells.length,
        failed_today: failed.length,
        total_today: todayExecs.length,
      },
      divergence: divApplies ? {
        signals_without_buy: unexecutedOpens.length,
        signals_without_sell: unexecutedCloses.length,
        ok: unexecutedOpens.length === 0 && unexecutedCloses.length === 0,
      } : { ok: true, note: "paper_mode" },
      items: todayExecs.slice(-50).map(e => ({
        trade_id: e.trade_id, side: e.side, status: e.status,
        slug: e.slug, title: e.title || null,
        shares: e.shares, price: e.avg_price || e.price,
        cost_usd: e.cost_usd, ts: e.ts,
        error: e.error || null,
      })),
    };
  }

  // API: build watchlist response
  function buildWatchlistResponse() {
    const wl = state?.watchlist || {};
    return {
      as_of_ts: Date.now(),
      items: Object.values(wl).map(m => ({
        slug: m.slug, status: m.status, league: m.league || "",
        title: m.title || m.question || null,
        market_kind: m.market_kind || null,
        last_price: m.last_price || {},
        last_reject: m.last_reject || {},
        first_seen_ts: m.first_seen_ts,
      })),
    };
  }

  // API: build config response (safe keys only)
  function buildConfigResponse() {
    const snap = cachedReadJson(statePath("config-snapshot.json"), 10000);
    if (!snap) return { as_of_ts: Date.now(), config: null };
    // Allowlist of safe keys
    const safe = {};
    const allow = ["strategy", "polling", "filters", "purge", "health", "gamma", "paper", "_runner", "_boot_ts"];
    for (const k of allow) {
      if (snap[k] != null) safe[k] = snap[k];
    }
    return { as_of_ts: Date.now(), config: safe };
  }

  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const json = (data) => {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };

    try {
      // Legacy health endpoint
      if (req.url === "/health" || req.url === "/api/health") {
        json(buildHealthResponse(state, startedMs, buildCommit));
        return;
      }
      if (req.url === "/api/trades") { json(buildTradesResponse()); return; }
      if (req.url === "/api/positions") { json(buildPositionsResponse()); return; }
      if (req.url === "/api/watchlist") { json(buildWatchlistResponse()); return; }
      if (req.url === "/api/config") { json(buildConfigResponse()); return; }
      if (req.url === "/api/executions") { json(buildExecutionsResponse(state)); return; }

      // Dashboard (new)
      if (req.url === "/" || req.url === "/dashboard") {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
        res.end(getDashboardHtml());
        return;
      }

      // Legacy dashboard (keep for backward compat)
      if (req.url === "/legacy") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(generateDashboardHTML());
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found", path: req.url }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", message: e?.message || String(e) }));
    }
  });

  server.listen(port, host, () => {
    console.log(`[HEALTH] HTTP server listening on http://${host}:${port}/health (dashboard: http://${host}:${port}/)`);
  });

  return { server, port, host };
}
