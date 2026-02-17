import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectPriceUpdateUniverse, selectPipelineUniverse } from "../src/runtime/universe.mjs";

describe("boot quarantine: terminal-looking markets excluded from universes", () => {
  const now = Date.now();

  it("excludes quarantined market from price update universe", () => {
    const state = {
      watchlist: {
        a: { slug: "a", status: "watching", _boot_quarantine_until: now + 30_000 },
        b: { slug: "b", status: "watching" },
      },
    };
    const result = selectPriceUpdateUniverse(state, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].slug, "b");
  });

  it("excludes quarantined market from pipeline universe", () => {
    const state = {
      watchlist: {
        a: { slug: "a", status: "watching", _boot_quarantine_until: now + 30_000 },
        b: { slug: "b", status: "watching" },
      },
    };
    const result = selectPipelineUniverse(state, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].slug, "b");
  });

  it("includes market after quarantine expires", () => {
    const state = {
      watchlist: {
        a: { slug: "a", status: "watching", _boot_quarantine_until: now - 1 },
        b: { slug: "b", status: "watching" },
      },
    };
    const result = selectPriceUpdateUniverse(state, {});
    assert.equal(result.length, 2);
  });

  it("includes market with no quarantine field", () => {
    const state = {
      watchlist: {
        a: { slug: "a", status: "watching" },
      },
    };
    const result = selectPriceUpdateUniverse(state, {});
    assert.equal(result.length, 1);
  });

  it("excludes quarantined pending_signal from pipeline", () => {
    const state = {
      watchlist: {
        a: { slug: "a", status: "pending_signal", _boot_quarantine_until: now + 30_000 },
      },
    };
    const result = selectPipelineUniverse(state, {});
    assert.equal(result.length, 0);
  });

  it("excludes quarantined signaled from price update", () => {
    const state = {
      watchlist: {
        a: { slug: "a", status: "signaled", _boot_quarantine_until: now + 30_000 },
      },
    };
    const result = selectPriceUpdateUniverse(state, {});
    assert.equal(result.length, 0);
  });

  it("quarantine does not affect expired markets (already excluded)", () => {
    const state = {
      watchlist: {
        a: { slug: "a", status: "expired", _boot_quarantine_until: now + 30_000 },
      },
    };
    const priceResult = selectPriceUpdateUniverse(state, {});
    const pipeResult = selectPipelineUniverse(state, {});
    assert.equal(priceResult.length, 0);
    assert.equal(pipeResult.length, 0);
  });
});

describe("boot quarantine marking logic", () => {
  const TERMINAL_THRESHOLD = 0.995;

  it("marks market with bid >= 0.995 as quarantined", () => {
    const m = { last_price: { yes_best_bid: 0.999, yes_best_ask: 0.50 } };
    const bid = Number(m.last_price.yes_best_bid ?? 0);
    const ask = Number(m.last_price.yes_best_ask ?? 0);
    assert.ok(bid >= TERMINAL_THRESHOLD || ask >= TERMINAL_THRESHOLD);
  });

  it("marks market with ask >= 0.995 as quarantined", () => {
    const m = { last_price: { yes_best_bid: 0.50, yes_best_ask: 1.0 } };
    const ask = Number(m.last_price.yes_best_ask ?? 0);
    assert.ok(ask >= TERMINAL_THRESHOLD);
  });

  it("does NOT mark market with bid=0.94, ask=0.96", () => {
    const m = { last_price: { yes_best_bid: 0.94, yes_best_ask: 0.96 } };
    const bid = Number(m.last_price.yes_best_bid ?? 0);
    const ask = Number(m.last_price.yes_best_ask ?? 0);
    assert.ok(bid < TERMINAL_THRESHOLD && ask < TERMINAL_THRESHOLD);
  });

  it("does NOT mark market with no last_price", () => {
    const m = {};
    const bid = Number(m?.last_price?.yes_best_bid ?? 0);
    const ask = Number(m?.last_price?.yes_best_ask ?? 0);
    assert.ok(bid < TERMINAL_THRESHOLD && ask < TERMINAL_THRESHOLD);
  });
});
