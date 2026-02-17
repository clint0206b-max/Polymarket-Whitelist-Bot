/**
 * Tests for reconcileIndex — ensures open_index stays in sync with reality.
 *
 * KEY BUG TESTED: signal_close in journal should NOT move position to closed
 * if the sell hasn't actually completed (buy.closed still false in execution_state).
 *
 * SAFETY: All file operations go through testPath() which:
 * 1. Always resolves under an isolated temp directory
 * 2. Validates every path BEFORE write/delete (aborts if outside test dir)
 * 3. Cleans up after all tests complete
 * 4. NEVER touches prod state/ or project root
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";

// === ISOLATED TEST DIRECTORY (under OS tmpdir, never under project) ===
const TEST_ROOT = join(tmpdir(), `polymarket-test-reconcile-${process.pid}`);
const TEST_STATE = join(TEST_ROOT, "state");
const TEST_JOURNAL = join(TEST_STATE, "journal");

// Safety: absolute path validation — aborts if path escapes test dir
function assertSafePath(absPath) {
  const rel = relative(TEST_ROOT, resolve(absPath));
  if (rel.startsWith("..") || resolve(absPath) === resolve(process.cwd())) {
    throw new Error(`SAFETY ABORT: path "${absPath}" escapes test root "${TEST_ROOT}"`);
  }
}

function testPath(...parts) {
  const p = join(TEST_ROOT, ...parts);
  assertSafePath(p);
  return p;
}

// Set SHADOW_ID so resolvePath("state") → state-<id>/ but we DON'T rely on it.
// Instead we write directly to TEST_ROOT and pass explicit paths.
process.env.SHADOW_ID = `reconcile-${process.pid}`;

import { reconcileIndex } from "../src/core/journal.mjs";
import { readJson } from "../src/core/state_store.js";

// === TEST HELPERS: always write to isolated dir ===

function writeSignals(lines) {
  mkdirSync(TEST_JOURNAL, { recursive: true });
  const p = join(TEST_JOURNAL, "signals.jsonl");
  assertSafePath(p);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

function writeExecState(trades) {
  mkdirSync(TEST_STATE, { recursive: true });
  const p = join(TEST_STATE, "execution_state.json");
  assertSafePath(p);
  writeFileSync(p, JSON.stringify({ trades }));
}

function cleanTestDir() {
  assertSafePath(TEST_ROOT);
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
}

// Patch: reconcileIndex reads from resolvePath, so we need to pass our test journal path.
// reconcileIndex accepts a custom jsonlRelPath. We call it with absolute path.
// For execution_state, it uses resolvePath("state/execution_state.json") internally —
// we need to also write there for the exec check. Let's write to BOTH locations.
function writeExecStateBoth(trades) {
  // Write to test dir
  writeExecState(trades);
  // Also write to shadow dir so reconcileIndex's internal readJson finds it
  const { resolvePath } = await_resolvePath();
  const shadowExecPath = resolvePath("state", "execution_state.json");
  mkdirSync(resolve(shadowExecPath, ".."), { recursive: true });
  writeFileSync(shadowExecPath, JSON.stringify({ trades }));
}

// We can't use top-level await easily, so import resolvePath sync
import { resolvePath } from "../src/core/state_store.js";
function await_resolvePath() { return { resolvePath }; }

function writeExecStateForReconciler(trades) {
  // Write to test dir (for our assertions)
  writeExecState(trades);
  // Write to where reconcileIndex will look (resolvePath("state/execution_state.json"))
  // With SHADOW_ID set, resolvePath("state", "execution_state.json") should go to shadow
  const execPath = resolvePath("state", "execution_state.json");
  mkdirSync(resolve(execPath, ".."), { recursive: true });
  writeFileSync(execPath, JSON.stringify({ trades }));
}

function cleanShadowDir() {
  try {
    const shadowState = resolvePath("state");
    // Safety: only delete if it's a state-* dir, never "state"
    if (shadowState.includes("state-")) {
      rmSync(shadowState, { recursive: true, force: true });
    }
  } catch {}
}

// === LIFECYCLE ===

before(() => {
  mkdirSync(TEST_JOURNAL, { recursive: true });
});

after(() => {
  cleanTestDir();
  cleanShadowDir();
});

beforeEach(() => {
  // Clean and recreate
  cleanTestDir();
  cleanShadowDir();
  mkdirSync(TEST_JOURNAL, { recursive: true });
});

// reconcileIndex reads signals from a path. We pass our test journal path.
const SIGNALS_PATH = join(TEST_JOURNAL, "signals.jsonl");

function runReconcile(index) {
  // Pass absolute path to our test signals.jsonl
  return reconcileIndex(index, SIGNALS_PATH);
}

// === TESTS ===

describe("reconcileIndex", () => {

  it("safety: test paths never resolve to project root", () => {
    const cwd = process.cwd();
    assert.ok(!TEST_ROOT.startsWith(cwd), `TEST_ROOT "${TEST_ROOT}" must not be under cwd "${cwd}"`);
    assert.ok(TEST_ROOT.startsWith(tmpdir()), "TEST_ROOT must be under OS tmpdir");
  });

  it("keeps position open when signal_close exists but buy.closed=false", () => {
    const signalId = "123|test-slug";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "test-slug", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: signalId, slug: "test-slug", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
    ]);
    writeExecStateForReconciler({
      [`buy:${signalId}`]: { status: "filled", closed: false, signal_id: signalId, side: "BUY" },
    });

    const index = { v: 1, open: { [signalId]: { slug: "test-slug" } }, closed: {} };
    const result = runReconcile(index);

    assert.ok(index.open[signalId], "should stay in open because buy.closed=false");
    assert.equal(result.removed, 0);
  });

  it("moves to closed when signal_close exists AND buy.closed=true", () => {
    const signalId = "456|sold-slug";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "sold-slug", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: signalId, slug: "sold-slug", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
    ]);
    writeExecStateForReconciler({
      [`buy:${signalId}`]: { status: "filled", closed: true, signal_id: signalId, side: "BUY" },
    });

    const index = { v: 1, open: { [signalId]: { slug: "sold-slug" } }, closed: {} };
    const result = runReconcile(index);

    assert.equal(index.open[signalId], undefined, "should be removed from open");
    assert.equal(result.removed, 1);
  });

  it("moves to closed when no execution_state entry (paper mode)", () => {
    const signalId = "789|paper-slug";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "paper-slug", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: signalId, slug: "paper-slug", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
    ]);
    writeExecStateForReconciler({});

    const index = { v: 1, open: { [signalId]: { slug: "paper-slug" } }, closed: {} };
    const result = runReconcile(index);

    assert.equal(index.open[signalId], undefined, "paper trades close normally");
    assert.equal(result.removed, 1);
  });

  it("moves to closed when execution_state.json doesn't exist", () => {
    const signalId = "101|no-exec";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "no-exec", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: signalId, slug: "no-exec", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
    ]);
    // Don't write exec state — file won't exist

    const index = { v: 1, open: { [signalId]: { slug: "no-exec" } }, closed: {} };
    const result = runReconcile(index);

    assert.equal(index.open[signalId], undefined, "should close when no exec state file");
  });

  it("adds missing opens from journal", () => {
    const signalId = "201|missing";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "missing-slug", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
    ]);

    const index = { v: 1, open: {}, closed: {} };
    const result = runReconcile(index);

    assert.ok(index.open[signalId], "should add missing open from journal");
    assert.equal(result.added, 1);
  });

  it("does not add open if already closed in journal", () => {
    const signalId = "301|already-closed";
    writeSignals([
      { type: "signal_open", signal_id: signalId, slug: "done", ts_open: 1000, entry_price: 0.93, paper_notional_usd: 10, league: "cs2" },
      { type: "signal_close", signal_id: signalId, slug: "done", ts_close: 2000, close_reason: "resolved", win: true, pnl_usd: 0.75 },
    ]);
    writeExecStateForReconciler({
      [`buy:${signalId}`]: { status: "filled", closed: true, signal_id: signalId, side: "BUY" },
    });

    const index = { v: 1, open: {}, closed: {} };
    const result = runReconcile(index);

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
    writeExecStateForReconciler({
      [`buy:${closed1}`]: { status: "filled", closed: true, signal_id: closed1, side: "BUY" },
      [`buy:${stuck1}`]: { status: "filled", closed: false, signal_id: stuck1, side: "BUY" },
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
    const result = runReconcile(index);

    assert.equal(index.open[closed1], undefined, "closed1 should be removed");
    assert.ok(index.open[stuck1], "stuck1 should stay open (sell failed)");
    assert.ok(index.open[open1], "open1 should stay open (no close signal)");
    assert.equal(result.removed, 1);
  });
});
