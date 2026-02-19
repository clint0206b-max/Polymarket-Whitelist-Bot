/**
 * Tests for MAX RE-ENTRY GUARD
 *
 * When a slug has 2+ stop_loss entries in closed index,
 * new signals for that slug should be blocked.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const MAX_SL_PER_SLUG = 2;

// Simulate the guard logic (extracted from run.mjs)
function buildSlCountMap(closedIndex) {
  const slCountBySlug = new Map();
  for (const [, row] of Object.entries(closedIndex)) {
    if (row?.close_reason === "stop_loss" && row?.slug) {
      slCountBySlug.set(row.slug, (slCountBySlug.get(row.slug) || 0) + 1);
    }
  }
  return slCountBySlug;
}

function filterSignals(newOnes, closedIndex) {
  const slCountBySlug = buildSlCountMap(closedIndex);
  return newOnes.filter(s => {
    const slug = String(s.slug || "");
    const slCount = slCountBySlug.get(slug) || 0;
    return slCount < MAX_SL_PER_SLUG;
  });
}

describe("re-entry guard: max SL per slug", () => {

  it("allows first entry (0 prior SL)", () => {
    const signals = [{ slug: "cs2-test-2026-02-18", ts: 1000, probAsk: 0.94 }];
    const closed = {};
    const result = filterSignals(signals, closed);
    assert.equal(result.length, 1);
  });

  it("allows second entry (1 prior SL)", () => {
    const signals = [{ slug: "cs2-test-2026-02-18", ts: 2000, probAsk: 0.94 }];
    const closed = {
      "1000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "stop_loss" },
    };
    const result = filterSignals(signals, closed);
    assert.equal(result.length, 1);
  });

  it("blocks third entry (2 prior SL)", () => {
    const signals = [{ slug: "cs2-test-2026-02-18", ts: 3000, probAsk: 0.94 }];
    const closed = {
      "1000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "stop_loss" },
      "2000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "stop_loss" },
    };
    const result = filterSignals(signals, closed);
    assert.equal(result.length, 0);
  });

  it("blocks with 3+ prior SL", () => {
    const signals = [{ slug: "cs2-test-2026-02-18", ts: 4000, probAsk: 0.94 }];
    const closed = {
      "1000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "stop_loss" },
      "2000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "stop_loss" },
      "3000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "stop_loss" },
    };
    const result = filterSignals(signals, closed);
    assert.equal(result.length, 0);
  });

  it("resolved closes don't count toward SL limit", () => {
    const signals = [{ slug: "cs2-test-2026-02-18", ts: 3000, probAsk: 0.94 }];
    const closed = {
      "1000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "resolved" },
      "2000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "resolved" },
    };
    const result = filterSignals(signals, closed);
    assert.equal(result.length, 1);
  });

  it("mixed: 1 SL + 1 resolved = still allowed", () => {
    const signals = [{ slug: "cs2-test-2026-02-18", ts: 3000, probAsk: 0.94 }];
    const closed = {
      "1000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "stop_loss" },
      "2000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "resolved" },
    };
    const result = filterSignals(signals, closed);
    assert.equal(result.length, 1);
  });

  it("mixed: 1 SL + 1 resolved + 1 SL = blocked", () => {
    const signals = [{ slug: "cs2-test-2026-02-18", ts: 4000, probAsk: 0.94 }];
    const closed = {
      "1000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "stop_loss" },
      "2000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "resolved" },
      "3000|cs2-test-2026-02-18": { slug: "cs2-test-2026-02-18", close_reason: "stop_loss" },
    };
    const result = filterSignals(signals, closed);
    assert.equal(result.length, 0);
  });

  it("different slugs are independent", () => {
    const signals = [
      { slug: "cs2-blocked-2026-02-18", ts: 3000, probAsk: 0.94 },
      { slug: "cs2-allowed-2026-02-18", ts: 3001, probAsk: 0.95 },
    ];
    const closed = {
      "1000|cs2-blocked-2026-02-18": { slug: "cs2-blocked-2026-02-18", close_reason: "stop_loss" },
      "2000|cs2-blocked-2026-02-18": { slug: "cs2-blocked-2026-02-18", close_reason: "stop_loss" },
      "1000|cs2-allowed-2026-02-18": { slug: "cs2-allowed-2026-02-18", close_reason: "stop_loss" },
    };
    const result = filterSignals(signals, closed);
    assert.equal(result.length, 1);
    assert.equal(result[0].slug, "cs2-allowed-2026-02-18");
  });

  it("empty closed index allows everything", () => {
    const signals = [
      { slug: "a", ts: 1, probAsk: 0.94 },
      { slug: "b", ts: 2, probAsk: 0.95 },
    ];
    const result = filterSignals(signals, {});
    assert.equal(result.length, 2);
  });

  it("empty signals returns empty", () => {
    const closed = {
      "1|x": { slug: "x", close_reason: "stop_loss" },
      "2|x": { slug: "x", close_reason: "stop_loss" },
    };
    const result = filterSignals([], closed);
    assert.equal(result.length, 0);
  });

  it("null/undefined close_reason doesn't count", () => {
    const signals = [{ slug: "test", ts: 2000, probAsk: 0.94 }];
    const closed = {
      "1|test": { slug: "test", close_reason: null },
      "2|test": { slug: "test" },  // undefined close_reason
    };
    const result = filterSignals(signals, closed);
    assert.equal(result.length, 1);
  });
});
