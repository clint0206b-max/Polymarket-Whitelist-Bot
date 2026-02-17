import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { reconcileExecutionsFromSignals } from "../src/core/reconcile_journals.mjs";

const TEST_DIR = resolve(import.meta.dirname, "..", "state", "test-reconcile-journals");

function setup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(resolve(TEST_DIR, "journal"), { recursive: true });
}

function writeSignals(entries) {
  writeFileSync(resolve(TEST_DIR, "journal", "signals.jsonl"),
    entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

function writeExecs(entries) {
  writeFileSync(resolve(TEST_DIR, "journal", "executions.jsonl"),
    entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

function writeExecState(obj) {
  writeFileSync(resolve(TEST_DIR, "execution_state.json"), JSON.stringify(obj), "utf8");
}

function readExecs() {
  const raw = readFileSync(resolve(TEST_DIR, "journal", "executions.jsonl"), "utf8");
  return raw.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
}

describe("reconcileExecutionsFromSignals", () => {
  beforeEach(setup);
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("no-op when all signal_close have matching sells", () => {
    writeSignals([
      { type: "signal_close", signal_id: "1|slug-a", slug: "slug-a", ts_close: 1000, exit_price: 0.999, pnl_usd: 0.50, close_reason: "resolved" },
    ]);
    writeExecs([
      { type: "trade_executed", trade_id: "sell:1|slug-a", side: "SELL", signal_id: "1|slug-a", ts: 1000 },
    ]);
    writeExecState({ trades: { "buy:1|slug-a": { side: "BUY", closed: true } } });

    const r = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r.added, 0);
    assert.equal(r.items.length, 0);
    // executions.jsonl unchanged (still 1 entry)
    assert.equal(readExecs().length, 1);
  });

  it("generates trade_reconciled for signal_close without sell", () => {
    writeSignals([
      { type: "signal_close", signal_id: "1|slug-a", slug: "slug-a", ts_close: 2000, exit_price: 0.999, pnl_usd: 0.66, close_reason: "resolved", note: "reconciled_from_blockchain" },
    ]);
    writeExecs([
      { type: "trade_executed", trade_id: "buy:1|slug-a", side: "BUY", signal_id: "1|slug-a", ts: 1000 },
    ]);
    writeExecState({ trades: { "buy:1|slug-a": { side: "BUY", closed: true, slug: "slug-a", filledShares: 10.5, mode: "live" } } });

    const r = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r.added, 1);

    const entry = r.items[0];
    assert.equal(entry.type, "trade_reconciled");
    assert.equal(entry.source, "signals_backfill");
    assert.equal(entry.side, "SELL");
    assert.equal(entry.trade_id, "sell:1|slug-a");
    assert.equal(entry.slug, "slug-a");
    assert.equal(entry.avgFillPrice, 0.999);
    assert.equal(entry.pnl_usd, 0.66);
    assert.equal(entry.close_reason, "resolved");
    assert.equal(entry.mode, "live");  // derived from buy trade
    assert.equal(entry.filledShares, 10.5);

    // Verify appended to file
    const allExecs = readExecs();
    assert.equal(allExecs.length, 2);
    assert.equal(allExecs[1].type, "trade_reconciled");
  });

  it("idempotent: second run does not create duplicates", () => {
    writeSignals([
      { type: "signal_close", signal_id: "1|slug-a", slug: "slug-a", ts_close: 2000, exit_price: 0.999, pnl_usd: 0.50, close_reason: "resolved" },
    ]);
    writeExecs([]);
    writeExecState({ trades: { "buy:1|slug-a": { side: "BUY", closed: true, slug: "slug-a", filledShares: 10 } } });

    const r1 = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r1.added, 1);

    const r2 = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r2.added, 0);

    assert.equal(readExecs().length, 1);
  });

  it("skips signal_close when buy not in execution_state", () => {
    writeSignals([
      { type: "signal_close", signal_id: "1|slug-a", slug: "slug-a", ts_close: 2000, exit_price: 0.999 },
    ]);
    writeExecs([]);
    writeExecState({ trades: {} });

    const r = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r.added, 0);
    assert.equal(r.warnings.length, 1);
    assert.ok(r.warnings[0].includes("no buy in execution_state"));
  });

  it("skips signal_close when buy exists but not closed", () => {
    writeSignals([
      { type: "signal_close", signal_id: "1|slug-a", slug: "slug-a", ts_close: 2000, exit_price: 0.999 },
    ]);
    writeExecs([]);
    writeExecState({ trades: { "buy:1|slug-a": { side: "BUY", closed: false, slug: "slug-a" } } });

    const r = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r.added, 0);
    assert.ok(r.warnings[0].includes("not closed"));
  });

  it("skips signal_close when sell with same signal_id exists (non-standard trade_id)", () => {
    writeSignals([
      { type: "signal_close", signal_id: "1|slug-a", slug: "slug-a", ts_close: 2000, exit_price: 0.999 },
    ]);
    writeExecs([
      // Legacy entry: type="sell" with no standard trade_id, but has signal_id
      { type: "sell", side: "SELL", signal_id: "1|slug-a", avgFillPrice: 0.999 },
    ]);
    writeExecState({ trades: { "buy:1|slug-a": { side: "BUY", closed: true, slug: "slug-a" } } });

    const r = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r.added, 0);
    assert.equal(r.warnings.length, 0); // matched by signal_id, no warning
  });

  it("tracks missing fields", () => {
    writeSignals([
      { type: "signal_close", signal_id: "1|slug-a", slug: "slug-a", ts_close: 2000 },
      // exit_price, pnl_usd, close_reason all missing
    ]);
    writeExecs([]);
    writeExecState({ trades: { "buy:1|slug-a": { side: "BUY", closed: true, slug: "slug-a" } } });

    const r = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r.added, 1);
    const entry = r.items[0];
    assert.ok(entry.missing_fields.includes("exit_price"));
    assert.ok(entry.missing_fields.includes("pnl_usd"));
    assert.ok(entry.missing_fields.includes("close_reason"));
    assert.ok(entry.missing_fields.includes("filledShares"));
    assert.equal(entry.close_reason, "unknown");
    assert.equal(entry.avgFillPrice, null);
  });

  it("derives mode from buy trade, not hardcoded", () => {
    writeSignals([
      { type: "signal_close", signal_id: "1|slug-a", slug: "slug-a", ts_close: 2000, exit_price: 0.999, close_reason: "resolved" },
    ]);
    writeExecs([]);
    writeExecState({ trades: { "buy:1|slug-a": { side: "BUY", closed: true, slug: "slug-a", mode: "shadow_live", filledShares: 10 } } });

    const r = reconcileExecutionsFromSignals(TEST_DIR, { mode: "live" });
    assert.equal(r.items[0].mode, "shadow_live"); // from buy, NOT from opts
  });

  it("falls back to opts.mode when buy has no mode", () => {
    writeSignals([
      { type: "signal_close", signal_id: "1|slug-a", slug: "slug-a", ts_close: 2000, exit_price: 0.999, close_reason: "resolved" },
    ]);
    writeExecs([]);
    writeExecState({ trades: { "buy:1|slug-a": { side: "BUY", closed: true, slug: "slug-a", filledShares: 10 } } });

    const r = reconcileExecutionsFromSignals(TEST_DIR, { mode: "live" });
    assert.equal(r.items[0].mode, "live"); // from opts fallback
  });

  it("handles multiple gaps at once", () => {
    writeSignals([
      { type: "signal_close", signal_id: "1|a", slug: "a", ts_close: 1000, exit_price: 0.999, close_reason: "resolved" },
      { type: "signal_close", signal_id: "2|b", slug: "b", ts_close: 2000, exit_price: 0.80, close_reason: "stop_loss" },
      { type: "signal_open", signal_id: "3|c", slug: "c", ts_open: 3000 }, // not a close, should be ignored
    ]);
    writeExecs([]);
    writeExecState({
      trades: {
        "buy:1|a": { side: "BUY", closed: true, slug: "a", filledShares: 10 },
        "buy:2|b": { side: "BUY", closed: true, slug: "b", filledShares: 8 },
      }
    });

    const r = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r.added, 2);
    assert.equal(r.items[0].slug, "a");
    assert.equal(r.items[0].close_reason, "resolved");
    assert.equal(r.items[1].slug, "b");
    assert.equal(r.items[1].close_reason, "stop_loss");
  });

  it("handles missing files gracefully", () => {
    // No signals.jsonl, no executions.jsonl, no execution_state.json
    const r = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r.added, 0);
    assert.equal(r.warnings.length, 0);
  });

  it("ignores signal_close with no signal_id", () => {
    writeSignals([
      { type: "signal_close", slug: "slug-a", ts_close: 2000 }, // no signal_id
    ]);
    writeExecs([]);
    writeExecState({ trades: {} });

    const r = reconcileExecutionsFromSignals(TEST_DIR);
    assert.equal(r.added, 0);
    assert.equal(r.warnings.length, 0); // silently skipped
  });
});
