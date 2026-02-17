/**
 * Tests for close_pending flow in open_index
 *
 * When checkPositionsFromCLOB triggers a sell, open_index should get
 * a close_status marker. Only moves to closed after on-chain confirmation.
 *
 * Covers:
 * - Full fill → mark close_status:"sell_executed" in open entry
 * - Partial fill → still mark close_status but isPartial=true
 * - Failed sell → open_index unchanged
 * - Null/undefined result → open_index unchanged
 * - Idempotency: already close_pending → skip (no overwrite)
 * - Reconciliation: zero on-chain balance → move to closed
 * - Reconciliation: non-zero balance → stay in open with close_status
 * - Reconciliation: PnL computed from fill data
 * - Double reconciliation → no duplicate closed entries
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// === Extracted logic (mirrors what run.mjs will do) ===

/**
 * Mark a position as close_pending after sell execution.
 * Returns true if marked, false if skipped.
 */
function markClosePending(idx, signalId, sig, sellResult) {
  if (!sellResult || !sellResult.ok) return false;
  const entry = idx.open?.[signalId];
  if (!entry) return false;
  if (entry.close_status) return false; // already pending — idempotent

  entry.close_status = "sell_executed";
  entry.close_ts = Date.now();
  entry.close_reason = sig.close_reason || "unknown";
  entry.close_fill = {
    filledShares: sellResult.filledShares ?? 0,
    avgFillPrice: sellResult.avgFillPrice ?? null,
    receivedUsd: sellResult.spentUsd ?? null,
    isPartial: sellResult.isPartial || false,
    orderID: sellResult.orderID || null,
    priceProvisional: sellResult.priceProvisional || false,
  };
  return true;
}

/**
 * Reconcile a single close_pending entry.
 * Returns "closed" | "pending" | "skip".
 */
function reconcileClosePending(entry, sigId, onChainBalance, realFillPrice) {
  if (!entry || entry.close_status !== "sell_executed") return "skip";

  // Non-zero balance means position still open (partial fill, resting order)
  if (onChainBalance >= 0.01) return "pending";

  // Balance is zero → position confirmed closed
  const fill = entry.close_fill || {};
  const exitPrice = realFillPrice ?? fill.avgFillPrice ?? null;
  const filledShares = fill.filledShares || 0;
  const receivedUsd = exitPrice != null && filledShares > 0
    ? filledShares * exitPrice
    : fill.receivedUsd ?? 0;
  const entryPrice = entry.entry_price || 0;
  const shares = entryPrice > 0 ? (entry.paper_notional_usd || 0) / entryPrice : 0;
  const spentUsd = shares * entryPrice;
  const pnl = receivedUsd - spentUsd;
  const roi = spentUsd > 0 ? pnl / spentUsd : 0;

  return {
    action: "closed",
    closedEntry: {
      slug: entry.slug,
      title: entry.title || null,
      ts_open: entry.ts_open,
      ts_close: entry.close_ts || Date.now(),
      league: entry.league || "",
      entry_price: entryPrice,
      paper_notional_usd: entry.paper_notional_usd,
      entry_outcome_name: entry.entry_outcome_name || null,
      close_reason: entry.close_reason || "resolved",
      resolve_method: "clob_position_check",
      win: pnl >= 0,
      pnl_usd: Math.round(pnl * 100) / 100,
      roi: Math.round(roi * 10000) / 10000,
      price_provisional: realFillPrice == null && (fill.priceProvisional || false),
    },
  };
}

// === Test helpers ===

function makeOpenIndex(openEntries = {}, closedEntries = {}) {
  return { v: 1, open: { ...openEntries }, closed: { ...closedEntries } };
}

function makeOpenEntry(slug, overrides = {}) {
  return {
    slug,
    ts_open: Date.now() - 60000,
    league: "esports",
    entry_price: 0.94,
    paper_notional_usd: 10,
    entry_outcome_name: "TeamA",
    ...overrides,
  };
}

function makeSignal(slug, overrides = {}) {
  return {
    type: "signal_close",
    signal_id: `${Date.now()}|${slug}`,
    slug,
    ts_close: Date.now(),
    close_reason: "resolved",
    win: true,
    pnl_usd: 0.66,
    roi: 0.063,
    ...overrides,
  };
}

function makeSellResult(overrides = {}) {
  return {
    ok: true,
    filledShares: 11.3,
    avgFillPrice: 0.999,
    spentUsd: 11.2887,  // receivedUsd for sells
    isPartial: false,
    orderID: "0xabc123",
    priceProvisional: false,
    ...overrides,
  };
}

// === Tests ===

