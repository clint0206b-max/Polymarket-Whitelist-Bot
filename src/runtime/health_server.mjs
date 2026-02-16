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
  const health = state?.runtime?.health || {};
  const rejectCounts = health.reject_counts_last_cycle || {};

  const entries = Object.entries(rejectCounts).map(([reason, count]) => ({ reason, count }));
  entries.sort((a, b) => b.count - a.count);

  const top5 = entries.slice(0, 5);
  const otherCount = entries.slice(5).reduce((sum, e) => sum + e.count, 0);

  return { top5, other_count: otherCount };
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
      by_status: statusCounts,
      by_league: leagueBreakdown
    },

    reject_reasons: {
      top5: rejectReasons.top5,
      other_count: rejectReasons.other_count
    },

    websocket: state?.runtime?.wsClient?.getMetrics() || null,

    time_in_status: {
      signaled_top5: timeInStatus.signaled,
      pending_top5: timeInStatus.pending
    }
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

  const server = createServer((req, res) => {
    // Support GET /health (JSON) and GET / or /dashboard (HTML)
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    if (req.url === "/health") {
      try {
        const response = buildHealthResponse(state, startedMs, buildCommit);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response, null, 2));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error", message: e?.message || String(e) }));
      }
      return;
    }

    if (req.url === "/" || req.url === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(generateDashboardHTML());
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", path: req.url }));
  });

  server.listen(port, host, () => {
    console.log(`[HEALTH] HTTP server listening on http://${host}:${port}/health (dashboard: http://${host}:${port}/)`);
  });

  return { server, port, host };
}
