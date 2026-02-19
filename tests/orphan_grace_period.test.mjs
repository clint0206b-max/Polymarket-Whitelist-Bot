/**
 * Tests for orphan detection grace period in reconcilePositions.
 * 
 * The orphan detector marks trades as orphan_pending when their position
 * isn't found in the CLOB API. The grace period prevents false positives
 * from API indexing delay by requiring:
 *   1. ts_filled must exist (no decision without evidence)
 *   2. 3+ consecutive reconcile misses (_reconcile_misses >= 3)
 *   3. 5+ minutes since fill (fillAge >= 5 min)
 * 
 * We test the logic by directly simulating what reconcilePositions does
 * to the execState trades, without calling external APIs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Extracted orphan detection logic — mirrors the code in reconcilePositions.
 * Takes a trade object and context, returns { action, trade } with mutations applied.
 * action: "skip_no_ts" | "miss_counted" | "marked_orphan" | "position_found"
 */
function evaluateOrphanStatus(trade, { now, hasPosition }) {
  const ORPHAN_MIN_MISSES = 3;
  const ORPHAN_MIN_AGE_MS = 5 * 60 * 1000;

  if (hasPosition) {
    if (trade._reconcile_misses) delete trade._reconcile_misses;
    return { action: "position_found", trade };
  }

  // No position found
  if (!trade.ts_filled) {
    return { action: "skip_no_ts", trade };
  }

  const fillAge = now - trade.ts_filled;
  const misses = (trade._reconcile_misses || 0) + 1;
  trade._reconcile_misses = misses;

  if (misses < ORPHAN_MIN_MISSES || fillAge < ORPHAN_MIN_AGE_MS) {
    return { action: "miss_counted", trade };
  }

  trade.status = "orphan_pending";
  trade.orphan_detected_ts = now;
  trade.orphan_attempts = 0;
  delete trade._reconcile_misses;
  return { action: "marked_orphan", trade };
}

describe("orphan grace period", () => {
  const baseTrade = () => ({
    status: "filled",
    closed: false,
    side: "BUY",
    slug: "test-market-2026-02-19",
    tokenId: "12345",
    filledShares: 10,
    ts_filled: 1000000,
  });

  it("does not mark orphan on first miss (miss 1 of 3)", () => {
    const trade = baseTrade();
    const now = trade.ts_filled + 10 * 60 * 1000; // 10 min later
    const result = evaluateOrphanStatus(trade, { now, hasPosition: false });
    assert.equal(result.action, "miss_counted");
    assert.equal(trade.status, "filled");
    assert.equal(trade._reconcile_misses, 1);
  });

  it("does not mark orphan on second miss (miss 2 of 3)", () => {
    const trade = baseTrade();
    trade._reconcile_misses = 1;
    const now = trade.ts_filled + 10 * 60 * 1000;
    const result = evaluateOrphanStatus(trade, { now, hasPosition: false });
    assert.equal(result.action, "miss_counted");
    assert.equal(trade.status, "filled");
    assert.equal(trade._reconcile_misses, 2);
  });

  it("marks orphan on third miss with sufficient age", () => {
    const trade = baseTrade();
    trade._reconcile_misses = 2;
    const now = trade.ts_filled + 10 * 60 * 1000; // 10 min > 5 min threshold
    const result = evaluateOrphanStatus(trade, { now, hasPosition: false });
    assert.equal(result.action, "marked_orphan");
    assert.equal(trade.status, "orphan_pending");
    assert.equal(trade.orphan_attempts, 0);
    assert.ok(trade.orphan_detected_ts);
    assert.equal(trade._reconcile_misses, undefined); // cleaned up
  });

  it("does not mark orphan with 3 misses but insufficient age", () => {
    const trade = baseTrade();
    trade._reconcile_misses = 2;
    const now = trade.ts_filled + 2 * 60 * 1000; // 2 min < 5 min threshold
    const result = evaluateOrphanStatus(trade, { now, hasPosition: false });
    assert.equal(result.action, "miss_counted");
    assert.equal(trade.status, "filled");
    assert.equal(trade._reconcile_misses, 3);
  });

  it("skips orphan check when ts_filled is missing", () => {
    const trade = baseTrade();
    delete trade.ts_filled;
    const now = Date.now();
    const result = evaluateOrphanStatus(trade, { now, hasPosition: false });
    assert.equal(result.action, "skip_no_ts");
    assert.equal(trade.status, "filled");
    assert.equal(trade._reconcile_misses, undefined);
  });

  it("resets miss counter when position is found", () => {
    const trade = baseTrade();
    trade._reconcile_misses = 2;
    const now = trade.ts_filled + 10 * 60 * 1000;
    const result = evaluateOrphanStatus(trade, { now, hasPosition: true });
    assert.equal(result.action, "position_found");
    assert.equal(trade.status, "filled");
    assert.equal(trade._reconcile_misses, undefined);
  });

  it("survives restart: misses persist and accumulate across calls", () => {
    // Simulate 3 reconcile cycles with serialization between each
    const trade = baseTrade();
    const now = trade.ts_filled + 10 * 60 * 1000;

    // Cycle 1
    evaluateOrphanStatus(trade, { now, hasPosition: false });
    assert.equal(trade._reconcile_misses, 1);
    const serialized1 = JSON.parse(JSON.stringify(trade)); // simulate persist + reload

    // Cycle 2
    evaluateOrphanStatus(serialized1, { now, hasPosition: false });
    assert.equal(serialized1._reconcile_misses, 2);
    const serialized2 = JSON.parse(JSON.stringify(serialized1));

    // Cycle 3 — should trigger
    const result = evaluateOrphanStatus(serialized2, { now, hasPosition: false });
    assert.equal(result.action, "marked_orphan");
    assert.equal(serialized2.status, "orphan_pending");
  });

  it("does not trigger when all misses happen within 5 min of fill", () => {
    const trade = baseTrade();
    // All 4 misses happen within 4 min of fill
    const now = trade.ts_filled + 4 * 60 * 1000;
    
    evaluateOrphanStatus(trade, { now, hasPosition: false }); // miss 1
    evaluateOrphanStatus(trade, { now, hasPosition: false }); // miss 2
    const result = evaluateOrphanStatus(trade, { now, hasPosition: false }); // miss 3 but age < 5 min
    
    assert.equal(result.action, "miss_counted");
    assert.equal(trade.status, "filled");
    assert.equal(trade._reconcile_misses, 3);
  });

  it("triggers on miss 4 if age crosses threshold", () => {
    const trade = baseTrade();
    trade._reconcile_misses = 3; // already had 3 misses within grace
    const now = trade.ts_filled + 6 * 60 * 1000; // now age > 5 min
    const result = evaluateOrphanStatus(trade, { now, hasPosition: false });
    assert.equal(result.action, "marked_orphan");
    assert.equal(trade.status, "orphan_pending");
  });
});
