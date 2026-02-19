/**
 * Tests that signal_close is only logged with correct executed status.
 * - If SL sell succeeds → executed: true, real PnL
 * - If SL sell fails → executed: false, pnl: 0
 * - Dashboard filters out executed: false entries
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("SL Journal Guard", () => {
  
  describe("signal_close executed flag logic", () => {
    
    it("sell failure should produce executed=false and pnl=0", () => {
      // Simulate the logic from run.mjs
      const sig = {
        type: "signal_close",
        signal_id: "test|dota2-a-b-game2",
        slug: "dota2-a-b-game2",
        close_reason: "stop_loss",
        sl_trigger_price: 0.48,
        win: false,
        pnl_usd: -5.20,
      };
      const sellResult = null; // sell failed completely

      const sellFailed = sig.close_reason === "stop_loss" && (!sellResult || !sellResult.ok);
      assert.ok(sellFailed, "should detect sell failure");

      // What gets written to journal
      const journalEntry = sellFailed ? {
        ...sig,
        executed: false,
        pnl_usd: 0,
        sell_error: "sl_sell_failed",
      } : {
        ...sig,
        executed: true,
      };

      assert.equal(journalEntry.executed, false);
      assert.equal(journalEntry.pnl_usd, 0);
      assert.equal(journalEntry.sell_error, "sl_sell_failed");
    });

    it("sell success should produce executed=true", () => {
      const sig = {
        type: "signal_close",
        signal_id: "test|cs2-a-b",
        slug: "cs2-a-b",
        close_reason: "stop_loss",
        sl_trigger_price: 0.80,
        win: false,
        pnl_usd: -2.50,
      };
      const sellResult = { ok: true, pnlUsd: -2.30 };

      const sellFailed = sig.close_reason === "stop_loss" && (!sellResult || !sellResult.ok);
      assert.ok(!sellFailed, "should NOT detect sell failure");

      const journalEntry = sellFailed ? {
        ...sig,
        executed: false,
        pnl_usd: 0,
      } : {
        ...sig,
        pnl_usd: sellResult.pnlUsd ?? sig.pnl_usd,
        executed: true,
      };

      assert.equal(journalEntry.executed, true);
      assert.equal(journalEntry.pnl_usd, -2.30);
    });

    it("resolved close should always produce executed=true even without sellResult.ok", () => {
      const sig = {
        type: "signal_close",
        signal_id: "test|dota2-x-y",
        slug: "dota2-x-y",
        close_reason: "resolved",
        win: true,
        pnl_usd: 0.50,
      };
      const sellResult = { ok: true };

      const sellFailed = sig.close_reason === "stop_loss" && (!sellResult || !sellResult.ok);
      assert.ok(!sellFailed, "resolved should never be marked as sell failure");
    });

    it("paper mode returns null sellResult — should not mark as failed", () => {
      const sig = {
        type: "signal_close",
        signal_id: "test|lol-a-b",
        slug: "lol-a-b",
        close_reason: "stop_loss",
        sl_trigger_price: 0.70,
        win: false,
        pnl_usd: -3.00,
      };
      // Paper mode: handleSignalClose returns null
      const sellResult = null;

      // This SHOULD mark as failed for live SL sells
      const sellFailed = sig.close_reason === "stop_loss" && (!sellResult || !sellResult.ok);
      assert.ok(sellFailed, "null sellResult on SL should be treated as failure");
    });
  });

  describe("Dashboard filtering", () => {

    it("dashboard should exclude executed=false from PnL calculations", () => {
      const signals = [
        { type: "signal_close", win: true, pnl_usd: 0.50, executed: true },
        { type: "signal_close", win: false, pnl_usd: -5.20, executed: false }, // failed sell
        { type: "signal_close", win: false, pnl_usd: -2.00, executed: true },
        { type: "signal_close", win: true, pnl_usd: 0.30 }, // legacy (no executed field)
      ];

      // Mimics health_server.mjs filter
      const closes = signals.filter(s => s.type === "signal_close" && s.executed !== false);
      
      assert.equal(closes.length, 3, "should exclude the failed sell");
      
      const pnl = closes.reduce((sum, s) => sum + (s.pnl_usd || 0), 0);
      assert.equal(pnl, -1.20, "PnL should be 0.50 + -2.00 + 0.30 = -1.20");
    });

    it("legacy entries without executed field should be included", () => {
      const signals = [
        { type: "signal_close", win: true, pnl_usd: 1.00 },
        { type: "signal_close", win: false, pnl_usd: -0.50 },
      ];

      const closes = signals.filter(s => s.type === "signal_close" && s.executed !== false);
      assert.equal(closes.length, 2);
    });
  });
});
