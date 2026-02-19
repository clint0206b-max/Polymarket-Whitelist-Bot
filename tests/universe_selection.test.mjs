/**
 * Universe Selection Tests (v1.0)
 * 
 * Validates centralized universe logic in src/runtime/universe.mjs
 * 
 * CRITICAL INVARIANTS (must never break):
 * 1. Price update universe = watching + pending_signal + signaled
 * 2. Pipeline universe = watching + pending_signal (NO signaled)
 * 3. Pipeline priority: pending first (oldest), then watching (by vol desc)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectPriceUpdateUniverse, selectPipelineUniverse, selectAllActive } from "../src/runtime/universe.mjs";

// Helper: create minimal market object
function market(id, status, overrides = {}) {
  return {
    slug: `market-${id}`,
    conditionId: `cond-${id}`,
    status,
    gamma_vol24h_usd: 1000,
    last_seen_ts: Date.now(),
    ...overrides
  };
}

// Helper: create state with watchlist
function stateWith(...markets) {
  const wl = {};
  for (const m of markets) {
    wl[m.conditionId] = m;
  }
  return { watchlist: wl };
}

describe("selectPriceUpdateUniverse", () => {
  it("includes watching, pending_signal, signaled", () => {
    const state = stateWith(
      market("1", "watching"),
      market("2", "pending_signal"),
      market("3", "signaled"),
      market("4", "expired"),
      market("5", "ignored"),
      market("6", "traded")
    );

    const result = selectPriceUpdateUniverse(state, {});
    const slugs = result.map(m => m.slug).sort();

    assert.deepEqual(slugs, ["market-1", "market-2", "market-3"]);
  });

  it("excludes expired, ignored, traded", () => {
    const state = stateWith(
      market("1", "expired"),
      market("2", "ignored"),
      market("3", "traded")
    );

    const result = selectPriceUpdateUniverse(state, {});
    assert.equal(result.length, 0);
  });

  it("includes signaled (spec requirement)", () => {
    const state = stateWith(
      market("1", "signaled")
    );

    const result = selectPriceUpdateUniverse(state, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].status, "signaled");
  });

  it("handles empty watchlist", () => {
    const state = { watchlist: {} };
    const result = selectPriceUpdateUniverse(state, {});
    assert.equal(result.length, 0);
  });

  it("handles missing watchlist", () => {
    const state = {};
    const result = selectPriceUpdateUniverse(state, {});
    assert.equal(result.length, 0);
  });
});

describe("selectPipelineUniverse", () => {
  it("includes watching and pending_signal only (no pending present)", () => {
    const state = stateWith(
      market("1", "watching"),
      market("3", "signaled"),
      market("4", "expired")
    );

    const result = selectPipelineUniverse(state, {});
    const slugs = result.map(m => m.slug).sort();

    assert.deepEqual(slugs, ["market-1"]);
  });

  it("includes watching and pending_signal (status check)", () => {
    // Test with NO pending: watching should be included
    const stateWatching = stateWith(
      market("1", "watching"),
      market("2", "signaled")
    );
    const resultWatching = selectPipelineUniverse(stateWatching, {});
    assert.equal(resultWatching.length, 1);
    assert.equal(resultWatching[0].status, "watching");

    // Test with pending: only pending should be included (scheduling fix)
    const statePending = stateWith(
      market("1", "watching", { gamma_vol24h_usd: 50000 }),
      market("2", "pending_signal")
    );
    const resultPending = selectPipelineUniverse(statePending, {});
    assert.equal(resultPending.length, 1);
    assert.equal(resultPending[0].status, "pending_signal");
  });

  it("NEVER includes signaled (critical invariant)", () => {
    const state = stateWith(
      market("1", "signaled"),
      market("2", "signaled", { gamma_vol24h_usd: 999999 }) // high vol, should still be excluded
    );

    const result = selectPipelineUniverse(state, {});
    assert.equal(result.length, 0, "signaled markets must NEVER enter pipeline");
  });

  it("prioritizes ALL pending_signal first", () => {
    const now = Date.now();
    const state = stateWith(
      market("watching-1", "watching", { gamma_vol24h_usd: 50000 }), // high vol
      market("pending-1", "pending_signal", { pending_since_ts: now - 5000 }), // oldest pending
      market("watching-2", "watching", { gamma_vol24h_usd: 40000 }),
      market("pending-2", "pending_signal", { pending_since_ts: now - 3000 }), // newer pending
      market("watching-3", "watching", { gamma_vol24h_usd: 30000 })
    );

    const result = selectPipelineUniverse(state, {});
    
    // ONLY pending should be returned (scheduling fix)
    assert.equal(result.length, 2);
    assert.ok(result.every(m => m.status === "pending_signal"), "when pending exists, ONLY pending should be returned");
    
    // Oldest pending first
    assert.equal(result[0].slug, "market-pending-1");
    assert.equal(result[1].slug, "market-pending-2");
  });

  it("sorts watching by entry proximity (closest to range first)", () => {
    // Default entry range: min_prob=0.93, max_entry_price=0.97
    // All slugs start with "market" → use default range
    const state = stateWith(
      market("1", "watching", { last_price: { yes_best_ask: 0.80 } }),  // dist=0.13
      market("2", "watching", { last_price: { yes_best_ask: 0.95 } }),  // dist=0 (inside)
      market("3", "watching", { last_price: { yes_best_ask: 0.90 } })   // dist=0.03
    );

    const cfg = { filters: { min_prob: 0.93, max_entry_price: 0.97 } };
    const result = selectPipelineUniverse(state, cfg);
    
    assert.equal(result[0].slug, "market-2");  // inside range
    assert.equal(result[1].slug, "market-3");  // 0.03 away
    assert.equal(result[2].slug, "market-1");  // 0.13 away
  });

  it("respects max_markets_per_cycle limit for watching", () => {
    const state = stateWith(
      market("1", "watching", { gamma_vol24h_usd: 500 }),
      market("2", "watching", { gamma_vol24h_usd: 400 }),
      market("3", "watching", { gamma_vol24h_usd: 300 }),
      market("4", "watching", { gamma_vol24h_usd: 200 }),
      market("5", "watching", { gamma_vol24h_usd: 100 })
    );

    const cfg = { polling: { eval_max_markets_per_cycle: 3 } };
    const result = selectPipelineUniverse(state, cfg);
    
    assert.equal(result.length, 3);
    assert.equal(result[0].gamma_vol24h_usd, 500);
    assert.equal(result[1].gamma_vol24h_usd, 400);
    assert.equal(result[2].gamma_vol24h_usd, 300);
  });

  it("does NOT respect max limit for pending (all pending always returned)", () => {
    const now = Date.now();
    const state = stateWith(
      market("pending-1", "pending_signal", { pending_since_ts: now - 5000 }),
      market("pending-2", "pending_signal", { pending_since_ts: now - 4000 }),
      market("pending-3", "pending_signal", { pending_since_ts: now - 3000 }),
      market("pending-4", "pending_signal", { pending_since_ts: now - 2000 }),
      market("watching-1", "watching", { gamma_vol24h_usd: 50000 })
    );

    const cfg = { polling: { eval_max_markets_per_cycle: 2 } };
    const result = selectPipelineUniverse(state, cfg);
    
    // ALL 4 pending should be returned, limit only applies to watching
    assert.equal(result.length, 4);
    assert.ok(result.every(m => m.status === "pending_signal"));
  });

  it("breaks vol ties by lastSeen desc", () => {
    const now = Date.now();
    const state = stateWith(
      market("1", "watching", { gamma_vol24h_usd: 1000, last_seen_ts: now - 5000 }),
      market("2", "watching", { gamma_vol24h_usd: 1000, last_seen_ts: now - 1000 }) // more recent
    );

    const result = selectPipelineUniverse(state, {});
    
    // Tie on vol, should sort by lastSeen desc (more recent first)
    assert.equal(result[0].slug, "market-2");
    assert.equal(result[1].slug, "market-1");
  });

  it("handles empty watchlist", () => {
    const state = { watchlist: {} };
    const result = selectPipelineUniverse(state, {});
    assert.equal(result.length, 0);
  });
});

describe("selectAllActive", () => {
  it("excludes only expired", () => {
    const state = stateWith(
      market("1", "watching"),
      market("2", "pending_signal"),
      market("3", "signaled"),
      market("4", "expired"),
      market("5", "ignored"),
      market("6", "traded")
    );

    const result = selectAllActive(state);
    const slugs = result.map(m => m.slug).sort();

    assert.deepEqual(slugs, ["market-1", "market-2", "market-3", "market-5", "market-6"]);
  });

  it("includes all statuses except expired", () => {
    const state = stateWith(
      market("1", "watching"),
      market("2", "expired")
    );

    const result = selectAllActive(state);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, "watching");
  });

  it("handles empty watchlist", () => {
    const state = { watchlist: {} };
    const result = selectAllActive(state);
    assert.equal(result.length, 0);
  });
});

describe("Universe Integrity (cross-function)", () => {
  it("pipeline universe is always subset of price update universe", () => {
    const state = stateWith(
      market("1", "watching"),
      market("2", "pending_signal"),
      market("3", "signaled"),
      market("4", "expired")
    );

    const priceUni = selectPriceUpdateUniverse(state, {});
    const pipelineUni = selectPipelineUniverse(state, {});

    const priceSlugs = new Set(priceUni.map(m => m.slug));
    const pipelineSlugs = pipelineUni.map(m => m.slug);

    // Every market in pipeline must also be in price universe
    for (const slug of pipelineSlugs) {
      assert.ok(priceSlugs.has(slug), `${slug} in pipeline but not in price universe`);
    }
  });

  it("signaled never appears in pipeline universe", () => {
    const state = stateWith(
      market("1", "signaled", { gamma_vol24h_usd: 999999, pending_since_ts: Date.now() - 1000 })
    );

    const pipelineUni = selectPipelineUniverse(state, {});
    assert.equal(pipelineUni.length, 0, "signaled must NEVER be in pipeline");
  });

  it("price universe always includes signaled", () => {
    const state = stateWith(
      market("1", "signaled")
    );

    const priceUni = selectPriceUpdateUniverse(state, {});
    assert.equal(priceUni.length, 1);
    assert.equal(priceUni[0].status, "signaled");
  });
});
