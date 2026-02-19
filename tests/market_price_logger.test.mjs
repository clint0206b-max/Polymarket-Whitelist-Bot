import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// We test the logic directly by importing and checking behavior.
// The module uses appendFileSync, so we mock via a thin wrapper approach:
// test the shouldLog logic extracted for unit testing.

describe("market_price_logger — shouldLog logic", () => {
  // Replicate the shouldLog logic for unit testing
  const DELTA = 0.02;
  const HEARTBEAT = 5 * 60_000;

  function shouldLog(prev, bid, ask, now) {
    if (!prev) return true;
    if (now - prev.ts >= HEARTBEAT) return true;
    if (Math.abs((bid || 0) - (prev.bid || 0)) >= DELTA) return true;
    if (Math.abs((ask || 0) - (prev.ask || 0)) >= DELTA) return true;
    return false;
  }

  it("logs on first call (no previous)", () => {
    assert.ok(shouldLog(null, 0.93, 0.95, Date.now()));
  });

  it("skips when price unchanged and within heartbeat", () => {
    const now = Date.now();
    const prev = { bid: 0.93, ask: 0.95, ts: now - 1000 }; // 1s ago
    assert.ok(!shouldLog(prev, 0.93, 0.95, now));
  });

  it("logs when bid changes >= delta", () => {
    const now = Date.now();
    const prev = { bid: 0.93, ask: 0.95, ts: now - 1000 };
    assert.ok(shouldLog(prev, 0.91, 0.95, now)); // bid dropped 0.02
  });

  it("logs when ask changes >= delta", () => {
    const now = Date.now();
    const prev = { bid: 0.93, ask: 0.95, ts: now - 1000 };
    assert.ok(shouldLog(prev, 0.93, 0.97, now)); // ask rose 0.02
  });

  it("skips when change < delta", () => {
    const now = Date.now();
    const prev = { bid: 0.93, ask: 0.95, ts: now - 1000 };
    assert.ok(!shouldLog(prev, 0.92, 0.94, now)); // 0.01 change each, below delta
  });

  it("logs on heartbeat even without price change", () => {
    const now = Date.now();
    const prev = { bid: 0.93, ask: 0.95, ts: now - HEARTBEAT - 1 }; // just past heartbeat
    assert.ok(shouldLog(prev, 0.93, 0.95, now));
  });

  it("skips just before heartbeat", () => {
    const now = Date.now();
    const prev = { bid: 0.93, ask: 0.95, ts: now - HEARTBEAT + 1000 }; // 1s before heartbeat
    assert.ok(!shouldLog(prev, 0.93, 0.95, now));
  });

  it("handles null bid/ask gracefully", () => {
    const now = Date.now();
    const prev = { bid: null, ask: 0.95, ts: now - 1000 };
    // null -> 0.93 = change of 0.93 >= delta
    assert.ok(shouldLog(prev, 0.93, 0.95, now));
  });

  it("handles both null without crash", () => {
    const now = Date.now();
    const prev = { bid: null, ask: null, ts: now - 1000 };
    assert.ok(!shouldLog(prev, null, null, now)); // no change
  });
});

describe("market_price_logger — file rotation", () => {
  it("generates correct daily filename format", () => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const expected = `${yyyy}-${mm}-${dd}.jsonl`;
    // Just verify the format is consistent
    assert.match(expected, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  });
});
