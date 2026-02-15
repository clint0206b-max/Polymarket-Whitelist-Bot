import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectResolved, computePnl } from "../src/runtime/loop_resolution_tracker.mjs";

// Helper: build a Gamma-like market object
function mkMarket({ closed = false, active = true, outcomes = ["Yes", "No"], prices = ["0.5", "0.5"] } = {}) {
  return {
    closed,
    active,
    outcomes: JSON.stringify(outcomes),
    outcomePrices: JSON.stringify(prices),
  };
}

describe("detectResolved", () => {
  // --- Not resolved ---
  it("returns false for active market with 50/50 prices", () => {
    const r = detectResolved(mkMarket());
    assert.equal(r.resolved, false);
  });

  it("returns false for active market at 0.90/0.10", () => {
    const r = detectResolved(mkMarket({ prices: ["0.90", "0.10"] }));
    assert.equal(r.resolved, false);
  });

  it("returns false for active market at 0.99/0.01 (below terminal threshold)", () => {
    const r = detectResolved(mkMarket({ prices: ["0.99", "0.01"] }));
    assert.equal(r.resolved, false);
  });

  it("returns false for null/undefined market", () => {
    assert.equal(detectResolved(null).resolved, false);
    assert.equal(detectResolved(undefined).resolved, false);
    assert.equal(detectResolved({}).resolved, false);
  });

  it("returns false for missing outcomes", () => {
    const r = detectResolved({ closed: true, active: false, outcomePrices: '["1","0"]' });
    assert.equal(r.resolved, false);
  });

  it("returns false for missing prices", () => {
    const r = detectResolved({ closed: true, active: false, outcomes: '["Yes","No"]' });
    assert.equal(r.resolved, false);
  });

  it("returns false for mismatched outcomes/prices length", () => {
    const r = detectResolved(mkMarket({ outcomes: ["Yes", "No", "Maybe"], prices: ["0.5", "0.5"] }));
    assert.equal(r.resolved, false);
  });

  it("returns false for non-numeric prices", () => {
    const r = detectResolved(mkMarket({ closed: true, active: false, prices: ["abc", "def"] }));
    assert.equal(r.resolved, false);
  });

  // --- Official resolution ---
  it("resolves officially when closed=true, active=false, price>=0.99", () => {
    const r = detectResolved(mkMarket({ closed: true, active: false, prices: ["0.99", "0.01"] }));
    assert.equal(r.resolved, true);
    assert.equal(r.method, "official");
    assert.equal(r.winner, "Yes");
    assert.equal(r.maxPrice, 0.99);
  });

  it("resolves officially with 1.0/0.0", () => {
    const r = detectResolved(mkMarket({ closed: true, active: false, prices: ["1", "0"] }));
    assert.equal(r.resolved, true);
    assert.equal(r.method, "official");
    assert.equal(r.winner, "Yes");
  });

  it("resolves officially — No wins", () => {
    const r = detectResolved(mkMarket({ closed: true, active: false, prices: ["0.005", "0.995"] }));
    assert.equal(r.resolved, true);
    assert.equal(r.method, "official");
    assert.equal(r.winner, "No");
  });

  it("does NOT resolve officially if closed but price < 0.99", () => {
    const r = detectResolved(mkMarket({ closed: true, active: false, prices: ["0.85", "0.15"] }));
    assert.equal(r.resolved, false);
  });

  // --- Terminal price resolution ---
  it("resolves via terminal_price when active=true but price>=0.995", () => {
    const r = detectResolved(mkMarket({ closed: false, active: true, prices: ["0.9995", "0.0005"] }));
    assert.equal(r.resolved, true);
    assert.equal(r.method, "terminal_price");
    assert.equal(r.winner, "Yes");
    assert.equal(r.maxPrice, 0.9995);
  });

  it("resolves via terminal_price — No side at 0.999", () => {
    const r = detectResolved(mkMarket({ closed: false, active: true, prices: ["0.001", "0.999"] }));
    assert.equal(r.resolved, true);
    assert.equal(r.method, "terminal_price");
    assert.equal(r.winner, "No");
  });

  it("resolves via terminal_price at exactly 0.995", () => {
    const r = detectResolved(mkMarket({ prices: ["0.995", "0.005"] }));
    assert.equal(r.resolved, true);
    assert.equal(r.method, "terminal_price");
  });

  it("does NOT resolve via terminal_price at 0.994", () => {
    const r = detectResolved(mkMarket({ prices: ["0.994", "0.006"] }));
    assert.equal(r.resolved, false);
  });

  // --- Priority: official over terminal_price ---
  it("prefers official when both conditions met", () => {
    const r = detectResolved(mkMarket({ closed: true, active: false, prices: ["0.999", "0.001"] }));
    assert.equal(r.resolved, true);
    assert.equal(r.method, "official");
  });

  // --- Real Gamma response format (arrays as strings) ---
  it("handles outcomes/prices as already-parsed arrays", () => {
    const r = detectResolved({
      closed: false,
      active: true,
      outcomes: ["Wright State Raiders", "Cleveland State Vikings"],
      outcomePrices: ["0.9995", "0.0005"],
    });
    assert.equal(r.resolved, true);
    assert.equal(r.winner, "Wright State Raiders");
  });

  // --- Edge: 3-way market ---
  it("handles 3-outcome market", () => {
    const r = detectResolved(mkMarket({
      closed: true, active: false,
      outcomes: ["A", "B", "C"],
      prices: ["0.005", "0.99", "0.005"],
    }));
    assert.equal(r.resolved, true);
    assert.equal(r.winner, "B");
  });
});

