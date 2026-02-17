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
    const execState = readJson(resolvePath("state/execution_state.json"));
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

  const reconciled = (added > 0 || removed > 0 || closedAdded > 0);
  return { reconciled, added, removed, closedAdded };
}
