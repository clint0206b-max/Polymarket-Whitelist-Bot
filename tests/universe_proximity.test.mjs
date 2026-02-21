import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectPipelineUniverse } from "../src/runtime/universe.mjs";

function mkMarket(slug, status, ask, opts = {}) {
  return {
    slug,
    status,
    last_price: { yes_best_ask: ask },
    last_seen_ts: opts.lastSeen || 0,
    gamma_vol24h_usd: opts.vol || 0,
    ...(opts.extra || {}),
  };
}

// All sports now use same entry range: 0.98–0.999
const cfg = {
  polling: { eval_max_markets_per_cycle: 3 },
  filters: {
    min_prob: 0.93,
    max_entry_price: 0.97,
    min_entry_price_cbb: 0.98,
    max_entry_price_cbb: 0.999,
    min_entry_price_cs2: 0.98,
    max_entry_price_cs2: 0.999,
  },
};

describe("selectPipelineUniverse — entry proximity sort", () => {
  it("markets inside entry range come first, regardless of volume", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.99, { vol: 100 }),   // inside CBB range → dist=0
        b: mkMarket("cs2-b", "watching", 0.30, { vol: 50000 }), // far below CS2 range → dist=0.68
        c: mkMarket("cbb-c", "watching", 0.985, { vol: 200 }), // inside CBB range → dist=0
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    assert.deepStrictEqual(slugs, ["cbb-a", "cbb-c", "cs2-b"]);
  });

  it("markets closer to range beat farther ones", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.975),  // dist=0.005 (below 0.98)
        b: mkMarket("cbb-b", "watching", 0.99),  // dist=0 (inside 0.98-0.999)
        c: mkMarket("cbb-c", "watching", 0.50),  // dist=0.48 (below 0.98)
        d: mkMarket("cbb-d", "watching", 0.995),  // dist=0 (inside)
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    // b(0) and d(0) tied, stable sort → b before d; a(0.005) third — limit 3, c excluded
    assert.deepStrictEqual(slugs, ["cbb-b", "cbb-d", "cbb-a"]);
  });

  it("above-range markets are deprioritized", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.9995),  // above CBB max 0.999 → dist=0.0005
        b: mkMarket("cbb-b", "watching", 0.99),  // inside → dist=0
        c: mkMarket("cbb-c", "watching", 1.00),  // above → dist=0.001
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    assert.deepStrictEqual(slugs, ["cbb-b", "cbb-a", "cbb-c"]);
  });

  it("ties broken by lastSeen desc", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.99, { lastSeen: 100 }),
        b: mkMarket("cbb-b", "watching", 0.99, { lastSeen: 200 }),
        c: mkMarket("cbb-c", "watching", 0.99, { lastSeen: 150 }),
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    // All dist=0, sort by lastSeen desc
    assert.deepStrictEqual(slugs, ["cbb-b", "cbb-c", "cbb-a"]);
  });

  it("pending_signal still takes absolute priority", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.99),  // inside range
        b: mkMarket("cbb-b", "pending_signal", 0.50, { extra: { pending_since_ts: 1000 } }),
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    // Only pending, watching excluded
    assert.deepStrictEqual(slugs, ["cbb-b"]);
  });

  it("respects eval_max_markets_per_cycle limit", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.99),
        b: mkMarket("cbb-b", "watching", 0.995),
        c: mkMarket("cbb-c", "watching", 0.985),
        d: mkMarket("cbb-d", "watching", 0.975),  // dist=0.005, just below
        e: mkMarket("cbb-e", "watching", 0.50),  // dist=0.48, far
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    assert.equal(result.length, 3); // max 3
    // All of a, b, c are inside (dist=0); d and e excluded
    const slugs = result.map(m => m.slug);
    assert.ok(!slugs.includes("cbb-e")); // farthest excluded
  });

  it("per-sport ranges work correctly across sports", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.99),   // CBB inside → 0
        b: mkMarket("cs2-b", "watching", 0.99),    // CS2 inside → 0
        c: mkMarket("lib-c", "watching", 0.95),    // default inside → 0
        d: mkMarket("cbb-d", "watching", 0.70),    // CBB below → 0.28
        e: mkMarket("cs2-e", "watching", 0.90),    // CS2 below → 0.08
      },
    };
    const cfgBig = { ...cfg, polling: { eval_max_markets_per_cycle: 50 } };
    const result = selectPipelineUniverse(state, cfgBig);
    const slugs = result.map(m => m.slug);
    // dist: a=0, b=0, c=0, e=0.08, d=0.28
    // First 3 are all dist=0 (order by lastSeen, all 0 → stable sort)
    assert.ok(slugs.indexOf("cbb-d") > slugs.indexOf("cs2-e")); // d farther than e
  });

  it("markets with no price get Infinity distance (last)", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", null),   // no price → Infinity
        b: mkMarket("cbb-b", "watching", 0.99),   // inside → 0
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    assert.deepStrictEqual(slugs, ["cbb-b", "cbb-a"]);
  });

  it("signaled and expired markets excluded", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "signaled", 0.99),
        b: mkMarket("cbb-b", "expired", 0.99),
        c: mkMarket("cbb-c", "watching", 0.99),
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    assert.deepStrictEqual(slugs, ["cbb-c"]);
  });
});
