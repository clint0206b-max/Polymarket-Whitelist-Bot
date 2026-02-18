import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compute_depth_metrics, is_depth_sufficient } from "../src/strategy/stage2.mjs";

// Helper: build a simple order book
function makeBook(askLevels, bidLevels) {
  return {
    asks: askLevels.map(([price, size]) => ({ price, size })),
    bids: bidLevels.map(([price, size]) => ({ price, size })),
  };
}

describe("depth filter with min_entry_depth_usd_ask = 500", () => {
  const cfg500 = { filters: { min_entry_depth_usd_ask: 500, min_exit_depth_usd_bid: 2000, max_entry_price: 0.98 } };
  const cfg1000 = { filters: { min_entry_depth_usd_ask: 1000, min_exit_depth_usd_bid: 2000, max_entry_price: 0.98 } };

  it("$600 entry depth passes at 500 threshold", () => {
    // 600 shares at $0.94 = ~$564 depth
    const book = makeBook([[0.94, 600]], [[0.90, 3000]]);
    const metrics = compute_depth_metrics(book, cfg500);
    const result = is_depth_sufficient(metrics, cfg500);
    assert.equal(result.pass, true, `expected pass=true, got reason=${result.reason}`);
  });

  it("$600 entry depth FAILS at 1000 threshold (old config)", () => {
    const book = makeBook([[0.94, 600]], [[0.90, 3000]]);
    const metrics = compute_depth_metrics(book, cfg1000);
    const result = is_depth_sufficient(metrics, cfg1000);
    assert.equal(result.pass, false);
    assert.equal(result.reason, "depth_ask_below_min");
  });

  it("$300 entry depth fails at 500 threshold", () => {
    const book = makeBook([[0.94, 300]], [[0.90, 3000]]);
    const metrics = compute_depth_metrics(book, cfg500);
    const result = is_depth_sufficient(metrics, cfg500);
    assert.equal(result.pass, false);
    assert.equal(result.reason, "depth_ask_below_min");
  });

  it("exactly $500 entry depth passes at 500 threshold", () => {
    // ~532 shares at $0.94 = $500.08
    const book = makeBook([[0.94, 533]], [[0.90, 3000]]);
    const metrics = compute_depth_metrics(book, cfg500);
    const result = is_depth_sufficient(metrics, cfg500);
    assert.equal(result.pass, true);
  });

  it("exit depth still requires $2000 (unchanged)", () => {
    const book = makeBook([[0.94, 1000]], [[0.90, 1000]]);
    const metrics = compute_depth_metrics(book, cfg500);
    const result = is_depth_sufficient(metrics, cfg500);
    assert.equal(result.pass, false);
    assert.equal(result.reason, "depth_bid_below_min");
  });

  it("both depths sufficient passes", () => {
    const book = makeBook([[0.94, 1000]], [[0.90, 3000]]);
    const metrics = compute_depth_metrics(book, cfg500);
    const result = is_depth_sufficient(metrics, cfg500);
    assert.equal(result.pass, true);
  });
});