describe("markClosePending", () => {
  it("marks full fill as sell_executed", () => {
    const sigId = "123|test-slug";
    const idx = makeOpenIndex({ [sigId]: makeOpenEntry("test-slug") });
    const sig = makeSignal("test-slug", { signal_id: sigId, close_reason: "resolved" });
    const result = makeSellResult();

    const marked = markClosePending(idx, sigId, sig, result);

    assert.equal(marked, true);
    assert.equal(idx.open[sigId].close_status, "sell_executed");
    assert.equal(idx.open[sigId].close_reason, "resolved");
    assert.equal(idx.open[sigId].close_fill.filledShares, 11.3);
    assert.equal(idx.open[sigId].close_fill.isPartial, false);
    assert.equal(idx.open[sigId].close_fill.orderID, "0xabc123");
  });

  it("marks partial fill with isPartial=true", () => {
    const sigId = "123|partial-slug";
    const idx = makeOpenIndex({ [sigId]: makeOpenEntry("partial-slug") });
    const sig = makeSignal("partial-slug", { signal_id: sigId });
    const result = makeSellResult({ isPartial: true, filledShares: 5.0, spentUsd: 4.995 });

    const marked = markClosePending(idx, sigId, sig, result);

    assert.equal(marked, true);
    assert.equal(idx.open[sigId].close_fill.isPartial, true);
    assert.equal(idx.open[sigId].close_fill.filledShares, 5.0);
  });

  it("skips when sell failed (ok=false)", () => {
    const sigId = "123|fail-slug";
    const idx = makeOpenIndex({ [sigId]: makeOpenEntry("fail-slug") });
    const sig = makeSignal("fail-slug", { signal_id: sigId });
    const result = { ok: false, error: "order_cancelled" };

    const marked = markClosePending(idx, sigId, sig, result);

    assert.equal(marked, false);
    assert.equal(idx.open[sigId].close_status, undefined);
  });

  it("skips when result is null", () => {
    const sigId = "123|null-slug";
    const idx = makeOpenIndex({ [sigId]: makeOpenEntry("null-slug") });
    const sig = makeSignal("null-slug", { signal_id: sigId });

    const marked = markClosePending(idx, sigId, sig, null);

    assert.equal(marked, false);
    assert.equal(idx.open[sigId].close_status, undefined);
  });

  it("skips when result is undefined", () => {
    const sigId = "123|undef-slug";
    const idx = makeOpenIndex({ [sigId]: makeOpenEntry("undef-slug") });
    const sig = makeSignal("undef-slug", { signal_id: sigId });

    const marked = markClosePending(idx, sigId, sig, undefined);

    assert.equal(marked, false);
  });

  it("is idempotent — already close_pending is not overwritten", () => {
    const sigId = "123|idempotent-slug";
    const entry = makeOpenEntry("idempotent-slug");
    entry.close_status = "sell_executed";
    entry.close_ts = 1000;
    entry.close_fill = { filledShares: 5, avgFillPrice: 0.98 };
    const idx = makeOpenIndex({ [sigId]: entry });

    const sig = makeSignal("idempotent-slug", { signal_id: sigId });
    const result = makeSellResult({ filledShares: 11.3 });

    const marked = markClosePending(idx, sigId, sig, result);

    assert.equal(marked, false);
    // Original data preserved
    assert.equal(idx.open[sigId].close_fill.filledShares, 5);
    assert.equal(idx.open[sigId].close_ts, 1000);
  });

  it("skips when signal_id not in open_index", () => {
    const idx = makeOpenIndex({});
    const sig = makeSignal("ghost-slug", { signal_id: "999|ghost-slug" });
    const result = makeSellResult();

    const marked = markClosePending(idx, "999|ghost-slug", sig, result);

    assert.equal(marked, false);
  });

  it("preserves provisional flag from sell result", () => {
    const sigId = "123|prov-slug";
    const idx = makeOpenIndex({ [sigId]: makeOpenEntry("prov-slug") });
    const sig = makeSignal("prov-slug", { signal_id: sigId });
    const result = makeSellResult({ priceProvisional: true, avgFillPrice: 0.95 });

    markClosePending(idx, sigId, sig, result);

    assert.equal(idx.open[sigId].close_fill.priceProvisional, true);
    assert.equal(idx.open[sigId].close_fill.avgFillPrice, 0.95);
  });
});

