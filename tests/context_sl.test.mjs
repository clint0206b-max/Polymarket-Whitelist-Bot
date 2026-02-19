import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TradeBridge } from "../src/execution/trade_bridge.mjs";

// --- _computeMarginForYes ---

describe("TradeBridge._computeMarginForYes", () => {
  const makeCtx = (aName, aScore, bName, bScore, aFull = null, bFull = null) => ({
    teams: {
      a: { name: aName, score: aScore, fullName: aFull },
      b: { name: bName, score: bScore, fullName: bFull },
    },
  });

  it("returns positive margin when YES team is leading (team A)", () => {
    const ctx = makeCtx("Alabama", 70, "Arkansas", 60);
    const ctxEntry = { yes_outcome_name: "Alabama Crimson Tide" };
    assert.equal(TradeBridge._computeMarginForYes(ctx, ctxEntry), 10);
  });

  it("returns positive margin when YES team is leading (team B)", () => {
    const ctx = makeCtx("Arkansas", 60, "Alabama", 70);
    const ctxEntry = { yes_outcome_name: "Alabama Crimson Tide" };
    assert.equal(TradeBridge._computeMarginForYes(ctx, ctxEntry), 10);
  });

  it("returns negative margin when YES team is losing", () => {
    const ctx = makeCtx("Alabama", 55, "Arkansas", 60);
    const ctxEntry = { yes_outcome_name: "Alabama Crimson Tide" };
    assert.equal(TradeBridge._computeMarginForYes(ctx, ctxEntry), -5);
  });

  it("returns 0 when tied", () => {
    const ctx = makeCtx("Alabama", 60, "Arkansas", 60);
    const ctxEntry = { yes_outcome_name: "Alabama Crimson Tide" };
    assert.equal(TradeBridge._computeMarginForYes(ctx, ctxEntry), 0);
  });

  it("returns null when no yes_outcome_name", () => {
    const ctx = makeCtx("Alabama", 70, "Arkansas", 60);
    assert.equal(TradeBridge._computeMarginForYes(ctx, {}), null);
    assert.equal(TradeBridge._computeMarginForYes(ctx, { yes_outcome_name: null }), null);
  });

  it("returns null when no context", () => {
    assert.equal(TradeBridge._computeMarginForYes(null, { yes_outcome_name: "Alabama" }), null);
    assert.equal(TradeBridge._computeMarginForYes({}, { yes_outcome_name: "Alabama" }), null);
  });

  it("returns null when teams missing scores", () => {
    const ctx = { teams: { a: { name: "Alabama" }, b: { name: "Arkansas" } } };
    assert.equal(TradeBridge._computeMarginForYes(ctx, { yes_outcome_name: "Alabama" }), null);
  });

  it("returns null on ambiguous match", () => {
    // Both teams contain "George"
    const ctx = makeCtx("George Washington", 50, "George Mason", 45);
    const ctxEntry = { yes_outcome_name: "George" };
    assert.equal(TradeBridge._computeMarginForYes(ctx, ctxEntry), null);
  });

  it("matches via fullName when shortName fails", () => {
    const ctx = makeCtx("E Michigan", 65, "Ohio", 60, "Eastern Michigan Eagles", null);
    const ctxEntry = { yes_outcome_name: "Eastern Michigan Eagles" };
    assert.equal(TradeBridge._computeMarginForYes(ctx, ctxEntry), 5);
  });
});

// --- Context SL in checkPositionsFromCLOB ---

