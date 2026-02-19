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
      cache._state; // just access to confirm

      // Replace with failing fn (simulate API error)
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

  describe("computeTotalBalance", () => {
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
      // 90 + (20*0.95) + (10*0.80) = 90 + 19 + 8 = 117
      assert.equal(r.totalBalance, 117);
      assert.equal(r.positionsValue, 27);
    });

    it("falls back to entryPrice when no bid available", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 50 });
      await cache.refresh();
      const trades = [{ slug: "x", filledShares: 10, entryPrice: 0.90 }];
      const prices = new Map(); // no prices
      const r = cache.computeTotalBalance(trades, prices);
      // 50 + (10*0.90) = 59
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

  describe("calculateTradeSize", () => {
    it("fixed mode returns fixed_usd", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 100 });
      await cache.refresh();
      const r = cache.calculateTradeSize({ mode: "fixed", fixed_usd: 10 }, [], new Map());
      assert.equal(r.budgetUsd, 10);
      assert.equal(r.method, "fixed");
    });

    it("percent_of_total: $130 total → $13 budget", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 90 });
      await cache.refresh();
      const trades = [{ slug: "a", filledShares: 50, entryPrice: 0.80 }];
      const prices = new Map([["a", { yes_best_bid: 0.80 }]]);
      // total = 90 + 50*0.80 = 130, 10% = 13
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
      // total = 3 + 47 = 50, 10% = 5, but cash = 3 → use 3
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

    it("fallback when balance unknown (API failed, never fetched)", () => {
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
      // First trade
      const r1 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r1.budgetUsd, 10);
      cache.recordSpend(10); // simulate buy

      // Second trade — cash now 90, but total still ~100 (cash went to position)
      // However getCashUsd() returns 90, and totalBalance uses raw cash (100) + positions
      // so totalBalance = 100, 10% = 10, but cashAvailable = 90 → still $10
      const r2 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r2.budgetUsd, 10);
      assert.equal(r2.cashAvailable, 90);
    });

    it("two trades same loop: second can't exceed remaining cash", async () => {
      const cache = createBalanceCache({ getBalanceFn: async () => 15 });
      await cache.refresh();
      // total = 15, 10% = 1.5
      const r1 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r1.budgetUsd, 1.5);
      cache.recordSpend(1.5);

      // cash now 13.5, total still ~15, 10% = 1.5, cash = 13.5 → $1.50
      const r2 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r2.budgetUsd, 1.5);

      // Exhaust cash
      cache.recordSpend(12);
      // cash now 1.5, 10% = 1.5, cash = 1.5 → $1.50
      const r3 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r3.budgetUsd, 1.5);

      cache.recordSpend(1.5);
      // cash = 0
      const r4 = cache.calculateTradeSize({ mode: "percent_of_total", percent: 10 }, [], new Map());
      assert.equal(r4.budgetUsd, 0);
      assert.equal(r4.method, "no_cash");
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
});
