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

function nowMs() {
  return Date.now();
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

  return {
    status: "ok", // always "ok" if server is responding
    timestamp: now,
    uptime_seconds: uptimeSeconds,
    pid: process.pid,
    build_commit: buildCommit || "unknown",

    loop: {
      runs: state?.runtime?.runs || 0,
      last_cycle_ts: lastCycleTs || null,
      last_cycle_age_seconds: lastCycleAgeSeconds,
      cycle_duration_ms_avg: computeAvgCycleDuration(state)
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
      by_status: statusCounts
    }
  };
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

  const server = createServer((req, res) => {
    // Only support GET /health
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found", path: req.url }));
      return;
    }

    try {
      const response = buildHealthResponse(state, startedMs, buildCommit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response, null, 2));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", message: e?.message || String(e) }));
    }
  });

  server.listen(port, host, () => {
    console.log(`[HEALTH] HTTP server listening on http://${host}:${port}/health`);
  });

  return { server, port, host };
}
