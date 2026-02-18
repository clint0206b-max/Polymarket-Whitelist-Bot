/**
 * Tests for TradeBridge.checkPositionsFromCLOB()
 *
 * Covers:
 * - Resolution signal generation (bid >= 0.995)
 * - Stop-loss signal generation (bid <= threshold)
 * - No signal when price is in normal range
 * - No signal for paper mode
 * - No signal when paused
 * - No signal for closed positions
 * - No signal for non-BUY trades
 * - No duplicate signal when sell already exists (the spam fix)
 * - Multiple positions: each gets independent signal
 * - Edge cases: exact threshold values, missing price data
 * - PnL calculation correctness
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// We test checkPositionsFromCLOB by constructing a TradeBridge-like object
// with minimal state, avoiding the full constructor (which needs CLOB client).

// Helper: create a minimal TradeBridge instance with just the fields
// checkPositionsFromCLOB needs (mode, execState, cfg).
function makeBridge({ mode = "live", trades = {}, paused = false, cfg = {} } = {}) {
  return {
    mode,
    execState: { trades, paused, daily_counts: {} },
    cfg: { paper: { stop_loss_bid: 0.70 }, ...cfg },
    // Bind the real method — we import it below
  };
}

// Import the class to get the method
import { TradeBridge } from "../src/execution/trade_bridge.mjs";

// We can't construct TradeBridge without a CLOB client, so we'll
// steal the prototype method and call it with our mock `this`.
const checkFn = TradeBridge.prototype.checkPositionsFromCLOB;

function check(bridge, pricesBySlug) {
  return checkFn.call(bridge, pricesBySlug);
}

function makeBuyTrade(slug, overrides = {}) {
  const signalId = overrides.signal_id || `${Date.now()}|${slug}`;
  return {
    status: "filled",
    signal_id: signalId,
    slug,
    side: "BUY",
    entryPrice: 0.93,
    avgFillPrice: 0.93,
    filledShares: 10,
    spentUsd: 9.30,
    closed: false,
    ...overrides,
  };
}

function priceMap(entries) {
  const m = new Map();
  for (const [slug, bid] of Object.entries(entries)) {
    m.set(slug, { yes_best_bid: bid });
  }
  return m;
}

describe("checkPositionsFromCLOB", () => {

  // ===================== RESOLUTION =====================

  describe("resolution signals (bid > 0.997)", () => {
    it("generates resolved signal when bid > 0.997", () => {
      const buy = makeBuyTrade("test-slug", { signal_id: "sig1|test-slug" });
      const bridge = makeBridge({ trades: { "buy:sig1|test-slug": buy } });
      const signals = check(bridge, priceMap({ "test-slug": 0.999 }));

      assert.equal(signals.length, 1);
      assert.equal(signals[0].type, "signal_close");
      assert.equal(signals[0].close_reason, "resolved");
      assert.equal(signals[0].slug, "test-slug");
      assert.equal(signals[0].win, true);
      assert.equal(signals[0].signal_id, "sig1|test-slug");
    });

    it("does NOT resolve at exact 0.997 (needs > 0.997)", () => {
      const buy = makeBuyTrade("edge-slug", { signal_id: "sig2|edge-slug" });
      const bridge = makeBridge({ trades: { "buy:sig2|edge-slug": buy } });
      const signals = check(bridge, priceMap({ "edge-slug": 0.997 }));

      assert.equal(signals.length, 0);
    });

    it("resolves at 0.998 (> 0.997)", () => {
      const buy = makeBuyTrade("edge-slug2", { signal_id: "sig2b|edge-slug2" });
      const bridge = makeBridge({ trades: { "buy:sig2b|edge-slug2": buy } });
      const signals = check(bridge, priceMap({ "edge-slug2": 0.998 }));

      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "resolved");
    });

    it("PnL is correct for resolution", () => {
      const buy = makeBuyTrade("pnl-slug", {
        signal_id: "sig3|pnl-slug",
        entryPrice: 0.93,
        filledShares: 10,
        spentUsd: 9.30,
      });
      const bridge = makeBridge({ trades: { "buy:sig3|pnl-slug": buy } });
      const signals = check(bridge, priceMap({ "pnl-slug": 0.999 }));

      const expectedPnl = 10 * (0.999 - 0.93); // 0.69
      assert.equal(signals.length, 1);
      assert.ok(Math.abs(signals[0].pnl_usd - expectedPnl) < 0.001);
      assert.ok(signals[0].roi > 0);
    });
  });

  // ===================== STOP LOSS =====================

  describe("stop-loss signals (bid <= threshold)", () => {
    it("generates SL signal when bid <= 0.70", () => {
      const buy = makeBuyTrade("sl-slug", { signal_id: "sig4|sl-slug" });
      const bridge = makeBridge({ trades: { "buy:sig4|sl-slug": buy } });
      const signals = check(bridge, priceMap({ "sl-slug": 0.65 }));

      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
      assert.equal(signals[0].win, false);
      assert.equal(signals[0].sl_trigger_price, 0.65);
    });

    it("generates SL signal at exact threshold 0.70", () => {
      const buy = makeBuyTrade("sl-edge", { signal_id: "sig5|sl-edge" });
      const bridge = makeBridge({ trades: { "buy:sig5|sl-edge": buy } });
      const signals = check(bridge, priceMap({ "sl-edge": 0.70 }));

      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
    });

    it("PnL is negative for SL", () => {
      const buy = makeBuyTrade("sl-pnl", {
        signal_id: "sig6|sl-pnl",
        entryPrice: 0.93,
        filledShares: 10,
        spentUsd: 9.30,
      });
      const bridge = makeBridge({ trades: { "buy:sig6|sl-pnl": buy } });
      const signals = check(bridge, priceMap({ "sl-pnl": 0.50 }));

      const expectedPnl = 10 * (0.50 - 0.93); // -4.30
      assert.equal(signals.length, 1);
      assert.ok(Math.abs(signals[0].pnl_usd - expectedPnl) < 0.001);
    });

    it("respects custom SL threshold from config", () => {
      const buy = makeBuyTrade("custom-sl", { signal_id: "sig7|custom-sl" });
      const bridge = makeBridge({
        trades: { "buy:sig7|custom-sl": buy },
        cfg: { paper: { stop_loss_bid: 0.80 } },
      });

      // 0.75 is below 0.80 → should trigger
      const signals = check(bridge, priceMap({ "custom-sl": 0.75 }));
      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
    });
  });

  // ===================== NO SIGNAL (normal range) =====================

  describe("no signal in normal range", () => {
    it("no signal when bid is between SL and resolve thresholds", () => {
      const buy = makeBuyTrade("normal", { signal_id: "sig8|normal" });
      const bridge = makeBridge({ trades: { "buy:sig8|normal": buy } });
      const signals = check(bridge, priceMap({ "normal": 0.90 }));

      assert.equal(signals.length, 0);
    });

    it("no signal at 0.71 (just above 0.70 SL)", () => {
      const buy = makeBuyTrade("above-sl", { signal_id: "sig9|above-sl" });
      const bridge = makeBridge({ trades: { "buy:sig9|above-sl": buy } });
      const signals = check(bridge, priceMap({ "above-sl": 0.71 }));

      assert.equal(signals.length, 0);
    });

    it("no signal at 0.997 (not > 0.997 resolve threshold)", () => {
      const buy = makeBuyTrade("below-res", { signal_id: "sig10|below-res" });
      const bridge = makeBridge({ trades: { "buy:sig10|below-res": buy } });
      const signals = check(bridge, priceMap({ "below-res": 0.997 }));

      assert.equal(signals.length, 0);
    });
  });

  // ===================== FILTERS =====================

  describe("filters: mode, paused, closed, side", () => {
    it("returns empty in paper mode", () => {
      const buy = makeBuyTrade("paper", { signal_id: "sig11|paper" });
      const bridge = makeBridge({ mode: "paper", trades: { "buy:sig11|paper": buy } });
      const signals = check(bridge, priceMap({ "paper": 0.999 }));

      assert.equal(signals.length, 0);
    });

    it("returns empty when paused", () => {
      const buy = makeBuyTrade("paused", { signal_id: "sig12|paused" });
      const bridge = makeBridge({
        trades: { "buy:sig12|paused": buy },
        paused: true,
      });
      const signals = check(bridge, priceMap({ "paused": 0.999 }));

      assert.equal(signals.length, 0);
    });

    it("ignores closed positions", () => {
      const buy = makeBuyTrade("closed", { signal_id: "sig13|closed", closed: true });
      const bridge = makeBridge({ trades: { "buy:sig13|closed": buy } });
      const signals = check(bridge, priceMap({ "closed": 0.999 }));

      assert.equal(signals.length, 0);
    });

    it("ignores SELL trades", () => {
      const sell = { ...makeBuyTrade("sell-side"), side: "SELL", signal_id: "sig14|sell-side" };
      const bridge = makeBridge({ trades: { "sell:sig14|sell-side": sell } });
      const signals = check(bridge, priceMap({ "sell-side": 0.999 }));

      assert.equal(signals.length, 0);
    });

    it("ignores trades with status !== filled", () => {
      const buy = makeBuyTrade("queued", { signal_id: "sig15|queued", status: "queued" });
      const bridge = makeBridge({ trades: { "buy:sig15|queued": buy } });
      const signals = check(bridge, priceMap({ "queued": 0.999 }));

      assert.equal(signals.length, 0);
    });
  });

  // ===================== DUPLICATE PREVENTION (THE SPAM FIX) =====================

  describe("duplicate prevention: skip if sell already exists", () => {
    it("no signal if sell is pending for this signal_id", () => {
      const buy = makeBuyTrade("dup-slug", { signal_id: "sig16|dup-slug" });
      const sellPending = {
        status: "sent",
        signal_id: "sig16|dup-slug",
        slug: "dup-slug",
        side: "SELL",
      };
      const bridge = makeBridge({
        trades: {
          "buy:sig16|dup-slug": buy,
          "sell:sig16|dup-slug": sellPending,
        },
      });
      const signals = check(bridge, priceMap({ "dup-slug": 0.999 }));

      assert.equal(signals.length, 0, "should not generate signal when sell is pending");
    });

    it("no signal if sell is already filled for this signal_id", () => {
      const buy = makeBuyTrade("filled-sell", { signal_id: "sig17|filled-sell" });
      const sellFilled = {
        status: "filled",
        signal_id: "sig17|filled-sell",
        slug: "filled-sell",
        side: "SELL",
      };
      const bridge = makeBridge({
        trades: {
          "buy:sig17|filled-sell": buy,
          "sell:sig17|filled-sell": sellFilled,
        },
      });
      const signals = check(bridge, priceMap({ "filled-sell": 0.999 }));

      assert.equal(signals.length, 0, "should not generate signal when sell is filled");
    });

    it("no signal if sell errored for this signal_id", () => {
      const buy = makeBuyTrade("err-sell", { signal_id: "sig18|err-sell" });
      const sellErr = {
        status: "error",
        signal_id: "sig18|err-sell",
        slug: "err-sell",
        side: "SELL",
      };
      const bridge = makeBridge({
        trades: {
          "buy:sig18|err-sell": buy,
          "sell:sig18|err-sell": sellErr,
        },
      });
      const signals = check(bridge, priceMap({ "err-sell": 0.999 }));

      assert.equal(signals.length, 0, "should not generate signal when sell has error");
    });

    it("generates signal if no sell exists for this signal_id", () => {
      const buy = makeBuyTrade("no-sell", { signal_id: "sig19|no-sell" });
      // A sell for a DIFFERENT signal exists — should not block
      const otherSell = {
        status: "filled",
        signal_id: "other|other-slug",
        slug: "other-slug",
        side: "SELL",
      };
      const bridge = makeBridge({
        trades: {
          "buy:sig19|no-sell": buy,
          "sell:other|other-slug": otherSell,
        },
      });
      const signals = check(bridge, priceMap({ "no-sell": 0.999 }));

      assert.equal(signals.length, 1, "should generate signal when no sell for this signal");
    });
  });

  // ===================== MULTIPLE POSITIONS =====================

  describe("multiple positions", () => {
    it("generates independent signals for each position", () => {
      const buy1 = makeBuyTrade("slug-a", { signal_id: "s1|slug-a" });
      const buy2 = makeBuyTrade("slug-b", { signal_id: "s2|slug-b" });
      const bridge = makeBridge({
        trades: {
          "buy:s1|slug-a": buy1,
          "buy:s2|slug-b": buy2,
        },
      });
      // One resolves, one SLs
      const signals = check(bridge, priceMap({ "slug-a": 0.999, "slug-b": 0.50 }));

      assert.equal(signals.length, 2);
      const resolved = signals.find(s => s.slug === "slug-a");
      const sl = signals.find(s => s.slug === "slug-b");
      assert.equal(resolved.close_reason, "resolved");
      assert.equal(sl.close_reason, "stop_loss");
    });

    it("only signals for positions with price data", () => {
      const buy1 = makeBuyTrade("has-price", { signal_id: "s3|has-price" });
      const buy2 = makeBuyTrade("no-price", { signal_id: "s4|no-price" });
      const bridge = makeBridge({
        trades: {
          "buy:s3|has-price": buy1,
          "buy:s4|no-price": buy2,
        },
      });
      // Only one slug has price
      const signals = check(bridge, priceMap({ "has-price": 0.999 }));

      assert.equal(signals.length, 1);
      assert.equal(signals[0].slug, "has-price");
    });
  });

  // ===================== EDGE CASES =====================

  describe("edge cases", () => {
    it("handles null bid gracefully", () => {
      const buy = makeBuyTrade("null-bid", { signal_id: "s5|null-bid" });
      const bridge = makeBridge({ trades: { "buy:s5|null-bid": buy } });
      const prices = new Map([["null-bid", { yes_best_bid: null }]]);
      const signals = check(bridge, prices);

      assert.equal(signals.length, 0);
    });

    it("handles empty price map", () => {
      const buy = makeBuyTrade("empty", { signal_id: "s6|empty" });
      const bridge = makeBridge({ trades: { "buy:s6|empty": buy } });
      const signals = check(bridge, new Map());

      assert.equal(signals.length, 0);
    });

    it("handles empty trades", () => {
      const bridge = makeBridge({ trades: {} });
      const signals = check(bridge, priceMap({ "anything": 0.999 }));

      assert.equal(signals.length, 0);
    });

    it("uses avgFillPrice when entryPrice is missing", () => {
      const buy = makeBuyTrade("no-entry", {
        signal_id: "s7|no-entry",
        entryPrice: undefined,
        avgFillPrice: 0.95,
        filledShares: 10,
      });
      const bridge = makeBridge({ trades: { "buy:s7|no-entry": buy } });
      const signals = check(bridge, priceMap({ "no-entry": 0.999 }));

      assert.equal(signals.length, 1);
      const expectedPnl = 10 * (0.999 - 0.95);
      assert.ok(Math.abs(signals[0].pnl_usd - expectedPnl) < 0.001);
    });

    it("case-insensitive side check (BUY vs buy vs Buy)", () => {
      const buyLower = makeBuyTrade("lower", { signal_id: "s8|lower", side: "buy" });
      const buyMixed = makeBuyTrade("mixed", { signal_id: "s9|mixed", side: "Buy" });
      const bridge = makeBridge({
        trades: {
          "buy:s8|lower": buyLower,
          "buy:s9|mixed": buyMixed,
        },
      });
      const signals = check(bridge, priceMap({ "lower": 0.999, "mixed": 0.999 }));

      assert.equal(signals.length, 2);
    });
  });
});

// === Ask-based resolution trigger ===
describe("ask-based resolution trigger", () => {
  it("triggers resolution when ask >= 0.999 and bid > 0.997", () => {
    const trade = makeBuyTrade("ask-resolve", { signal_id: "1|ask-resolve" });
    const bridge = makeBridge({ trades: { "buy:1|ask-resolve": trade } });
    const prices = new Map([["ask-resolve", { yes_best_bid: 0.998, yes_best_ask: 0.999 }]]);
    const signals = check(bridge, prices);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].close_reason, "resolved");
    assert.equal(signals[0].slug, "ask-resolve");
  });

  it("triggers when ask = 1.00 and bid = 0.998", () => {
    const trade = makeBuyTrade("ask-1", { signal_id: "1|ask-1" });
    const bridge = makeBridge({ trades: { "buy:1|ask-1": trade } });
    const prices = new Map([["ask-1", { yes_best_bid: 0.998, yes_best_ask: 1.00 }]]);
    const signals = check(bridge, prices);
    assert.equal(signals.length, 1);
  });

  it("does NOT trigger when ask >= 0.999 but bid <= 0.997", () => {
    const trade = makeBuyTrade("low-bid", { signal_id: "1|low-bid" });
    const bridge = makeBridge({ trades: { "buy:1|low-bid": trade } });
    const prices = new Map([["low-bid", { yes_best_bid: 0.997, yes_best_ask: 0.999 }]]);
    const signals = check(bridge, prices);
    assert.equal(signals.length, 0);
  });

  it("does NOT trigger when ask = 0.998 and bid = 0.95 (ask below 0.999, bid below 0.997)", () => {
    const trade = makeBuyTrade("below-ask", { signal_id: "1|below-ask" });
    const bridge = makeBridge({ trades: { "buy:1|below-ask": trade } });
    const prices = new Map([["below-ask", { yes_best_bid: 0.95, yes_best_ask: 0.998 }]]);
    const signals = check(bridge, prices);
    assert.equal(signals.length, 0);
  });

  it("bid-based still works independently of ask (bid > 0.997)", () => {
    const trade = makeBuyTrade("bid-only", { signal_id: "1|bid-only" });
    const bridge = makeBridge({ trades: { "buy:1|bid-only": trade } });
    const prices = new Map([["bid-only", { yes_best_bid: 0.998, yes_best_ask: 0.999 }]]);
    const signals = check(bridge, prices);
    assert.equal(signals.length, 1);
  });

  it("handles missing ask gracefully (null)", () => {
    const trade = makeBuyTrade("no-ask", { signal_id: "1|no-ask" });
    const bridge = makeBridge({ trades: { "buy:1|no-ask": trade } });
    const prices = new Map([["no-ask", { yes_best_bid: 0.93, yes_best_ask: null }]]);
    const signals = check(bridge, prices);
    assert.equal(signals.length, 0);
  });
});
