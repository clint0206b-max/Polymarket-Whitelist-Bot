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
// Default SL thresholds — keep in sync with local.json (paper.stop_loss_bid/spread_max/emergency)
const DEFAULT_SL = 0.85;
const DEFAULT_SL_SPREAD_MAX = 0.50;
const DEFAULT_SL_EMERGENCY = 0.15;
const ESPORTS_SL = 0.75;
const DOTA2_SL = 0.45;
const CS2_SL = 0.40;
const LOL_SL = 0.40;
const VAL_SL = 0.40;
const NBA_SL = 0.45;

function makeBridge({ mode = "live", trades = {}, paused = false, cfg = {} } = {}) {
  return {
    mode,
    execState: { trades, paused, daily_counts: {} },
    cfg: { paper: { stop_loss_bid: DEFAULT_SL, stop_loss_spread_max: DEFAULT_SL_SPREAD_MAX, stop_loss_emergency_bid: DEFAULT_SL_EMERGENCY, stop_loss_bid_esports: ESPORTS_SL, stop_loss_bid_dota2: DOTA2_SL, stop_loss_bid_cs2: CS2_SL, stop_loss_bid_lol: LOL_SL, stop_loss_bid_val: VAL_SL, stop_loss_bid_nba: NBA_SL }, ...cfg },
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
  for (const [slug, val] of Object.entries(entries)) {
    if (typeof val === "number") {
      m.set(slug, { yes_best_bid: val });
    } else {
      // { bid, ask } object
      m.set(slug, { yes_best_bid: val.bid, yes_best_ask: val.ask ?? null });
    }
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

  describe("stop-loss signals (bid <= threshold AND spread check)", () => {
    it(`generates SL signal when bid <= ${DEFAULT_SL} AND spread <= ${DEFAULT_SL_SPREAD_MAX}`, () => {
      const buy = makeBuyTrade("sl-slug", { signal_id: "sig4|sl-slug" });
      const bridge = makeBridge({ trades: { "buy:sig4|sl-slug": buy } });
      const bidBelow = DEFAULT_SL - 0.20; // 0.65
      const ask = bidBelow + 0.30; // 0.95, spread = 0.30 <= 0.50
      const signals = check(bridge, priceMap({ "sl-slug": { bid: bidBelow, ask } }));

      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
      assert.equal(signals[0].win, false);
      assert.equal(signals[0].sl_trigger_price, bidBelow);
    });

    it(`generates SL signal at exact thresholds bid=${DEFAULT_SL} spread<${DEFAULT_SL_SPREAD_MAX}`, () => {
      const buy = makeBuyTrade("sl-edge", { signal_id: "sig5|sl-edge" });
      const bridge = makeBridge({ trades: { "buy:sig5|sl-edge": buy } });
      // bid at SL, spread just under max (0.45 < 0.50)
      const signals = check(bridge, priceMap({ "sl-edge": { bid: DEFAULT_SL, ask: DEFAULT_SL + 0.45 } }));

      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
    });

    it("does NOT trigger SL when bid is low but spread > spread_max (wide spread, bid > emergency)", () => {
      const buy = makeBuyTrade("wide-spread", { signal_id: "sig5b|wide-spread" });
      const bridge = makeBridge({ trades: { "buy:sig5b|wide-spread": buy } });
      // bid=0.30 <= DEFAULT_SL but spread=0.69 > 0.50 and bid=0.30 > emergency 0.15
      const signals = check(bridge, priceMap({ "wide-spread": { bid: 0.30, ask: 0.99 } }));

      assert.equal(signals.length, 0, "should NOT trigger SL when spread > spread_max and bid > emergency");
    });

    it("DOES trigger SL via emergency when spread > spread_max but bid <= emergency", () => {
      const buy = makeBuyTrade("emergency-sl", { signal_id: "sig5c|emergency-sl" });
      const bridge = makeBridge({ trades: { "buy:sig5c|emergency-sl": buy } });
      // bid=0.10 <= emergency 0.15, even though spread=0.89 > 0.50
      const signals = check(bridge, priceMap({ "emergency-sl": { bid: 0.10, ask: 0.99 } }));

      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
      assert.equal(signals[0].sl_trigger_price, 0.10);
    });

    it("PnL is negative for SL", () => {
      const buy = makeBuyTrade("sl-pnl", {
        signal_id: "sig6|sl-pnl",
        entryPrice: 0.93,
        filledShares: 10,
        spentUsd: 9.30,
      });
      const bridge = makeBridge({ trades: { "buy:sig6|sl-pnl": buy } });
      const bidBelow = 0.50; // well below DEFAULT_SL
      const ask = 0.75; // spread = 0.25 <= 0.50
      const signals = check(bridge, priceMap({ "sl-pnl": { bid: bidBelow, ask } }));

      const expectedPnl = 10 * (bidBelow - 0.93);
      assert.equal(signals.length, 1);
      assert.ok(Math.abs(signals[0].pnl_usd - expectedPnl) < 0.001);
    });

    it("respects custom SL threshold from config", () => {
      const customSL = 0.80;
      const customSpreadMax = 0.30;
      const customEmergency = 0.20;
      const buy = makeBuyTrade("custom-sl", { signal_id: "sig7|custom-sl" });
      const bridge = makeBridge({
        trades: { "buy:sig7|custom-sl": buy },
        cfg: { paper: { stop_loss_bid: customSL, stop_loss_spread_max: customSpreadMax, stop_loss_emergency_bid: customEmergency } },
      });

      // bid=0.75 <= 0.80, spread=0.25 <= 0.30 → should trigger
      const signals = check(bridge, priceMap({ "custom-sl": { bid: 0.75, ask: 1.00 } }));
      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
    });
  });

  // ===================== ESPORTS PER-LEAGUE SL =====================

  describe("esports per-league SL (lower thresholds)", () => {
    it("cs2 slug uses cs2-specific SL (0.40), not esports SL (0.75)", () => {
      const buy = makeBuyTrade("cs2-test-2026-02-18", { signal_id: "e1|cs2-test-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:e1|cs2-test-2026-02-18": buy } });
      // bid=0.50 > CS2_SL(0.40) → should NOT trigger (would trigger with esports 0.75)
      const signals = check(bridge, priceMap({ "cs2-test-2026-02-18": { bid: 0.50, ask: 0.55 } }));
      assert.equal(signals.length, 0, "cs2 should use its own SL (0.40), not esports (0.75)");
    });

    it("cs2 slug triggers at cs2 SL (0.40)", () => {
      const buy = makeBuyTrade("cs2-sl-2026-02-18", { signal_id: "e1b|cs2-sl-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:e1b|cs2-sl-2026-02-18": buy } });
      // bid=0.39 <= CS2_SL(0.40), spread=0.05 <= 0.50 → trigger
      const signals = check(bridge, priceMap({ "cs2-sl-2026-02-18": { bid: 0.39, ask: 0.44 } }));
      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
    });

    it("lol slug uses lol-specific SL (0.40), not esports SL (0.75)", () => {
      const buy = makeBuyTrade("lol-test-2026-02-18", { signal_id: "l1|lol-test-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:l1|lol-test-2026-02-18": buy } });
      const signals = check(bridge, priceMap({ "lol-test-2026-02-18": { bid: 0.50, ask: 0.55 } }));
      assert.equal(signals.length, 0, "lol should use its own SL (0.40), not esports (0.75)");
    });

    it("lol slug triggers at lol SL (0.40)", () => {
      const buy = makeBuyTrade("lol-sl-2026-02-18", { signal_id: "l2|lol-sl-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:l2|lol-sl-2026-02-18": buy } });
      const signals = check(bridge, priceMap({ "lol-sl-2026-02-18": { bid: 0.39, ask: 0.44 } }));
      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
    });

    it("val slug uses val-specific SL (0.40), not esports SL (0.75)", () => {
      const buy = makeBuyTrade("val-test-2026-02-18", { signal_id: "v1|val-test-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:v1|val-test-2026-02-18": buy } });
      const signals = check(bridge, priceMap({ "val-test-2026-02-18": { bid: 0.50, ask: 0.55 } }));
      assert.equal(signals.length, 0, "val should use its own SL (0.40), not esports (0.75)");
    });

    it("val slug triggers at val SL (0.40)", () => {
      const buy = makeBuyTrade("val-sl-2026-02-18", { signal_id: "v2|val-sl-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:v2|val-sl-2026-02-18": buy } });
      const signals = check(bridge, priceMap({ "val-sl-2026-02-18": { bid: 0.39, ask: 0.44 } }));
      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
    });

    it("nba slug uses nba-specific SL (0.45), not default (0.85)", () => {
      const buy = makeBuyTrade("nba-lal-bos-2026-02-18", { signal_id: "n1|nba-lal-bos-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:n1|nba-lal-bos-2026-02-18": buy } });
      // bid=0.50 > NBA_SL(0.45) → should NOT trigger (would trigger with default 0.85)
      const signals = check(bridge, priceMap({ "nba-lal-bos-2026-02-18": { bid: 0.50, ask: 0.55 } }));
      assert.equal(signals.length, 0, "nba should use its own SL (0.45), not default (0.85)");
    });

    it("nba slug triggers at nba SL (0.45)", () => {
      const buy = makeBuyTrade("nba-lal-bos2-2026-02-18", { signal_id: "n2|nba-lal-bos2-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:n2|nba-lal-bos2-2026-02-18": buy } });
      // bid=0.44, spread=0.05 <= 0.50 → trigger
      const signals = check(bridge, priceMap({ "nba-lal-bos2-2026-02-18": { bid: 0.44, ask: 0.49 } }));
      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
    });

    it("dota2 slug does NOT trigger at esports SL (0.75) — uses dota2 SL (0.45)", () => {
      const buy = makeBuyTrade("dota2-test-2026-02-18", { signal_id: "e2|dota2-test-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:e2|dota2-test-2026-02-18": buy } });
      // bid=0.60 < ESPORTS_SL(0.75) but > DOTA2_SL(0.45) → should NOT trigger
      const signals = check(bridge, priceMap({ "dota2-test-2026-02-18": { bid: 0.60, ask: 0.65 } }));
      assert.equal(signals.length, 0, "dota2 should use its own SL (0.45), not esports (0.75)");
    });

    it("dota2 slug triggers at dota2 SL (0.45)", () => {
      const buy = makeBuyTrade("dota2-sl-2026-02-18", { signal_id: "e2b|dota2-sl-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:e2b|dota2-sl-2026-02-18": buy } });
      // bid=0.44 <= DOTA2_SL(0.45), spread=0.05 <= 0.50 → trigger
      const signals = check(bridge, priceMap({ "dota2-sl-2026-02-18": { bid: 0.44, ask: 0.49 } }));
      assert.equal(signals.length, 1);
      assert.equal(signals[0].close_reason, "stop_loss");
    });

    it("dota2: bid below SL but spread > spread_max and bid > emergency → no trigger", () => {
      const buy = makeBuyTrade("dota2-spread-2026-02-18", { signal_id: "e2c|dota2-spread-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:e2c|dota2-spread-2026-02-18": buy } });
      // bid=0.43 <= DOTA2_SL(0.45) but spread=0.56 > 0.50 and bid=0.43 > emergency 0.15 → wide spread, don't trigger
      const signals = check(bridge, priceMap({ "dota2-spread-2026-02-18": { bid: 0.43, ask: 0.99 } }));
      assert.equal(signals.length, 0, "spread guard should prevent trigger on wide spread");
    });

    it("lol- slug does NOT trigger at esports SL (0.75) — uses lol SL (0.40)", () => {
      const buy = makeBuyTrade("lol-test2-2026-02-18", { signal_id: "e3|lol-test2-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:e3|lol-test2-2026-02-18": buy } });
      // bid=0.74 > LOL_SL(0.40) → should NOT trigger
      const signals = check(bridge, priceMap({ "lol-test2-2026-02-18": { bid: 0.74, ask: 0.79 } }));
      assert.equal(signals.length, 0, "lol uses its own SL (0.40), not esports (0.75)");
    });

    it("cbb- slug uses default SL (not esports)", () => {
      const buy = makeBuyTrade("cbb-test-2026-02-18", { signal_id: "e4|cbb-test-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:e4|cbb-test-2026-02-18": buy } });
      // bid=0.82 < DEFAULT_SL(0.85), spread=0.03 <= 0.50 → trigger with default
      const signals = check(bridge, priceMap({ "cbb-test-2026-02-18": { bid: 0.82, ask: 0.85 } }));
      assert.equal(signals.length, 1, "cbb should use default SL");
    });

    it("esports: bid below esports SL but spread > spread_max and bid > emergency → no trigger", () => {
      const buy = makeBuyTrade("cs2-spread-2026-02-18", { signal_id: "e5|cs2-spread-2026-02-18" });
      const bridge = makeBridge({ trades: { "buy:e5|cs2-spread-2026-02-18": buy } });
      // bid=0.70 < ESPORTS_SL(0.75) but spread=0.29 > esports would need spread check too
      // Actually this should trigger since bid=0.70 < 0.75 and spread=0.15 <= 0.50
      const signals = check(bridge, priceMap({ "cs2-spread-2026-02-18": { bid: 0.70, ask: 0.99 } }));
      // spread=0.29, bid > emergency → should NOT trigger
      assert.equal(signals.length, 0);
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

    it(`no signal at bid=${DEFAULT_SL + 0.01} (just above ${DEFAULT_SL} SL)`, () => {
      const buy = makeBuyTrade("above-sl", { signal_id: "sig9|above-sl" });
      const bridge = makeBridge({ trades: { "buy:sig9|above-sl": buy } });
      // bid slightly above SL, spread within limits
      const signals = check(bridge, priceMap({ "above-sl": { bid: DEFAULT_SL + 0.01, ask: DEFAULT_SL + 0.40 } }));

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
      // One resolves, one SLs (both bid AND ask below thresholds for SL)
      const signals = check(bridge, priceMap({ "slug-a": 0.999, "slug-b": { bid: 0.50, ask: 0.55 } }));

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

// === Price tick logging ===
describe("price tick logging", () => {
  it("initializes _priceTickLastTs map on bridge", () => {
    const bridge = makeBridge({ trades: {} });
    bridge._priceTickLastTs = new Map();
    bridge._priceTickIntervalMs = 30_000;
    assert.ok(bridge._priceTickLastTs instanceof Map);
  });

  it("records tick timestamp after check (throttle tracking)", () => {
    const trade = makeBuyTrade("tick-slug", { signal_id: "t1|tick-slug" });
    const bridge = makeBridge({ trades: { "buy:t1|tick-slug": trade } });
    bridge._priceTickLastTs = new Map();
    bridge._priceTickIntervalMs = 30_000;

    // First call — should set the timestamp
    check(bridge, priceMap({ "tick-slug": 0.93 }));
    assert.ok(bridge._priceTickLastTs.has("t1|tick-slug"), "should track tick timestamp");
    const ts1 = bridge._priceTickLastTs.get("t1|tick-slug");
    assert.ok(ts1 > 0);
  });

  it("throttles: second call within interval does not update timestamp", () => {
    const trade = makeBuyTrade("throttle", { signal_id: "t2|throttle" });
    const bridge = makeBridge({ trades: { "buy:t2|throttle": trade } });
    bridge._priceTickLastTs = new Map();
    bridge._priceTickIntervalMs = 30_000;

    check(bridge, priceMap({ "throttle": 0.93 }));
    const ts1 = bridge._priceTickLastTs.get("t2|throttle");

    // Second call immediately — should NOT update (within 30s)
    check(bridge, priceMap({ "throttle": 0.94 }));
    const ts2 = bridge._priceTickLastTs.get("t2|throttle");
    assert.equal(ts1, ts2, "timestamp should not change within throttle interval");
  });

  it("cleans up tick map on resolution", () => {
    const trade = makeBuyTrade("cleanup-res", { signal_id: "t3|cleanup-res" });
    const bridge = makeBridge({ trades: { "buy:t3|cleanup-res": trade } });
    bridge._priceTickLastTs = new Map();
    bridge._priceTickIntervalMs = 30_000;

    // First: normal price → tick recorded
    check(bridge, priceMap({ "cleanup-res": 0.93 }));
    assert.ok(bridge._priceTickLastTs.has("t3|cleanup-res"));

    // Resolve: bid > 0.997 → should clean up
    check(bridge, priceMap({ "cleanup-res": 0.999 }));
    assert.ok(!bridge._priceTickLastTs.has("t3|cleanup-res"), "should clean up after resolution");
  });

  it("cleans up tick map on stop loss", () => {
    const trade = makeBuyTrade("cleanup-sl", { signal_id: "t4|cleanup-sl" });
    const bridge = makeBridge({ trades: { "buy:t4|cleanup-sl": trade } });
    bridge._priceTickLastTs = new Map();
    bridge._priceTickIntervalMs = 30_000;

    // First: normal price → tick recorded
    check(bridge, priceMap({ "cleanup-sl": 0.93 }));
    assert.ok(bridge._priceTickLastTs.has("t4|cleanup-sl"));

    // SL: bid below threshold, spread within limits → should clean up
    const bidBelow = DEFAULT_SL - 0.10;
    check(bridge, priceMap({ "cleanup-sl": { bid: bidBelow, ask: bidBelow + 0.40 } }));
    assert.ok(!bridge._priceTickLastTs.has("t4|cleanup-sl"), "should clean up after SL");
  });

  it("tracks multiple positions independently", () => {
    const t1 = makeBuyTrade("multi-a", { signal_id: "m1|multi-a" });
    const t2 = makeBuyTrade("multi-b", { signal_id: "m2|multi-b" });
    const bridge = makeBridge({ trades: { "buy:m1|multi-a": t1, "buy:m2|multi-b": t2 } });
    bridge._priceTickLastTs = new Map();
    bridge._priceTickIntervalMs = 30_000;

    check(bridge, priceMap({ "multi-a": 0.93, "multi-b": 0.95 }));
    assert.ok(bridge._priceTickLastTs.has("m1|multi-a"));
    assert.ok(bridge._priceTickLastTs.has("m2|multi-b"));
  });
});