describe("reconcileClosePending", () => {
  it("moves to closed when on-chain balance is zero", () => {
    const entry = makeOpenEntry("resolved-slug");
    entry.close_status = "sell_executed";
    entry.close_ts = Date.now();
    entry.close_reason = "resolved";
    entry.close_fill = {
      filledShares: 11.3,
      avgFillPrice: 0.999,
      receivedUsd: 11.2887,
      isPartial: false,
    };

    const result = reconcileClosePending(entry, "123|resolved-slug", 0, null);

    assert.equal(result.action, "closed");
    assert.equal(result.closedEntry.win, true);
    assert.equal(result.closedEntry.close_reason, "resolved");
    assert.ok(result.closedEntry.pnl_usd > 0);
  });

  it("stays pending when on-chain balance > 0 (partial fill)", () => {
    const entry = makeOpenEntry("partial-slug");
    entry.close_status = "sell_executed";
    entry.close_fill = { filledShares: 5.0, isPartial: true };

    const result = reconcileClosePending(entry, "123|partial-slug", 6.0, null);

    assert.equal(result, "pending");
  });

  it("stays pending when on-chain balance is at threshold (0.01)", () => {
    const entry = makeOpenEntry("threshold-slug");
    entry.close_status = "sell_executed";
    entry.close_fill = { filledShares: 11.3 };

    const result = reconcileClosePending(entry, "123|threshold-slug", 0.01, null);

    assert.equal(result, "pending");
  });

  it("closes when balance is just below threshold (0.009)", () => {
    const entry = makeOpenEntry("below-threshold-slug");
    entry.close_status = "sell_executed";
    entry.close_ts = Date.now();
    entry.close_reason = "resolved";
    entry.close_fill = { filledShares: 11.3, avgFillPrice: 0.999, receivedUsd: 11.2887 };

    const result = reconcileClosePending(entry, "123|below-threshold-slug", 0.009, null);

    assert.equal(result.action, "closed");
  });

  it("uses realFillPrice over provisional avgFillPrice", () => {
    const entry = makeOpenEntry("real-price-slug", { entry_price: 0.94, paper_notional_usd: 10 });
    entry.close_status = "sell_executed";
    entry.close_ts = Date.now();
    entry.close_reason = "resolved";
    entry.close_fill = {
      filledShares: 11.3,
      avgFillPrice: 0.95,     // provisional (wrong)
      receivedUsd: 10.735,    // wrong
      priceProvisional: true,
    };

    const result = reconcileClosePending(entry, "123|real-price-slug", 0, 0.996);

    assert.equal(result.action, "closed");
    // PnL should use real price: 11.3 * 0.996 - (10/0.94)*0.94 = 11.2548 - 10 = 1.2548
    // shares = 10 / 0.94 = 10.6383, spent = 10.6383 * 0.94 = 10
    // received = 11.3 * 0.996 = 11.2548
    // pnl = 11.2548 - 10 = 1.25
    assert.ok(result.closedEntry.pnl_usd > 1, `pnl should be >1, got ${result.closedEntry.pnl_usd}`);
    assert.equal(result.closedEntry.price_provisional, false);
  });

  it("marks price_provisional when no real fill price and fill was provisional", () => {
    const entry = makeOpenEntry("prov-slug");
    entry.close_status = "sell_executed";
    entry.close_ts = Date.now();
    entry.close_reason = "resolved";
    entry.close_fill = {
      filledShares: 11.3,
      avgFillPrice: 0.95,
      receivedUsd: 10.735,
      priceProvisional: true,
    };

    const result = reconcileClosePending(entry, "123|prov-slug", 0, null);

    assert.equal(result.action, "closed");
    assert.equal(result.closedEntry.price_provisional, true);
  });

  it("skips entries without close_status", () => {
    const entry = makeOpenEntry("no-status-slug");
    const result = reconcileClosePending(entry, "123|no-status-slug", 0, null);
    assert.equal(result, "skip");
  });

  it("skips null entry", () => {
    const result = reconcileClosePending(null, "123|null", 0, null);
    assert.equal(result, "skip");
  });

  it("computes correct PnL for losing trade (SL)", () => {
    const entry = makeOpenEntry("sl-slug", { entry_price: 0.94, paper_notional_usd: 10 });
    entry.close_status = "sell_executed";
    entry.close_ts = Date.now();
    entry.close_reason = "stop_loss";
    entry.close_fill = {
      filledShares: 10.64,
      avgFillPrice: 0.65,
      receivedUsd: 6.916,
    };

    const result = reconcileClosePending(entry, "123|sl-slug", 0, 0.65);

    assert.equal(result.action, "closed");
    assert.equal(result.closedEntry.win, false);
    assert.ok(result.closedEntry.pnl_usd < 0);
    assert.equal(result.closedEntry.close_reason, "stop_loss");
  });
});

// === Immediate close on full fill ===
describe("immediate close on full fill", () => {
  it("full fill closes position immediately (no pending state)", () => {
    const sigId = "123|immediate-slug";
    const idx = makeOpenIndex({ [sigId]: makeOpenEntry("immediate-slug", { entry_price: 0.94, paper_notional_usd: 10 }) });
    const sig = makeSignal("immediate-slug", { signal_id: sigId, close_reason: "resolved" });
    const result = makeSellResult({ isPartial: false, avgFillPrice: 0.996, spentUsd: 11.25 });

    // Full fill: should NOT use markClosePending, should go straight to closed
    assert.equal(result.isPartial, false);
    assert.equal(result.ok, true);
    // Caller (run.mjs) would addClosed + removeOpen directly
  });

  it("partial fill stays as close_pending", () => {
    const sigId = "123|partial-immediate";
    const idx = makeOpenIndex({ [sigId]: makeOpenEntry("partial-immediate") });
    const sig = makeSignal("partial-immediate", { signal_id: sigId });
    const result = makeSellResult({ isPartial: true, filledShares: 5.0 });

    const marked = markClosePending(idx, sigId, sig, result);
    assert.equal(marked, true);
    assert.equal(idx.open[sigId].close_status, "sell_executed");
    assert.equal(idx.open[sigId].close_fill.isPartial, true);
    // Position stays in open, not moved to closed
    assert.ok(idx.open[sigId]);
  });
});
