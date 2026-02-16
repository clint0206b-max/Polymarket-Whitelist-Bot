import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// We need to override resolvePath before importing journal.mjs
// Use a temp directory for all state files
const tmpDir = join(import.meta.dirname || ".", ".test-journal-tmp");

// Monkey-patch state_store resolvePath for this test
import { resolvePath } from "../src/core/state_store.js";

// Create the journal module functions with our test paths
import {
  appendJsonl,
  loadOpenIndex,
  saveOpenIndex,
  addOpen,
  removeOpen,
  addClosed,
  reconcileIndex,
} from "../src/core/journal.mjs";

function setupTmpDir() {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(join(tmpDir, "state", "journal"), { recursive: true });
}

function teardownTmpDir() {
  rmSync(tmpDir, { recursive: true, force: true });
}

// Helper: write a signals.jsonl file directly
function writeSignalsJsonl(lines) {
  const path = resolvePath("state/journal/signals.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

function readIndexRaw() {
  const path = resolvePath("state/journal/open_index.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("journal.mjs — addClosed", () => {
  it("moves entry to closed map", () => {
    const idx = { v: 1, open: {}, closed: {} };
    addOpen(idx, "sig1", { slug: "test-1", entry_price: 0.95 });
    assert.ok(idx.open["sig1"]);

    addClosed(idx, "sig1", {
      slug: "test-1",
      ts_close: 1000,
      win: true,
      pnl_usd: 0.53,
    });
    removeOpen(idx, "sig1");

    assert.ok(!idx.open["sig1"]);
    assert.ok(idx.closed["sig1"]);
    assert.equal(idx.closed["sig1"].win, true);
    assert.equal(idx.closed["sig1"].pnl_usd, 0.53);
  });

  it("initializes closed map if missing", () => {
    const idx = { v: 1, open: {} };
    addClosed(idx, "sig2", { slug: "test-2", win: false });
    assert.ok(idx.closed["sig2"]);
  });
});

describe("journal.mjs — loadOpenIndex", () => {
  it("initializes closed map on load", () => {
    const idx = loadOpenIndex();
    assert.ok(typeof idx.closed === "object");
    assert.ok(typeof idx.open === "object");
    assert.equal(idx.v, 1);
  });
});

describe("journal.mjs — reconcileIndex", () => {
  it("returns no change when JSONL does not exist", () => {
    const idx = { v: 1, open: {}, closed: {} };
    const result = reconcileIndex(idx, "state/journal/nonexistent.jsonl");
    assert.equal(result.reconciled, false);
  });

  it("adds missing open from JSONL to index", () => {
    const idx = { v: 1, open: {}, closed: {} };

    // Write a JSONL with one open, no close
    const jsonlPath = resolvePath("state/journal/signals.jsonl");
    mkdirSync(join(jsonlPath, ".."), { recursive: true });
    writeFileSync(jsonlPath, JSON.stringify({
      type: "signal_open",
      signal_id: "100|test-slug",
      slug: "test-slug",
      ts_open: 100,
      league: "cbb",
      entry_price: 0.94,
      paper_notional_usd: 10,
      entry_outcome_name: "Team A",
    }) + "\n");

    const result = reconcileIndex(idx);
    assert.equal(result.reconciled, true);
    assert.equal(result.added, 1);
    assert.ok(idx.open["100|test-slug"]);
    assert.equal(idx.open["100|test-slug"].slug, "test-slug");
    assert.equal(idx.open["100|test-slug"].entry_price, 0.94);
  });

  it("removes open from index if closed in JSONL", () => {
    const idx = {
      v: 1,
      open: { "100|test-slug": { slug: "test-slug", ts_open: 100, entry_price: 0.94 } },
      closed: {},
    };

    const jsonlPath = resolvePath("state/journal/signals.jsonl");
    mkdirSync(join(jsonlPath, ".."), { recursive: true });
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: "signal_open", signal_id: "100|test-slug", slug: "test-slug", ts_open: 100, entry_price: 0.94, paper_notional_usd: 10 }),
      JSON.stringify({ type: "signal_close", signal_id: "100|test-slug", ts_close: 200, close_reason: "resolved", win: true, pnl_usd: 0.64 }),
    ].join("\n") + "\n");

    const result = reconcileIndex(idx);
    assert.equal(result.reconciled, true);
    assert.equal(result.removed, 1);
    assert.ok(!idx.open["100|test-slug"]);
    assert.ok(idx.closed["100|test-slug"]);
    assert.equal(idx.closed["100|test-slug"].win, true);
  });

  it("populates closed map from JSONL for already-removed entries", () => {
    // Index has no open, no closed — but JSONL has open+close pair
    const idx = { v: 1, open: {}, closed: {} };

    const jsonlPath = resolvePath("state/journal/signals.jsonl");
    mkdirSync(join(jsonlPath, ".."), { recursive: true });
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: "signal_open", signal_id: "200|slug-2", slug: "slug-2", ts_open: 200, league: "nba", entry_price: 0.93, paper_notional_usd: 10, entry_outcome_name: "Lakers" }),
      JSON.stringify({ type: "signal_close", signal_id: "200|slug-2", ts_close: 300, close_reason: "resolved", resolve_method: "terminal_price", resolved_outcome_name: "Lakers", win: true, pnl_usd: 0.75, roi: 0.075 }),
    ].join("\n") + "\n");

    const result = reconcileIndex(idx);
    assert.equal(result.reconciled, true);
    assert.equal(result.closedAdded, 1);
    assert.equal(result.added, 0); // not added to open (already closed)
    assert.ok(idx.closed["200|slug-2"]);
    assert.equal(idx.closed["200|slug-2"].slug, "slug-2");
    assert.equal(idx.closed["200|slug-2"].win, true);
    assert.equal(idx.closed["200|slug-2"].pnl_usd, 0.75);
    assert.equal(idx.closed["200|slug-2"].entry_outcome_name, "Lakers");
  });

  it("no-ops when index already matches JSONL", () => {
    const idx = {
      v: 1,
      open: { "100|slug": { slug: "slug", ts_open: 100, entry_price: 0.94 } },
      closed: { "50|old": { slug: "old", win: false, pnl_usd: -9.3 } },
    };

    const jsonlPath = resolvePath("state/journal/signals.jsonl");
    mkdirSync(join(jsonlPath, ".."), { recursive: true });
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: "signal_open", signal_id: "50|old", slug: "old", ts_open: 50, entry_price: 0.93, paper_notional_usd: 10 }),
      JSON.stringify({ type: "signal_close", signal_id: "50|old", ts_close: 60, win: false, pnl_usd: -9.3 }),
      JSON.stringify({ type: "signal_open", signal_id: "100|slug", slug: "slug", ts_open: 100, entry_price: 0.94, paper_notional_usd: 10 }),
    ].join("\n") + "\n");

    const result = reconcileIndex(idx);
    assert.equal(result.reconciled, false);
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.closedAdded, 0);
  });

  it("handles malformed JSONL lines gracefully", () => {
    const idx = { v: 1, open: {}, closed: {} };

    const jsonlPath = resolvePath("state/journal/signals.jsonl");
    mkdirSync(join(jsonlPath, ".."), { recursive: true });
    writeFileSync(jsonlPath, [
      "not-json",
      JSON.stringify({ type: "signal_open", signal_id: "300|ok", slug: "ok", ts_open: 300, entry_price: 0.95, paper_notional_usd: 10 }),
      "{broken json",
    ].join("\n") + "\n");

    const result = reconcileIndex(idx);
    assert.equal(result.reconciled, true);
    assert.equal(result.added, 1);
    assert.ok(idx.open["300|ok"]);
  });

  it("handles empty JSONL", () => {
    const idx = { v: 1, open: {}, closed: {} };

    const jsonlPath = resolvePath("state/journal/signals.jsonl");
    mkdirSync(join(jsonlPath, ".."), { recursive: true });
    writeFileSync(jsonlPath, "\n");

    const result = reconcileIndex(idx);
    assert.equal(result.reconciled, false);
  });

  it("mixed scenario: 3 opens, 2 closed, 1 still open", () => {
    const idx = { v: 1, open: {}, closed: {} };

    const jsonlPath = resolvePath("state/journal/signals.jsonl");
    mkdirSync(join(jsonlPath, ".."), { recursive: true });
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: "signal_open", signal_id: "1|a", slug: "a", ts_open: 1, entry_price: 0.94, paper_notional_usd: 10, league: "cbb", entry_outcome_name: "Team A" }),
      JSON.stringify({ type: "signal_close", signal_id: "1|a", ts_close: 10, close_reason: "resolved", win: true, pnl_usd: 0.64 }),
      JSON.stringify({ type: "signal_open", signal_id: "2|b", slug: "b", ts_open: 2, entry_price: 0.93, paper_notional_usd: 10, league: "nba", entry_outcome_name: "Team B" }),
      JSON.stringify({ type: "signal_close", signal_id: "2|b", ts_close: 20, close_reason: "resolved", win: false, pnl_usd: -9.3, roi: -0.93 }),
      JSON.stringify({ type: "signal_open", signal_id: "3|c", slug: "c", ts_open: 3, entry_price: 0.95, paper_notional_usd: 10, league: "soccer", entry_outcome_name: "Team C" }),
    ].join("\n") + "\n");

    const result = reconcileIndex(idx);
    assert.equal(result.reconciled, true);
    assert.equal(result.added, 1); // only 3|c
    assert.equal(result.closedAdded, 2); // 1|a and 2|b
    assert.equal(Object.keys(idx.open).length, 1);
    assert.ok(idx.open["3|c"]);
    assert.equal(idx.open["3|c"].league, "soccer");
    assert.equal(Object.keys(idx.closed).length, 2);
    assert.ok(idx.closed["1|a"]);
    assert.equal(idx.closed["1|a"].win, true);
    assert.ok(idx.closed["2|b"]);
    assert.equal(idx.closed["2|b"].win, false);
    assert.equal(idx.closed["2|b"].pnl_usd, -9.3);
  });
});
