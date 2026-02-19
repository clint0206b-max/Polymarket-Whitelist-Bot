import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { readJson, writeJsonAtomic, resolvePath } from "./state_store.js";

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }); } catch {}
}

export function appendJsonl(relPath, obj) {
  const abs = resolvePath(relPath);
  ensureDir(dirname(abs));
  appendFileSync(abs, JSON.stringify(obj) + "\n");
}

export function loadOpenIndex(relPath = "state/journal/open_index.json") {
  const abs = resolvePath(relPath);
  const cur = existsSync(abs) ? readJson(abs) : null;
  const out = (cur && typeof cur === "object" && !Array.isArray(cur)) ? cur : { v: 1, open: {}, closed: {} };
  if (!out.open || typeof out.open !== "object") out.open = {};
  if (!out.closed || typeof out.closed !== "object") out.closed = {};
  if (!out.failed_buys || typeof out.failed_buys !== "object") out.failed_buys = {};
  out.v = 1;
  return out;
}

export function saveOpenIndex(index, relPath = "state/journal/open_index.json") {
  const abs = resolvePath(relPath);
  writeJsonAtomic(abs, index);
}

export function addOpen(index, signalId, row) {
  index.open[String(signalId)] = row;
}

export function removeOpen(index, signalId) {
  delete index.open[String(signalId)];
}

export function addClosed(index, signalId, row) {
  if (!index.closed || typeof index.closed !== "object") index.closed = {};
  index.closed[String(signalId)] = row;
}

export function addFailedBuy(index, signalId, row) {
  if (!index.failed_buys || typeof index.failed_buys !== "object") index.failed_buys = {};
  index.failed_buys[String(signalId)] = row;
}

/**
 * Reconcile open_index from signals.jsonl (source of truth).
 * Rebuilds open/closed maps from the JSONL to fix any crash-induced desync.
 * Returns { reconciled: boolean, added: number, removed: number, closedAdded: number }.
 */
