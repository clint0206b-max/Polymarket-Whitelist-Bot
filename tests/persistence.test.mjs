/**
 * Persistence Tests (v1.0)
 * 
 * Validates atomic write, backup rotation, recovery, and dirty tracking.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeJsonAtomic, readJsonWithFallback } from "../src/core/state_store.js";
import { DirtyTracker, detectChanges } from "../src/core/dirty_tracker.mjs";

const TEST_DIR = resolve(process.cwd(), "state", "test-persistence");
const TEST_FILE = resolve(TEST_DIR, "test.json");
const TEST_BAK = `${TEST_FILE}.bak`;
const TEST_TMP = `${TEST_FILE}.tmp`;

// Cleanup helper
function cleanup() {
  for (const path of [TEST_FILE, TEST_BAK, TEST_TMP]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

describe("writeJsonAtomic", () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  beforeEach(cleanup);
  after(cleanup);

  it("writes valid JSON to disk", () => {
    const obj = { foo: "bar", num: 42 };
    writeJsonAtomic(TEST_FILE, obj);

    assert.ok(existsSync(TEST_FILE));
    const raw = readFileSync(TEST_FILE, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, obj);
  });

  it("creates backup of existing file", () => {
    const obj1 = { version: 1 };
    const obj2 = { version: 2 };

    // Write initial file
    writeJsonAtomic(TEST_FILE, obj1);
    assert.ok(existsSync(TEST_FILE));
    assert.ok(!existsSync(TEST_BAK));

    // Write again → should create backup
    writeJsonAtomic(TEST_FILE, obj2);
    assert.ok(existsSync(TEST_FILE));
    assert.ok(existsSync(TEST_BAK));

    // Backup should contain obj1, file should contain obj2
    const bak = JSON.parse(readFileSync(TEST_BAK, "utf8"));
    const cur = JSON.parse(readFileSync(TEST_FILE, "utf8"));
    assert.deepEqual(bak, obj1);
    assert.deepEqual(cur, obj2);
  });

  it("overwrites existing file atomically", () => {
    const obj1 = { data: "old" };
    const obj2 = { data: "new" };

    writeJsonAtomic(TEST_FILE, obj1);
    writeJsonAtomic(TEST_FILE, obj2);

    const cur = JSON.parse(readFileSync(TEST_FILE, "utf8"));
    assert.deepEqual(cur, obj2);
  });

  it("never leaves .tmp file after write", () => {
    const obj = { test: true };
    writeJsonAtomic(TEST_FILE, obj);

    assert.ok(!existsSync(TEST_TMP), "tmp file should be cleaned up");
  });

  it("can disable backup with opts.backup=false", () => {
    const obj1 = { v: 1 };
    const obj2 = { v: 2 };

    writeJsonAtomic(TEST_FILE, obj1, { backup: false });
    writeJsonAtomic(TEST_FILE, obj2, { backup: false });

    assert.ok(existsSync(TEST_FILE));
    assert.ok(!existsSync(TEST_BAK), "backup should not be created when disabled");
  });
});

describe("readJsonWithFallback", () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  beforeEach(cleanup);
  after(cleanup);

  it("returns null if file doesn't exist", () => {
    const result = readJsonWithFallback(TEST_FILE);
    assert.equal(result, null);
  });

  it("returns parsed JSON if file is valid", () => {
    const obj = { test: "data" };
    writeJsonAtomic(TEST_FILE, obj);

    const result = readJsonWithFallback(TEST_FILE);
    assert.deepEqual(result, obj);
  });

  it("falls back to .bak if primary is corrupted", () => {
    const goodObj = { version: 1 };
    const badJson = "{ invalid json }";

    // Write valid backup
    writeJsonAtomic(TEST_BAK, goodObj, { backup: false });

    // Write corrupted primary
    writeFileSync(TEST_FILE, badJson, "utf8");

    const result = readJsonWithFallback(TEST_FILE);
    assert.deepEqual(result, goodObj);
  });

  it("returns null if both primary and backup are corrupted", () => {
    writeFileSync(TEST_FILE, "{ bad", "utf8");
    writeFileSync(TEST_BAK, "} also bad", "utf8");

    const result = readJsonWithFallback(TEST_FILE);
    assert.equal(result, null);
  });

  it("prefers primary file if both exist and valid", () => {
    const primaryObj = { source: "primary" };
    const backupObj = { source: "backup" };

    writeJsonAtomic(TEST_BAK, backupObj, { backup: false });
    writeJsonAtomic(TEST_FILE, primaryObj);

    const result = readJsonWithFallback(TEST_FILE);
    assert.deepEqual(result, primaryObj);
  });
});

describe("DirtyTracker", () => {
  it("initializes as clean", () => {
    const tracker = new DirtyTracker();
    assert.equal(tracker.isDirty(), false);
    assert.equal(tracker.isCritical(), false);
  });

  it("mark() sets dirty flag", () => {
    const tracker = new DirtyTracker();
    tracker.mark("test_reason");
    assert.equal(tracker.isDirty(), true);
  });

  it("mark() with critical=true sets critical flag", () => {
    const tracker = new DirtyTracker();
    tracker.mark("critical_event", true);
    assert.equal(tracker.isDirty(), true);
    assert.equal(tracker.isCritical(), true);
  });

  it("shouldPersist() returns true immediately for critical", () => {
    const tracker = new DirtyTracker();
    const now = Date.now();

    tracker.mark("critical", true);
    assert.equal(tracker.shouldPersist(now, { throttleMs: 10000 }), true);
  });

  it("shouldPersist() respects throttle for non-critical", () => {
    const tracker = new DirtyTracker();
    const now = Date.now();

    tracker.mark("non_critical", false);

    // Should persist if enough time passed
    tracker.lastWrite = now - 6000;
    assert.equal(tracker.shouldPersist(now, { throttleMs: 5000 }), true);

    // Should NOT persist if throttle window not elapsed
    tracker.lastWrite = now - 2000;
    assert.equal(tracker.shouldPersist(now, { throttleMs: 5000 }), false);
  });

  it("shouldPersist() returns false if not dirty", () => {
    const tracker = new DirtyTracker();
    const now = Date.now();

    assert.equal(tracker.shouldPersist(now, { throttleMs: 5000 }), false);
  });

  it("clear() resets dirty and critical flags", () => {
    const tracker = new DirtyTracker();
    const now = Date.now();

    tracker.mark("test", true);
    assert.equal(tracker.isDirty(), true);
    assert.equal(tracker.isCritical(), true);

    tracker.clear(now);
    assert.equal(tracker.isDirty(), false);
    assert.equal(tracker.isCritical(), false);
    assert.equal(tracker.lastWrite, now);
  });

  it("getReasons() returns list of reasons", () => {
    const tracker = new DirtyTracker();

    tracker.mark("reason1");
    tracker.mark("reason2");
    tracker.mark("reason3");

    const reasons = tracker.getReasons();
    assert.equal(reasons.length, 3);
    assert.ok(reasons.includes("reason1"));
    assert.ok(reasons.includes("reason2"));
    assert.ok(reasons.includes("reason3"));
  });

  it("getReasons() deduplicates repeated reasons", () => {
    const tracker = new DirtyTracker();

    tracker.mark("same_reason");
    tracker.mark("same_reason");
    tracker.mark("same_reason");

    const reasons = tracker.getReasons();
    assert.equal(reasons.length, 1);
    assert.equal(reasons[0], "same_reason");
  });
});

describe("detectChanges", () => {
  it("detects watchlist size change", () => {
    const before = { watchlist: { a: {}, b: {} } };
    const after = { watchlist: { a: {}, b: {}, c: {} } };

    const reasons = detectChanges(before, after);
    assert.ok(reasons.some(r => r.includes("watchlist_size_changed:2→3")));
  });

  it("detects status transitions", () => {
    const before = {
      watchlist: {
        id1: { status: "watching" },
        id2: { status: "pending_signal" }
      }
    };
    const after = {
      watchlist: {
        id1: { status: "watching" },
        id2: { status: "signaled" }
      }
    };

    const reasons = detectChanges(before, after);
    assert.ok(reasons.some(r => r.includes("status_transition:id2:pending_signal→signaled")));
  });

  it("detects signals generated", () => {
    const before = { runtime: { last_signals: [{ ts: 1 }] } };
    const after = { runtime: { last_signals: [{ ts: 1 }, { ts: 2 }, { ts: 3 }] } };

    const reasons = detectChanges(before, after);
    assert.ok(reasons.some(r => r.includes("signals_generated:2")));
  });

  it("returns empty array if no changes", () => {
    const state = { watchlist: { a: { status: "watching" } }, runtime: { last_signals: [] } };
    const reasons = detectChanges(state, state);
    assert.equal(reasons.length, 0);
  });

  it("handles missing watchlist gracefully", () => {
    const before = {};
    const after = { watchlist: { a: {} } };

    const reasons = detectChanges(before, after);
    assert.ok(reasons.some(r => r.includes("watchlist_size_changed")));
  });
});