describe("Context SL integration", () => {
  // Minimal TradeBridge mock that only tests checkPositionsFromCLOB
  function makeBridge(cfg = {}, trades = {}) {
    const bridge = Object.create(TradeBridge.prototype);
    bridge.mode = "live";
    bridge.cfg = {
      paper: { stop_loss_bid: 0.45, stop_loss_ask: 0.50 },
      context: { min_margin_hold: 3, ...cfg },
    };
    bridge.execState = { paused: false, trades };
    bridge._priceTickLastTs = new Map();
    bridge._priceTickIntervalMs = 999999; // disable ticks
    return bridge;
  }

  function makeTrade(slug, overrides = {}) {
    return {
      status: "filled",
      closed: false,
      side: "BUY",
      signal_id: `test|${slug}`,
      slug,
      entryPrice: 0.91,
      avgFillPrice: 0.91,
      filledShares: 10,
      spentUsd: 9.1,
      ...overrides,
    };
  }

  it("sells when margin drops below threshold (CBB)", () => {
    const trade = makeTrade("cbb-charlt-tulsa-2026-02-18");
    const bridge = makeBridge({}, { [`buy:${trade.signal_id}`]: trade });
    
    const prices = new Map([["cbb-charlt-tulsa-2026-02-18", { yes_best_bid: 0.75, yes_best_ask: 0.80 }]]);
    const contexts = new Map([["cbb-charlt-tulsa-2026-02-18", {
      context: {
        sport: "cbb",
        decided_pass: true,  // not used by checkPositions but present
        teams: { a: { name: "Charlotte" }, b: { name: "Tulsa", score: 65, fullName: null } },
      },
      context_entry: { yes_outcome_name: "Charlotte 49ers" },
    }]]);
    // Charlotte score missing — fix
    contexts.get("cbb-charlt-tulsa-2026-02-18").context.teams.a.score = 60;

    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].close_reason, "context_sl");
    assert.equal(signals[0].context_margin, -5); // losing by 5
  });

  it("does NOT sell when margin is above threshold", () => {
    const trade = makeTrade("cbb-army-loymd-2026-02-18");
    const bridge = makeBridge({}, { [`buy:${trade.signal_id}`]: trade });
    
    const prices = new Map([["cbb-army-loymd-2026-02-18", { yes_best_bid: 0.95, yes_best_ask: 0.97 }]]);
    const contexts = new Map([["cbb-army-loymd-2026-02-18", {
      context: { teams: { a: { name: "Army", score: 70 }, b: { name: "Loyola Maryland", score: 60 } } },
      context_entry: { yes_outcome_name: "Army Black Knights" },
    }]]);

    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    // Should NOT trigger context SL (margin = 10 > 3)
    const contextSl = signals.filter(s => s.close_reason === "context_sl");
    assert.equal(contextSl.length, 0);
  });

  it("does NOT sell when margin is exactly at threshold", () => {
    const trade = makeTrade("cbb-test-game-2026-02-18");
    const bridge = makeBridge({}, { [`buy:${trade.signal_id}`]: trade });
    
    const prices = new Map([["cbb-test-game-2026-02-18", { yes_best_bid: 0.88, yes_best_ask: 0.90 }]]);
    const contexts = new Map([["cbb-test-game-2026-02-18", {
      context: { teams: { a: { name: "TeamA", score: 53 }, b: { name: "TeamB", score: 50 } } },
      context_entry: { yes_outcome_name: "TeamA" },
    }]]);

    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    const contextSl = signals.filter(s => s.close_reason === "context_sl");
    assert.equal(contextSl.length, 0); // margin=3, threshold=3, NOT less than
  });

  it("sells at margin 2 (just below threshold)", () => {
    const trade = makeTrade("cbb-close-game-2026-02-18");
    const bridge = makeBridge({}, { [`buy:${trade.signal_id}`]: trade });
    
    const prices = new Map([["cbb-close-game-2026-02-18", { yes_best_bid: 0.85, yes_best_ask: 0.87 }]]);
    const contexts = new Map([["cbb-close-game-2026-02-18", {
      context: { teams: { a: { name: "Home", score: 62 }, b: { name: "Away", score: 60 } } },
      context_entry: { yes_outcome_name: "Home" },
    }]]);

    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].close_reason, "context_sl");
    assert.equal(signals[0].context_margin, 2);
  });

  it("does NOT apply context SL to esports (cs2)", () => {
    const trade = makeTrade("cs2-navi-g2-2026-02-18");
    const bridge = makeBridge({}, { [`buy:${trade.signal_id}`]: trade });
    
    const prices = new Map([["cs2-navi-g2-2026-02-18", { yes_best_bid: 0.70, yes_best_ask: 0.75 }]]);
    const contexts = new Map([["cs2-navi-g2-2026-02-18", {
      context: { teams: { a: { name: "NAVI", score: 5 }, b: { name: "G2", score: 10 } } },
      context_entry: { yes_outcome_name: "NAVI" },
    }]]);

    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    const contextSl = signals.filter(s => s.close_reason === "context_sl");
    assert.equal(contextSl.length, 0); // esports not in contextSlSports
  });

  it("applies to NBA", () => {
    const trade = makeTrade("nba-lakers-celtics-2026-02-18", { entryPrice: 0.85 });
    const bridge = makeBridge({}, { [`buy:${trade.signal_id}`]: trade });
    
    const prices = new Map([["nba-lakers-celtics-2026-02-18", { yes_best_bid: 0.60, yes_best_ask: 0.65 }]]);
    const contexts = new Map([["nba-lakers-celtics-2026-02-18", {
      context: { teams: { a: { name: "Lakers", score: 90 }, b: { name: "Celtics", score: 95 } } },
      context_entry: { yes_outcome_name: "Lakers" },
    }]]);

    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].close_reason, "context_sl");
    assert.equal(signals[0].context_margin, -5);
  });

  it("applies to CWBB", () => {
    const trade = makeTrade("cwbb-uconn-iowa-2026-02-18", { entryPrice: 0.88 });
    const bridge = makeBridge({}, { [`buy:${trade.signal_id}`]: trade });
    
    const prices = new Map([["cwbb-uconn-iowa-2026-02-18", { yes_best_bid: 0.70, yes_best_ask: 0.75 }]]);
    const contexts = new Map([["cwbb-uconn-iowa-2026-02-18", {
      context: { teams: { a: { name: "UConn", score: 50 }, b: { name: "Iowa", score: 55 } } },
      context_entry: { yes_outcome_name: "UConn Huskies" },
    }]]);

    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].close_reason, "context_sl");
  });

  it("price SL takes priority over context SL", () => {
    const trade = makeTrade("cbb-bad-game-2026-02-18");
    const bridge = makeBridge({}, { [`buy:${trade.signal_id}`]: trade });
    
    // bid=0.40 triggers price SL (0.45) AND margin=-10 triggers context SL
    const prices = new Map([["cbb-bad-game-2026-02-18", { yes_best_bid: 0.40, yes_best_ask: 0.45 }]]);
    const contexts = new Map([["cbb-bad-game-2026-02-18", {
      context: { teams: { a: { name: "Home", score: 40 }, b: { name: "Away", score: 50 } } },
      context_entry: { yes_outcome_name: "Home" },
    }]]);

    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].close_reason, "stop_loss"); // price SL first, not context
  });

  it("does nothing when no context available", () => {
    const trade = makeTrade("cbb-no-ctx-2026-02-18");
    const bridge = makeBridge({}, { [`buy:${trade.signal_id}`]: trade });
    
    const prices = new Map([["cbb-no-ctx-2026-02-18", { yes_best_bid: 0.80, yes_best_ask: 0.85 }]]);
    const contexts = new Map(); // empty

    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    assert.equal(signals.length, 0);
  });

  it("respects configurable min_margin_hold", () => {
    const trade = makeTrade("cbb-config-test-2026-02-18");
    const bridge = makeBridge({ min_margin_hold: 5 }, { [`buy:${trade.signal_id}`]: trade });
    
    const prices = new Map([["cbb-config-test-2026-02-18", { yes_best_bid: 0.88, yes_best_ask: 0.90 }]]);
    const contexts = new Map([["cbb-config-test-2026-02-18", {
      context: { teams: { a: { name: "Home", score: 64 }, b: { name: "Away", score: 60 } } },
      context_entry: { yes_outcome_name: "Home" },
    }]]);

    // margin=4, threshold=5 → should sell
    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].close_reason, "context_sl");
    assert.equal(signals[0].context_margin, 4);
  });

  it("logs correct PnL (positive when selling above entry)", () => {
    const trade = makeTrade("cbb-pnl-test-2026-02-18", { entryPrice: 0.90, filledShares: 10, spentUsd: 9.0 });
    const bridge = makeBridge({}, { [`buy:${trade.signal_id}`]: trade });
    
    const prices = new Map([["cbb-pnl-test-2026-02-18", { yes_best_bid: 0.92, yes_best_ask: 0.95 }]]);
    const contexts = new Map([["cbb-pnl-test-2026-02-18", {
      context: { teams: { a: { name: "Home", score: 52 }, b: { name: "Away", score: 50 } } },
      context_entry: { yes_outcome_name: "Home" },
    }]]);

    const signals = bridge.checkPositionsFromCLOB(prices, contexts);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].win, true); // selling at 0.92 > entry 0.90
    assert.ok(signals[0].pnl_usd > 0);
  });
});
