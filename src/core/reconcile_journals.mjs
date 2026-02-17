/**
 * reconcile_journals.mjs — Boot-time reconciliation of executions.jsonl from signals.jsonl
 *
 * Detects signal_close entries without a matching sell in executions.jsonl.
 * Generates `trade_reconciled` entries (NOT trade_executed) to close the gap.
 * These are clearly marked as backfills, not real executions.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read a JSONL file and return parsed lines (skips malformed).
 */
function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  const items = [];
  for (const line of lines) {
    try { items.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return items;
}

/**
 * Reconcile executions.jsonl from signals.jsonl.
 *
 * For each signal_close without a matching sell in executions.jsonl:
 * 1. Verify the buy exists and is closed in execution_state.json
 * 2. Generate a `trade_reconciled` entry (not trade_executed)
 * 3. Append to executions.jsonl
 *
 * @param {string} stateDir - path to state directory
 * @param {object} [opts] - options
 * @param {string} [opts.mode] - trading mode from config (fallback)
 * @returns {{ added: number, items: object[], warnings: string[] }}
 */
export function reconcileExecutionsFromSignals(stateDir, opts = {}) {
  const signalsPath = resolve(stateDir, "journal", "signals.jsonl");
  const execsPath = resolve(stateDir, "journal", "executions.jsonl");
  const execStatePath = resolve(stateDir, "execution_state.json");

  const result = { added: 0, items: [], warnings: [] };

  const signals = readJsonl(signalsPath);
  const execs = readJsonl(execsPath);

  // Load execution_state for cross-check
  let execState = {};
  if (existsSync(execStatePath)) {
    try { execState = JSON.parse(readFileSync(execStatePath, "utf8")); } catch { /* */ }
  }
  const trades = execState.trades || {};

  // Build sets for matching sells in executions.jsonl:
  // 1. By trade_id (primary key: "sell:{signal_id}")
  // 2. By signal_id (fallback: handles legacy entries with non-standard trade_id)
  const existingSellTradeIds = new Set();
  const existingSellSignalIds = new Set();
  for (const e of execs) {
    if (String(e.side).toUpperCase() === "SELL" || e.type === "trade_reconciled") {
      if (e.trade_id) existingSellTradeIds.add(e.trade_id);
      if (e.signal_id) existingSellSignalIds.add(e.signal_id);
    }
  }

  // Find signal_close entries without matching sell
  const closes = signals.filter(s => s.type === "signal_close");

  const toAppend = [];

  for (const sig of closes) {
    const signalId = sig.signal_id;
    if (!signalId) continue;

    const sellTradeId = `sell:${signalId}`;

    // Already has a matching sell (by trade_id or signal_id) → skip
    if (existingSellTradeIds.has(sellTradeId) || existingSellSignalIds.has(signalId)) continue;

    // Cross-check: does the buy exist in execution_state?
    const buyKey = `buy:${signalId}`;
    const buyTrade = trades[buyKey];

    if (!buyTrade) {
      result.warnings.push(`signal_close ${signalId}: no buy in execution_state, skipping`);
      continue;
    }

    if (!buyTrade.closed) {
      result.warnings.push(`signal_close ${signalId}: buy exists but not closed, skipping`);
      continue;
    }

    // Derive mode from buy trade or config fallback
    const mode = buyTrade.mode || opts.mode || "unknown";

    // Track missing fields
    const missingFields = [];
    if (sig.exit_price == null) missingFields.push("exit_price");
    if (sig.pnl_usd == null) missingFields.push("pnl_usd");
    if (sig.close_reason == null) missingFields.push("close_reason");
    if (buyTrade.filledShares == null) missingFields.push("filledShares");

    const entry = {
      type: "trade_reconciled",
      trade_id: sellTradeId,
      source: "signals_backfill",
      mode,
      side: "SELL",
      close_reason: sig.close_reason || "unknown",
      ts: sig.ts_close || Date.now(),
      signal_id: signalId,
      slug: sig.slug || buyTrade.slug || "unknown",
      filledShares: buyTrade.filledShares || null,
      avgFillPrice: sig.exit_price || null,
      pnl_usd: sig.pnl_usd || null,
      note: sig.note || "auto_reconciled",
    };

    if (missingFields.length > 0) {
      entry.missing_fields = missingFields;
    }

    toAppend.push(entry);
  }

  // Append to executions.jsonl
  if (toAppend.length > 0) {
    const lines = toAppend.map(e => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(execsPath, lines, "utf8");
    result.added = toAppend.length;
    result.items = toAppend;
  }

  return result;
}