export function reconcileIndex(index, jsonlRelPath = "state/journal/signals.jsonl") {
  const abs = resolvePath(jsonlRelPath);
  if (!existsSync(abs)) return { reconciled: false, added: 0, removed: 0, closedAdded: 0 };

  let raw;
  try { raw = readFileSync(abs, "utf8"); } catch { return { reconciled: false, added: 0, removed: 0, closedAdded: 0 }; }

  const lines = raw.trim().split("\n").filter(Boolean);
  const openMap = {};   // signal_id -> open row from JSONL
  const closeMap = {};  // signal_id -> close row from JSONL

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "signal_open") {
      openMap[obj.signal_id] = obj;
    } else if (obj.type === "signal_close") {
      closeMap[obj.signal_id] = obj;
    }
  }

  let added = 0;
  let removed = 0;
  let closedAdded = 0;

  // Add any opens from JSONL that are missing from index (and not already closed)
  for (const [id, row] of Object.entries(openMap)) {
    if (closeMap[id]) continue; // already closed
    if (!index.open[id]) {
      index.open[id] = {
        slug: row.slug,
        ts_open: row.ts_open,
        league: row.league || "",
        market_kind: row.market_kind || null,
        entry_price: row.entry_price,
        paper_notional_usd: row.paper_notional_usd,
        entry_outcome_name: row.entry_outcome_name || null,
        would_gate_apply: row.would_gate_apply ?? false,
        would_gate_block: row.would_gate_block ?? false,
        would_gate_reason: row.would_gate_reason || "not_applicable",
        tp_math_allowed: row.tp_math_allowed ?? false,
        tp_math_reason: row.tp_math_reason || "no_data",
        context_entry: row.ctx?.entry_gate || null,
      };
      added++;
    }
  }

  // Remove any opens from index that are already closed in JSONL
  // BUT only if the buy trade is actually closed in execution_state (sell completed)
  // This prevents premature closure when signal_close exists but sell failed
  let execTrades = {};
  try {
    const execState = readJson(resolvePath("state", "execution_state.json"));
    execTrades = execState?.trades || {};
  } catch {}

  for (const id of Object.keys(index.open)) {
    if (closeMap[id]) {
      // Check execution_state: if buy exists and isn't closed, don't remove
      const buyKey = `buy:${id}`;
      const buyTrade = execTrades[buyKey];
      if (buyTrade && buyTrade.status === "filled" && !buyTrade.closed) {
        continue; // sell hasn't completed — keep in open
      }
      delete index.open[id];
      removed++;
    }
  }

  // Populate closed map from JSONL
  if (!index.closed || typeof index.closed !== "object") index.closed = {};
  for (const [id, row] of Object.entries(closeMap)) {
    if (!index.closed[id]) {
      const openRow = openMap[id] || {};
      index.closed[id] = {
        slug: openRow.slug || row.signal_id?.split("|")[1] || "unknown",
        ts_open: openRow.ts_open || null,
        ts_close: row.ts_close,
        league: openRow.league || "",
        entry_price: openRow.entry_price || null,
        paper_notional_usd: openRow.paper_notional_usd || null,
        entry_outcome_name: openRow.entry_outcome_name || null,
        close_reason: row.close_reason,
        resolve_method: row.resolve_method || null,
        resolved_outcome_name: row.resolved_outcome_name || null,
        win: row.win,
        pnl_usd: row.pnl_usd,
        roi: row.roi,
      };
      closedAdded++;
    }
  }

  // --- Derive buy_status from executions.jsonl and move failed buys ---
  let failedMoved = 0;
  if (!index.failed_buys || typeof index.failed_buys !== "object") index.failed_buys = {};
  try {
    const execAbs = resolvePath("state/journal/executions.jsonl");
    if (existsSync(execAbs)) {
      const execRaw = readFileSync(execAbs, "utf8");
      const execLines = execRaw.trim().split("\n").filter(Boolean);
      // Build map: signal_id -> { has_fill, has_fail }
      const buyStatusMap = {};
      for (const line of execLines) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const sid = obj.signal_id;
        if (!sid) continue;
        if (!buyStatusMap[sid]) buyStatusMap[sid] = { has_fill: false, has_fail: false };
        if (obj.type === "trade_executed" && String(obj.side).toUpperCase() === "BUY") {
          buyStatusMap[sid].has_fill = true;
        } else if (obj.type === "trade_failed" && String(obj.side).toUpperCase() === "BUY") {
          buyStatusMap[sid].has_fail = true;
        }
      }
      // Move open entries with confirmed failed buys (and no fill) to failed_buys
      for (const id of Object.keys(index.open)) {
        const bs = buyStatusMap[id];
        if (bs && bs.has_fail && !bs.has_fill) {
          const row = index.open[id];
          index.failed_buys[id] = {
            ...row,
            buy_status: "failed",
            moved_at: Date.now(),
          };
          delete index.open[id];
          failedMoved++;
        }
      }
    }
  } catch {}

  // Compact old failed_buys (>7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
  for (const [id, row] of Object.entries(index.failed_buys)) {
    const ts = row.moved_at || row.ts_open || 0;
    if (ts > 0 && ts < sevenDaysAgo) {
      delete index.failed_buys[id];
    }
  }

  const reconciled = (added > 0 || removed > 0 || closedAdded > 0 || failedMoved > 0);
  return { reconciled, added, removed, closedAdded, failedMoved };
}

/**
 * Read signals.jsonl and return slugs that have signal_open but no signal_close.
 * Used as purge protection — most reliable source since signal_open is written before buy.
 * @param {string} relPath
 * @returns {string[]} array of slugs with open signals
 */
export function readSignalsOpenSlugs(relPath = "state/journal/signals.jsonl") {
  const abs = resolvePath(relPath);
  if (!existsSync(abs)) return [];
  let raw;
  try { raw = readFileSync(abs, "utf8"); } catch { return []; }

  const openSlugs = new Map();  // signal_id -> slug
  const closedIds = new Set();

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "signal_open" && obj.signal_id && obj.slug) {
      openSlugs.set(obj.signal_id, obj.slug);
    } else if (obj.type === "signal_close" && obj.signal_id) {
      closedIds.add(obj.signal_id);
    }
  }

  const result = [];
  for (const [id, slug] of openSlugs) {
    if (!closedIds.has(id)) result.push(slug);
  }
  return result;
}
