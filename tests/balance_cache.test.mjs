import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBalanceCache } from "../src/execution/balance_cache.mjs";

describe("createBalanceCache", () => {
  describe("refresh", () => {
    it("fetches and stores cash balance", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      const r = await cache.refresh();
      assert.equal(r.cashUsd, 100);
      assert.equal(r.fromCache, false);
      assert.equal(r.error, null);
    });

    it("uses cached value on fetch error", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh(); // first fetch OK

      const cache2 = createBalanceCache({ getBalanceFn: async () => { throw new Error("API down"); } });
      const r = await cache2.refresh();
      assert.equal(r.cashUsd, null); // never fetched before
      assert.equal(r.fromCache, true);
      assert.ok(r.error);
    });

    it("resets cashSpentThisLoop on refresh", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();
      cache.recordSpend(20);
      assert.equal(cache.getCashUsd(), 80);
      await cache.refresh();
      assert.equal(cache.getCashUsd(), 100); // reset after refresh
    });
  });

  describe("getCashUsd", () => {
    it("returns null if never fetched", () => {
      const cache = createBalanceCache({});
      assert.equal(cache.getCashUsd(), null);
    });

    it("returns null if cache too old", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 50, maxAgeMs: 1 });
      await cache.refresh();
      await new Promise(r => setTimeout(r, 5));
      assert.equal(cache.getCashUsd(), null);
    });

    it("subtracts intra-loop spend", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();
      cache.recordSpend(15);
      assert.equal(cache.getCashUsd(), 85);
      cache.recordSpend(10);
      assert.equal(cache.getCashUsd(), 75);
    });

    it("never goes below 0", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 10 });
      await cache.refresh();
      cache.recordSpend(50);
      assert.equal(cache.getCashUsd(), 0);
    });
  });

  describe("computeTotalBalance (legacy)", () => {
    it("cash only, no positions", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();
      const r = cache.computeTotalBalance([], new Map());
      assert.equal(r.totalBalance, 100);
      assert.equal(r.cashUsd, 100);
      assert.equal(r.positionsValue, 0);
    });

    it("cash + positions at current bid", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 90 });
      await cache.refresh();
      const trades = [
        { slug: "cbb-a-b", filledShares: 20, entryPrice: 0.91 },
        { slug: "nba-c-d", filledShares: 10, entryPrice: 0.85 },
      ];
      const prices = new Map([
        ["cbb-a-b", { yes_best_bid: 0.95 }],
        ["nba-c-d", { yes_best_bid: 0.80 }],
      ]);
      const r = cache.computeTotalBalance(trades, prices);
      assert.equal(r.totalBalance, 117);
      assert.equal(r.positionsValue, 27);
    });

    it("falls back to entryPrice when no bid available", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 50 });
      await cache.refresh();
      const trades = [{ slug: "x", filledShares: 10, entryPrice: 0.90 }];
      const r = cache.computeTotalBalance(trades, new Map());
      assert.equal(r.totalBalance, 59);
    });

    it("uses avgFillPrice as fallback when no entryPrice", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 50 });
      await cache.refresh();
      const trades = [{ slug: "x", filledShares: 10, avgFillPrice: 0.88 }];
      const r = cache.computeTotalBalance(trades, new Map());
      assert.equal(r.positionsValue, 8.8);
    });
  });

  // ======= Legacy mode: percent_of_total =======

  describe("calculateTradeSize — fixed mode", () => {
    it("returns fixed_usd", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();
      const r = cache.calculateTradeSize({ mode: "fixed", fixed_usd: 10 }, [], new Map());
      assert.equal(r.budgetUsd, 10);
      assert.equal(r.method, "fixed");
    });

    it("default mode is fixed", () => {
      const cache = createBalanceCache({});
      const r = cache.calculateTradeSize({}, [], new Map());
      assert.equal(r.budgetUsd, 10);
      assert.equal(r.method, "fixed");
    });

    it("unknown mode falls back to $10", () => {
      const cache = createBalanceCache({});
      const r = cache.calculateTradeSize({ mode: "bananas" }, [], new Map());
      assert.equal(r.budgetUsd, 10);
      assert.equal(r.method, "unknown_mode_fallback");
    });
  });

  describe("calculateTradeSize — percent_of_total (legacy)", () => {
    it("$130 total → $13 budget", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 90 });
      await cache.refresh();
      const trades = [{ slug: "a", filledShares: 50, entryPrice: 0.80 }];
      const prices = new Map([["a", { yes_best_bid: 0.80 }]]);
      const r = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, trades, prices);
      assert.equal(r.budgetUsd, 13);
      assert.equal(r.method, "percent_of_total");
      assert.equal(r.totalBalance, 130);
      assert.equal(r.detail, "normal");
    });

    it("uses all remaining cash when cash < 10%", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 3 });
      await cache.refresh();
      const trades = [{ slug: "a", filledShares: 50, entryPrice: 0.94 }];
      const prices = new Map([["a", { yes_best_bid: 0.94 }]]);
      const r = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, trades, prices);
      assert.equal(r.budgetUsd, 3);
      assert.equal(r.detail, "used_remaining_cash");
    });

    it("$100 cash, no positions → $10 budget", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();
      const r = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r.budgetUsd, 10);
      assert.equal(r.totalBalance, 100);
    });

    it("fallback when balance unknown", () => {
      const cache = createBalanceCache({ fallbackUsd: 10 });
      const r = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10, fallback_fixed_usd: 10 }, [], new Map());
      assert.equal(r.budgetUsd, 10);
      assert.equal(r.method, "fallback_no_cash");
    });

    it("$0 cash → budgetUsd = 0, no trade", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 0 });
      await cache.refresh();
      const r = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r.budgetUsd, 0);
      assert.equal(r.method, "no_cash");
    });

    it("two trades same loop: second deducts first spend", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();
      const r1 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r1.budgetUsd, 10);
      cache.recordSpend(10);

      const r2 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r2.budgetUsd, 10);
      assert.equal(r2.cashAvailable, 90);
    });

    it("two trades same loop: second can't exceed remaining cash", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 15 });
      await cache.refresh();
      const r1 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r1.budgetUsd, 1.5);
      cache.recordSpend(1.5);

      const r2 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r2.budgetUsd, 1.5);

      cache.recordSpend(12);
      const r3 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r3.budgetUsd, 1.5);

      cache.recordSpend(1.5);
      const r4 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r4.budgetUsd, 0);
      assert.equal(r4.method, "no_cash");
    });
  });

  // ======= New mode: percent_of_equity =======

  describe("calculateTradeSize — percent_of_equity", () => {
    const cfg = (overrides = {}) => ({
      mode: "percent_of_equity",
      percent: 10,
      max_exposure_pct: 60,
      max_trade_usd: 18,
      fallback_fixed_usd: 10,
      ...overrides,
    });

    it("cash only, no positions → 10% of cash", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();
      const r = cache.calculateTradeSize(cfg(), [], new Map());
      assert.equal(r.budgetUsd, 10);
      assert.equal(r.method, "percent_of_equity");
      assert.equal(r.base, 100);
      assert.equal(r.deployed, 0);
      assert.equal(r.maxDeployed, 60);
      assert.equal(r.available, 60);
      assert.equal(r.detail, "normal");
    });

    it("cash + deployed: base = cash + deployed cost", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 80 });
      await cache.refresh();
      const trades = [
        { spentUsd: 10, slug: "a" },
        { spentUsd: 10, slug: "b" },
      ];
      const r = cache.calculateTradeSize(cfg(), trades, new Map());
      // base = 80 + 20 = 100, 10% = 10, maxDeployed = 60, available = 40
      assert.equal(r.base, 100);
      assert.equal(r.deployed, 20);
      assert.equal(r.budgetUsd, 10); // min(10, 40, 18, 80) = 10
      assert.equal(r.detail, "normal");
    });

    it("exposure cap kicks in when heavily deployed", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 50 });
      await cache.refresh();
      const trades = [
        { spentUsd: 30, slug: "a" },
        { spentUsd: 30, slug: "b" },
      ];
      // base = 50 + 60 = 110, 10% = 11, maxDeployed = 66, available = 66 - 60 = 6
      const r = cache.calculateTradeSize(cfg(), trades, new Map());
      assert.equal(r.base, 110);
      assert.equal(r.deployed, 60);
      assert.equal(r.available, 6);
      assert.equal(r.budgetUsd, 6); // min(11, 6, 18, 50) = 6
      assert.equal(r.detail, "exposure_limited");
    });

    it("exposure cap reached → budget = 0", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 30 });
      await cache.refresh();
      const trades = [
        { spentUsd: 30, slug: "a" },
        { spentUsd: 30, slug: "b" },
      ];
      // base = 30 + 60 = 90, maxDeployed = 54, available = 54 - 60 = -6 → 0
      const r = cache.calculateTradeSize(cfg(), trades, new Map());
      assert.equal(r.budgetUsd, 0);
      assert.equal(r.detail, "exposure_cap");
    });

    it("max_trade_usd caps the budget", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 200 });
      await cache.refresh();
      // base = 200, 10% = 20, but max_trade_usd = 15
      const r = cache.calculateTradeSize(cfg({ max_trade_usd: 15 }), [], new Map());
      assert.equal(r.budgetUsd, 15);
      assert.equal(r.detail, "max_trade_limited");
    });

    it("cash limited: low cash with no deployment", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 5 });
      await cache.refresh();
      // base = 5, 10% = 0.5, maxDeployed = 3, available = 3, cash = 5
      // min(0.5, 3, 18, 5) = 0.5
      const r = cache.calculateTradeSize(cfg(), [], new Map());
      assert.equal(r.budgetUsd, 0.5);
      assert.equal(r.detail, "normal");
    });

    it("cash limited: high deployed, low cash", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 3 });
      await cache.refresh();
      const trades = [{ spentUsd: 80, slug: "a" }];
      // base = 3 + 80 = 83, 10% = 8.3, maxDeployed = 49.8, available = -30.2 → 0
      const r = cache.calculateTradeSize(cfg(), trades, new Map());
      assert.equal(r.budgetUsd, 0);
      assert.equal(r.detail, "exposure_cap");
    });

    it("zero base → budget = 0", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 0 });
      await cache.refresh();
      const r = cache.calculateTradeSize(cfg(), [], new Map());
      assert.equal(r.budgetUsd, 0);
      assert.equal(r.detail, "zero_base");
    });

    it("fallback when balance unknown", () => {
      const cache = createBalanceCache({ fallbackUsd: 10 });
      const r = cache.calculateTradeSize(cfg(), [], new Map());
      assert.equal(r.budgetUsd, 10);
      assert.equal(r.method, "fallback_no_cash");
    });

    it("no max_trade_usd → unlimited (uses 10% target)", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 300 });
      await cache.refresh();
      // base = 300, 10% = 30, maxDeployed = 180, available = 180
      const r = cache.calculateTradeSize(cfg({ max_trade_usd: undefined }), [], new Map());
      assert.equal(r.budgetUsd, 30);
      assert.equal(r.detail, "normal");
    });

    it("handles null/missing spentUsd in trades gracefully", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();
      const trades = [
        { spentUsd: null, slug: "a" },
        { slug: "b" }, // no spentUsd at all
        { spentUsd: 10, slug: "c" },
      ];
      const r = cache.calculateTradeSize(cfg(), trades, new Map());
      // deployed = 0 + 0 + 10 = 10, base = 100 + 10 = 110
      assert.equal(r.deployed, 10);
      assert.equal(r.base, 110);
    });

    // --- Intra-loop stability ---

    it("base stable after intra-loop buy (cash down, deployed up)", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();

      // First buy: no positions yet
      const r1 = cache.calculateTradeSize(cfg(), [], new Map());
      assert.equal(r1.base, 100);
      assert.equal(r1.budgetUsd, 10);

      // Simulate buy: recordSpend + new trade in open trades
      cache.recordSpend(10);
      const tradesAfterBuy = [{ spentUsd: 10, slug: "a" }];

      // Second buy: base should still be ~100 (cash 90 + deployed 10)
      const r2 = cache.calculateTradeSize(cfg(), tradesAfterBuy, new Map());
      assert.equal(r2.base, 100); // 90 + 10 = 100 ← stable!
      assert.equal(r2.cashAvailable, 90);
      assert.equal(r2.deployed, 10);
    });

    it("two buys in same loop: budget stays consistent", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 150 });
      await cache.refresh();

      // Buy 1
      const r1 = cache.calculateTradeSize(cfg(), [], new Map());
      assert.equal(r1.base, 150);
      assert.equal(r1.budgetUsd, 15); // 10% of 150

      cache.recordSpend(15);
      const trades1 = [{ spentUsd: 15, slug: "a" }];

      // Buy 2 — base should still be 150
      const r2 = cache.calculateTradeSize(cfg(), trades1, new Map());
      assert.equal(r2.base, 150); // 135 + 15 = 150
      assert.equal(r2.budgetUsd, 15); // same budget
      assert.equal(r2.available, 75); // 90 - 15 = 75

      cache.recordSpend(15);
      const trades2 = [{ spentUsd: 15, slug: "a" }, { spentUsd: 15, slug: "b" }];

      // Buy 3 — base still 150
      const r3 = cache.calculateTradeSize(cfg(), trades2, new Map());
      assert.equal(r3.base, 150); // 120 + 30 = 150
      assert.equal(r3.budgetUsd, 15);
      assert.equal(r3.available, 60); // 90 - 30 = 60
    });

    it("intra-loop: exposure cap triggers correctly across buys", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();

      // Open 5 positions in one loop at $12 each = $60 deployed
      let trades = [];
      for (let i = 0; i < 5; i++) {
        cache.recordSpend(12);
        trades.push({ spentUsd: 12, slug: `pos-${i}` });
      }

      // base = (100 - 60) + 60 = 100, maxDeployed = 60, available = 0
      const r = cache.calculateTradeSize(cfg(), trades, new Map());
      assert.equal(r.base, 100);
      assert.equal(r.deployed, 60);
      assert.equal(r.available, 0);
      assert.equal(r.budgetUsd, 0);
      assert.equal(r.detail, "exposure_cap");
    });

    // --- Compound growth ---

    it("compound growth: after profit, base and budget increase", async () => {
      // Start: $130 cash
      const cache1 = createBalanceCache({ getBalanceFn: async () => 130 });
      await cache1.refresh();
      const r1 = cache1.calculateTradeSize(cfg(), [], new Map());
      assert.equal(r1.base, 130);
      assert.equal(r1.budgetUsd, 13);

      // After profitable day: cash now $150 (realized profit +$20)
      const cache2 = createBalanceCache({ getBalanceFn: async () => 150 });
      await cache2.refresh();
      const r2 = cache2.calculateTradeSize(cfg(), [], new Map());
      assert.equal(r2.base, 150);
      assert.equal(r2.budgetUsd, 15); // compound: budget grew with profit
    });

    it("after losses, base and budget shrink", async () => {
      // After bad day: cash now $90 (realized loss -$40)
      const cache = createBalanceCache({ getBalanceFn: async () => 90 });
      await cache.refresh();
      const r = cache.calculateTradeSize(cfg(), [], new Map());
      assert.equal(r.base, 90);
      assert.equal(r.budgetUsd, 9); // smaller after losses
    });

    // --- recordSpend unreserve on failure ---

    it("unreserve spend on failed buy (negative recordSpend)", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();

      cache.recordSpend(10); // reserve
      assert.equal(cache.getCashUsd(), 90);

      cache.recordSpend(-10); // unreserve on failure
      assert.equal(cache.getCashUsd(), 100);
    });
  });

  // ======= Base drop detection =======

  describe("base drop detection", () => {
    it("returns null with insufficient history", () => {
      const cache = createBalanceCache({});
      assert.equal(cache.checkBaseDrop(), null);
      cache.recordBase(100);
      assert.equal(cache.checkBaseDrop(), null); // needs at least 2
    });

    it("detects significant drop", () => {
      const cache = createBalanceCache({});
      const now = Date.now();

      // Simulate base dropping from 160 to 120 (25% drop)
      cache.recordBase(160);
      cache.recordBase(150);
      cache.recordBase(130);
      cache.recordBase(120);

      const r = cache.checkBaseDrop(10 * 60 * 1000, 0.15);
      assert.equal(r.drop, true);
      assert.equal(r.peakBase, 160);
      assert.equal(r.currentBase, 120);
      assert.ok(r.dropPct >= 0.24); // ~25%
    });

    it("no drop when base is stable", () => {
      const cache = createBalanceCache({});
      cache.recordBase(100);
      cache.recordBase(102);
      cache.recordBase(99);
      cache.recordBase(101);

      const r = cache.checkBaseDrop(10 * 60 * 1000, 0.15);
      assert.equal(r.drop, false);
      assert.ok(r.dropPct < 0.05);
    });

    it("respects custom threshold", () => {
      const cache = createBalanceCache({});
      cache.recordBase(100);
      cache.recordBase(92); // 8% drop

      const r1 = cache.checkBaseDrop(10 * 60 * 1000, 0.05);
      assert.equal(r1.drop, true); // 8% > 5% threshold

      const r2 = cache.checkBaseDrop(10 * 60 * 1000, 0.10);
      assert.equal(r2.drop, false); // 8% < 10% threshold
    });
  });
});
