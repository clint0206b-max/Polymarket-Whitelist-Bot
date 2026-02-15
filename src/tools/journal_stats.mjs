#!/usr/bin/env node

// journal_stats.mjs
// Reads state/journal/signals.jsonl and prints decision-ready stats for gate evaluation.
// No external deps.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

function nowMs() { return Date.now(); }

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function median(arr) {
  const v = arr.filter(x => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return (n % 2) ? v[mid] : ((v[mid - 1] + v[mid]) / 2);
}

function pct(x) {
  if (x == null) return "n/a";
  return `${(x * 100).toFixed(2)}%`;
}

function fmtN(x, d = 4) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return x.toFixed(d);
}

function parseArgs(argv) {
  const out = {
    since_hours: 24,
    only_esports: true,
    league: "all",
    out: "text",
    file: "state/journal/signals.jsonl",
    allow_empty: false
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = (i + 1 < a.length) ? a[i + 1] : null;

    if (k === "--since_hours" && v) { out.since_hours = Number(v); i++; continue; }
    if (k === "--only_esports" && v) { out.only_esports = (v === "true" || v === "1"); i++; continue; }
    if (k === "--league" && v) { out.league = String(v); i++; continue; }
    if (k === "--out" && v) { out.out = String(v); i++; continue; }
    if (k === "--file" && v) { out.file = String(v); i++; continue; }
    if (k === "--allow_empty" && v) { out.allow_empty = (v === "true" || v === "1"); i++; continue; }
    if (k === "--help" || k === "-h") {
      out.help = true;
      return out;
    }
  }
  if (!Number.isFinite(out.since_hours) || out.since_hours <= 0) out.since_hours = 24;
  if (out.out !== "text" && out.out !== "json") out.out = "text";
  return out;
}

function inferEsportsGameFromSlug(slug) {
  const s = String(slug || "");
  const m = s.match(/^([a-z0-9]+)-/i);
  return m ? m[1].toLowerCase() : null;
}

function leagueFilterMatch(openRow, opts) {
  const leagueArg = String(opts.league || "all").toLowerCase();
  if (leagueArg === "all") return true;

  // Allow comma-separated filters (e.g. lol,cs2)
  const wanted = leagueArg.split(",").map(x => x.trim()).filter(Boolean);
  if (!wanted.length) return true;

  const league = String(openRow?.league || "").toLowerCase();
  const slug = String(openRow?.slug || "").toLowerCase();

  if (league === "esports") {
    const g = inferEsportsGameFromSlug(slug);
    return g ? wanted.includes(g) : false;
  }

  return wanted.includes(league);
}

