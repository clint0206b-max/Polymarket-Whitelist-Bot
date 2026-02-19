import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// Mock order_executor before importing trade_bridge
const mockCheckMarketResolved = mock.fn();
const mockRedeemPositions = mock.fn();

// We test the logic via TradeBridge.handleRedeem and checkAndRedeemResolved
// Since these call imported functions, we test them at integration level
// using the TradeBridge class with mocked wallet

describe("Redeem logic", () => {

  describe("checkMarketResolved", () => {
    it("should return resolved=false for missing conditionId", async () => {
      const { checkMarketResolved } = await import("../src/execution/order_executor.mjs");
      const result = await checkMarketResolved(null);
      assert.equal(result.resolved, false);
      assert.equal(result.error, "missing conditionId");
    });
  });

  describe("redeemPositions", () => {
    it("should return error for missing conditionId", async () => {
      const { redeemPositions } = await import("../src/execution/order_executor.mjs");
      const result = await redeemPositions({}, null);
      assert.equal(result.ok, false);
      assert.match(result.error, /missing conditionId/);
    });
  });

  describe("TradeBridge.handleRedeem", () => {
    it("should return error in paper mode", async () => {
      // Build a minimal TradeBridge-like object
      const { TradeBridge } = await import("../src/execution/trade_bridge.mjs");
      const tb = new TradeBridge({ trading: { mode: "paper" } }, {});
      const result = await tb.handleRedeem({}, "test");
      assert.equal(result.ok, false);
      assert.match(result.error, /not live/);
    });
  });

  describe("TradeBridge.checkAndRedeemResolved", () => {
    it("should skip in paper mode", async () => {
      const { TradeBridge } = await import("../src/execution/trade_bridge.mjs");
      const tb = new TradeBridge({ trading: { mode: "paper" } }, {});
      const results = await tb.checkAndRedeemResolved();
      assert.deepEqual(results, []);
    });

    it("should respect throttle interval", async () => {
      const { TradeBridge } = await import("../src/execution/trade_bridge.mjs");
      const tb = new TradeBridge({ trading: { mode: "live" } }, {});
      tb.wallet = {};
      tb.execState = { trades: {} };
      tb._lastRedeemCheckTs = Date.now(); // just checked
      const results = await tb.checkAndRedeemResolved();
      assert.deepEqual(results, []);
    });

    it("should skip trades with active price data (bid > 0.01)", async () => {
      const { TradeBridge } = await import("../src/execution/trade_bridge.mjs");
      const tb = new TradeBridge({ trading: { mode: "live" } }, {});
      tb.wallet = {};
      tb.execState = {
        trades: {
          "buy:123|test-slug": {
            status: "filled", closed: false, side: "BUY",
            slug: "test-slug", tokenId: "tok123",
          },
        },
      };
      tb._lastRedeemCheckTs = 0;
      tb._currentPricesBySlug = new Map([["test-slug", { yes_best_bid: 0.85 }]]);
      const results = await tb.checkAndRedeemResolved();
      assert.deepEqual(results, []);
    });

    it("should include orphan_closed trades in redeem candidates", async () => {
      const { TradeBridge } = await import("../src/execution/trade_bridge.mjs");
      const trades = {
        "buy:123|test-slug": {
          status: "orphan_closed", closed: true, side: "BUY",
          slug: "test-slug", tokenId: "tok123", conditionId: "0xabc",
        },
      };
      const tb = new TradeBridge({ trading: { mode: "live" } }, {});
      tb.wallet = {};
      tb._lastRedeemCheckTs = 0;
      tb._currentPricesBySlug = new Map();
      // Override execState to avoid reading from disk
      tb.execState = { trades };

      // Override handleRedeem to avoid real RPC calls
      const redeemCalled = [];
      tb.handleRedeem = async (trade, tradeId) => {
        redeemCalled.push({ tradeId, slug: trade.slug });
        return { ok: false, error: "mocked" };
      };

      const results = await tb.checkAndRedeemResolved();
      assert.equal(redeemCalled.length, 1);
      assert.equal(redeemCalled[0].slug, "test-slug");
      assert.equal(results.length, 1);
    });
  });
});