describe("computePnl", () => {
  it("computes win correctly", () => {
    const r = computePnl(0.95, 10, true);
    // shares = 10 / 0.95 ≈ 10.526
    // pnl = 10.526 * (1 - 0.95) = 10.526 * 0.05 ≈ 0.526
    assert.ok(Math.abs(r.shares - 10.526) < 0.01);
    assert.ok(Math.abs(r.pnl_usd - 0.526) < 0.01);
    assert.ok(r.roi > 0);
  });

  it("computes loss correctly", () => {
    const r = computePnl(0.95, 10, false);
    // pnl = -10.526 * 0.95 = -10
    assert.ok(Math.abs(r.pnl_usd - (-10)) < 0.01);
    assert.ok(r.roi < 0);
  });

  it("returns null for invalid entry price", () => {
    assert.equal(computePnl(0, 10, true).pnl_usd, null);
    assert.equal(computePnl(1, 10, true).pnl_usd, null);
    assert.equal(computePnl(-0.5, 10, true).pnl_usd, null);
    assert.equal(computePnl(null, 10, true).pnl_usd, null);
  });

  it("returns null for invalid notional", () => {
    assert.equal(computePnl(0.95, 0, true).pnl_usd, null);
    assert.equal(computePnl(0.95, -5, true).pnl_usd, null);
  });

  it("roi is pnl/notional", () => {
    const r = computePnl(0.94, 20, true);
    assert.ok(Math.abs(r.roi - r.pnl_usd / 20) < 0.0001);
  });

  it("higher entry price = less profit on win", () => {
    const r1 = computePnl(0.93, 10, true);
    const r2 = computePnl(0.97, 10, true);
    assert.ok(r1.pnl_usd > r2.pnl_usd);
  });

  it("loss equals notional regardless of entry price", () => {
    // pnl = -shares * price = -(notional/price) * price = -notional
    const r1 = computePnl(0.93, 10, false);
    const r2 = computePnl(0.97, 10, false);
    assert.ok(Math.abs(r1.pnl_usd - (-10)) < 0.01);
    assert.ok(Math.abs(r2.pnl_usd - (-10)) < 0.01);
  });
});
