/**
 * Tests for reconcileIndex — ensures open_index stays in sync with reality.
 *
 * KEY BUG TESTED: signal_close in journal should NOT move position to closed
 * if the sell hasn't actually completed (buy.closed still false in execution_state).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// We need to set SHADOW_ID to isolate state dir for tests
const TEST_DIR = join(process.cwd(), "state-test-reconcile");
const JOURNAL_DIR = join(TEST_DIR, "journal");

// reconcileIndex uses resolvePath which depends on SHADOW_ID
// We'll write files to the default state dir and clean up

import { reconcileIndex, loadOpenIndex, saveOpenIndex } from "../src/core/journal.mjs";
import { resolvePath } from "../src/core/state_store.js";

function writeSignals(lines) {
  const dir = resolvePath("state/journal");
  mkdirSync(dir, { recursive: true });
  const path = resolvePath("state/journal/signals.jsonl");
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

function writeExecState(trades) {
  const path = resolvePath("state/execution_state.json");
  writeFileSync(path, JSON.stringify({ trades }));
}

function cleanupExecState() {
  try { rmSync(resolvePath("state/execution_state.json")); } catch {}
}

describe("reconcileIndex", () => {

  beforeEach(() => {
    cleanupExecState();
  });

  it("keeps position open when signal_close exists but buy.closed=false", () => {
    const signalId = "123|test-slug";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "test-slug", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: signalId, slug: "test-slug", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
    ]);

    // Buy filled but NOT closed (sell failed)
    writeExecState({
      [`buy:${signalId}`]: { status: "filled", closed: false, signal_id: signalId, side: "BUY" },
    });

    const index = { v: 1, open: { [signalId]: { slug: "test-slug" } }, closed: {} };
    const result = reconcileIndex(index);

    assert.ok(index.open[signalId], "should stay in open because buy.closed=false");
    assert.equal(result.removed, 0, "nothing should be removed");
  });

  it("moves to closed when signal_close exists AND buy.closed=true", () => {
    const signalId = "456|sold-slug";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "sold-slug", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: signalId, slug: "sold-slug", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
    ]);

    // Buy filled AND closed (sell succeeded)
    writeExecState({
      [`buy:${signalId}`]: { status: "filled", closed: true, signal_id: signalId, side: "BUY" },
    });

    const index = { v: 1, open: { [signalId]: { slug: "sold-slug" } }, closed: {} };
    const result = reconcileIndex(index);

    assert.equal(index.open[signalId], undefined, "should be removed from open");
    assert.equal(result.removed, 1);
  });

  it("moves to closed when signal_close exists and no execution_state entry (paper mode)", () => {
    const signalId = "789|paper-slug";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "paper-slug", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: signalId, slug: "paper-slug", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
    ]);

    // No execution_state entry (paper mode — no real trades)
    writeExecState({});

    const index = { v: 1, open: { [signalId]: { slug: "paper-slug" } }, closed: {} };
    const result = reconcileIndex(index);

    assert.equal(index.open[signalId], undefined, "paper trades close normally");
    assert.equal(result.removed, 1);
  });

  it("moves to closed when execution_state.json doesn't exist", () => {
    const signalId = "101|no-exec";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "no-exec", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: signalId, slug: "no-exec", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
    ]);

    cleanupExecState(); // ensure no file

    const index = { v: 1, open: { [signalId]: { slug: "no-exec" } }, closed: {} };
    const result = reconcileIndex(index);

    assert.equal(index.open[signalId], undefined, "should close when no exec state file");
  });

  it("adds missing opens from journal", () => {
    const signalId = "201|missing";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "missing-slug", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
    ]);

    const index = { v: 1, open: {}, closed: {} };
    const result = reconcileIndex(index);

    assert.ok(index.open[signalId], "should add missing open from journal");
    assert.equal(result.added, 1);
  });

  it("does not add open if already closed in journal", () => {
    const signalId = "301|already-closed";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "done", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: signalId, slug: "done", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
    ]);

    writeExecState({
      [`buy:${signalId}`]: { status: "filled", closed: true, signal_id: signalId, side: "BUY" },
    });

    const index = { v: 1, open: {}, closed: {} };
    const result = reconcileIndex(index);

    assert.equal(index.open[signalId], undefined, "should not add if already closed");
    assert.equal(result.added, 0);
  });

  it("handles multiple positions: some closed, some stuck", () => {
    const closed1 = "401|closed";
    const stuck1 = "402|stuck";
    const open1 = "403|still-open";

    writeSignals([
      { type: "signal_open", signal_id: closed1, slug: "closed-ok", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: closed1, slug: "closed-ok", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
      { type: "signal_open", signal_id: stuck1, slug: "stuck-pos", ts_open: 1000, entry_price: 0.94, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: stuck1, slug: "stuck-pos", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.65 },
      { type: "signal_open", signal_id: open1, slug: "still-open", ts_open: 1000, entry_price: 0.95, paper_notional_usd: 10, league: "cs2" },
    ]);

    writeExecState({
      [`buy:${closed1}`]: { status: "filled", closed: true, signal_id: closed1, side: "BUY" },
      [`buy:${stuck1}`]: { status: "filled", closed: false, signal_id: stuck1, side: "BUY" }, // sell failed!
    });

    const index = {
      v: 1,
      open: {
        [closed1]: { slug: "closed-ok" },
        [stuck1]: { slug: "stuck-pos" },
        [open1]: { slug: "still-open" },
      },
      closed: {},
    };

    const result = reconcileIndex(index);

    assert.equal(index.open[closed1], undefined, "closed1 should be removed (sell completed)");
    assert.ok(index.open[stuck1], "stuck1 should stay open (sell failed)");
    assert.ok(index.open[open1], "open1 should stay open (no close signal)");
    assert.equal(result.removed, 1, "only 1 removed");
  });
});