function isEsports(openRow) {
  const league = String(openRow?.league || "").toLowerCase();
  if (league === "esports") return true;
  const slug = String(openRow?.slug || "");
  return /^(lol|cs2|val|dota2|dota)-/i.test(slug);
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage: node src/tools/journal_stats.mjs [--since_hours 24] [--only_esports true|false] [--league all|lol,cs2|nba] [--out text|json] [--file state/journal/signals.jsonl] [--allow_empty true|false]`);
    process.exit(0);
  }

  const sinceMs = nowMs() - (Number(opts.since_hours) * 60 * 60 * 1000);

  const fileAbs = path.resolve(process.cwd(), opts.file);
  if (!fs.existsSync(fileAbs)) {
    if (!opts.allow_empty) {
      console.error(`journal not found: ${fileAbs}`);
      process.exit(1);
    }

    const emptyOut = {
      window: { since_hours: Number(opts.since_hours), since_ms: sinceMs, now_ms: nowMs() },
      filters: { only_esports: !!opts.only_esports, league: opts.league },
      totals: { opened: 0, closed: 0, open_unresolved: 0 },
      closed: { avg_roi: null, median_roi: null, avg_pnl_usd: null, win_rate: null, n_with_roi: 0 },
      gate_apply: {
        applied: 0,
        applied_closed: 0,
        would_allow_closed: 0,
        would_block_closed: 0,
        allow_stats: { count: 0, avg_roi: null, median_roi: null, avg_pnl_usd: null, win_rate: null },
        block_stats: { count: 0, avg_roi: null, median_roi: null, avg_pnl_usd: null, win_rate: null },
        applied_stats: { count: 0, avg_roi: null, median_roi: null, avg_pnl_usd: null, win_rate: null }
      },
      top_reasons: []
    };

    if (opts.out === "json") {
      console.log(JSON.stringify(emptyOut, null, 2));
      return;
    }

    console.log(`Window: last ${opts.since_hours}h (journal missing; allow_empty=true)`);
    console.log(`Filters: only_esports=${opts.only_esports ? "true" : "false"}, league=${opts.league}`);
    console.log(`Signals opened: 0, closed(resolved): 0, open: 0`);
    console.log(`Closed ROI avg=n/a median=n/a win_rate=n/a n_with_roi=0`);
    console.log(`\nGate apply set:`);
    console.log(`- applied(opened): 0`);
    console.log(`- applied(closed): 0`);
    console.log(`- would_allow(closed): 0 | avg_roi=n/a median=n/a`);
    console.log(`- would_block(closed): 0 | avg_roi=n/a median=n/a`);
    return;
  }

  // Collect open+close pairs by signal_id
  const byId = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(fileAbs, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const t = String(line || "").trim();
    if (!t) continue;
    let obj = null;
    try { obj = JSON.parse(t); } catch { continue; }

    const id = String(obj?.signal_id || "");
    if (!id) continue;

    const cur = byId.get(id) || { open: null, close: null };

    if (obj.type === "signal_open") cur.open = obj;
    else if (obj.type === "signal_close") cur.close = obj;

    byId.set(id, cur);
  }

  // Filter to window based on ts_open
  const rows = [];
  for (const [id, rec] of byId.entries()) {
    const o = rec.open;
    if (!o) continue;

    const tsOpen = Number(o.ts_open || 0);
    if (!tsOpen || tsOpen < sinceMs) continue;

    if (opts.only_esports && !isEsports(o)) continue;
    if (!leagueFilterMatch(o, opts)) continue;

    rows.push({ id, open: o, close: rec.close || null });
  }

  const opened = rows.length;
  const closed = rows.filter(r => !!r.close).length;
  const openUnresolved = opened - closed;

  // Closed metrics
  const roiClosed = rows.map(r => toNum(r.close?.roi)).filter(x => x != null);
  const pnlClosed = rows.map(r => toNum(r.close?.pnl_usd)).filter(x => x != null);
  const winClosed = rows.map(r => {
    const pnl = toNum(r.close?.pnl_usd);
    return pnl == null ? null : (pnl > 0);
  }).filter(x => x != null);

  const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  // Gate apply set
  const applied = rows.filter(r => r.open?.would_gate_apply === true);
  const appliedClosed = applied.filter(r => !!r.close);
  const appliedAllowClosed = appliedClosed.filter(r => r.open?.would_gate_block !== true);
  const appliedBlockClosed = appliedClosed.filter(r => r.open?.would_gate_block === true);

  function summarizeSet(setRows) {
    const rois = setRows.map(r => toNum(r.close?.roi)).filter(x => x != null);
    const pnls = setRows.map(r => toNum(r.close?.pnl_usd)).filter(x => x != null);
    const wins = setRows.map(r => {
      const pnl = toNum(r.close?.pnl_usd);
      return pnl == null ? null : (pnl > 0);
    }).filter(x => x != null);
    return {
      count: setRows.length,
      avg_roi: avg(rois),
      median_roi: median(rois),
      avg_pnl_usd: avg(pnls),
      win_rate: wins.length ? (wins.filter(Boolean).length / wins.length) : null
    };
  }

  // Breakdown by reason on applied set (closed only)
  const byReason = new Map();
  for (const r of appliedClosed) {
    const reason = String(r.open?.would_gate_reason || "unknown");
    const bucket = byReason.get(reason) || [];
    bucket.push(r);
    byReason.set(reason, bucket);
  }

  const reasonStats = Array.from(byReason.entries()).map(([reason, setRows]) => {
    const s = summarizeSet(setRows);
    return { reason, ...s };
  }).sort((a, b) => (b.count - a.count) || ((a.avg_roi ?? -999) - (b.avg_roi ?? -999)));

  const out = {
    window: { since_hours: Number(opts.since_hours), since_ms: sinceMs, now_ms: nowMs() },
    filters: { only_esports: !!opts.only_esports, league: opts.league },
    totals: {
      opened,
      closed,
      open_unresolved: openUnresolved
    },
    closed: {
      avg_roi: avg(roiClosed),
      median_roi: median(roiClosed),
      avg_pnl_usd: avg(pnlClosed),
      win_rate: winClosed.length ? (winClosed.filter(Boolean).length / winClosed.length) : null,
      n_with_roi: roiClosed.length
    },
    gate_apply: {
      applied: applied.length,
      applied_closed: appliedClosed.length,
      would_allow_closed: appliedAllowClosed.length,
      would_block_closed: appliedBlockClosed.length,
      allow_stats: summarizeSet(appliedAllowClosed),
      block_stats: summarizeSet(appliedBlockClosed),
      applied_stats: summarizeSet(appliedClosed)
    },
    top_reasons: reasonStats.slice(0, 10)
  };

  if (opts.out === "json") {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`Window: last ${opts.since_hours}h (signals by ts_open >= ${new Date(sinceMs).toISOString()})`);
  console.log(`Filters: only_esports=${opts.only_esports ? "true" : "false"}, league=${opts.league}`);
  console.log(`Signals opened: ${opened}, closed(resolved): ${closed}, open: ${openUnresolved}`);
  console.log(`Closed ROI avg=${pct(out.closed.avg_roi)} median=${pct(out.closed.median_roi)} win_rate=${pct(out.closed.win_rate)} n_with_roi=${out.closed.n_with_roi}`);

  console.log(`\nGate apply set:`);
  console.log(`- applied(opened): ${out.gate_apply.applied}`);
  console.log(`- applied(closed): ${out.gate_apply.applied_closed}`);
  console.log(`- would_allow(closed): ${out.gate_apply.would_allow_closed} | avg_roi=${pct(out.gate_apply.allow_stats.avg_roi)} median=${pct(out.gate_apply.allow_stats.median_roi)}`);
  console.log(`- would_block(closed): ${out.gate_apply.would_block_closed} | avg_roi=${pct(out.gate_apply.block_stats.avg_roi)} median=${pct(out.gate_apply.block_stats.median_roi)}`);

  if (out.top_reasons.length) {
    console.log(`\nTop blocked reasons (by count, applied+closed):`);
    for (const r of out.top_reasons) {
      console.log(`- ${r.reason}: n=${r.count} avg_roi=${pct(r.avg_roi)} median_roi=${pct(r.median_roi)} win_rate=${pct(r.win_rate)}`);
    }
  }
}

main().catch(e => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
