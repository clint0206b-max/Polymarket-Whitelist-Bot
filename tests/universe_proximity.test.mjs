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

// CBB entry: 0.90–0.93, CS2: 0.87–0.93, default: 0.93–0.97
const cfg = {
  polling: { eval_max_markets_per_cycle: 3 },
  filters: {
    min_prob: 0.93,
    max_entry_price: 0.97,
    min_entry_price_cbb: 0.90,
    max_entry_price_cbb: 0.93,
    min_entry_price_cs2: 0.87,
    max_entry_price_cs2: 0.93,
  },
};

describe("selectPipelineUniverse — entry proximity sort", () => {
  it("markets inside entry range come first, regardless of volume", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.91, { vol: 100 }),   // inside CBB range → dist=0
        b: mkMarket("cs2-b", "watching", 0.30, { vol: 50000 }), // far below CS2 range → dist=0.57
        c: mkMarket("cbb-c", "watching", 0.88, { vol: 200 }),   // below CBB range → dist=0.02
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    assert.deepStrictEqual(slugs, ["cbb-a", "cbb-c", "cs2-b"]);
  });

  it("markets closer to range beat farther ones", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.85),  // dist=0.05
        b: mkMarket("cbb-b", "watching", 0.89),  // dist=0.01
        c: mkMarket("cbb-c", "watching", 0.50),  // dist=0.40
        d: mkMarket("cbb-d", "watching", 0.92),  // dist=0 (inside)
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    // d(0) < b(0.01) < a(0.05) — limit 3, c excluded
    assert.deepStrictEqual(slugs, ["cbb-d", "cbb-b", "cbb-a"]);
  });

  it("above-range markets are deprioritized", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.95),  // above CBB max 0.93 → dist=0.02
        b: mkMarket("cbb-b", "watching", 0.91),  // inside → dist=0
        c: mkMarket("cbb-c", "watching", 0.99),  // above → dist=0.06
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    assert.deepStrictEqual(slugs, ["cbb-b", "cbb-a", "cbb-c"]);
  });

  it("ties broken by lastSeen desc", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", 0.91, { lastSeen: 100 }),
        b: mkMarket("cbb-b", "watching", 0.91, { lastSeen: 200 }),
        c: mkMarket("cbb-c", "watching", 0.91, { lastSeen: 150 }),
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
        a: mkMarket("cbb-a", "watching", 0.91),  // inside range
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
        a: mkMarket("cbb-a", "watching", 0.91),
        b: mkMarket("cbb-b", "watching", 0.92),
        c: mkMarket("cbb-c", "watching", 0.90),
        d: mkMarket("cbb-d", "watching", 0.89),  // dist=0.01, just below
        e: mkMarket("cbb-e", "watching", 0.50),  // dist=0.40, far
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
        a: mkMarket("cbb-a", "watching", 0.91),   // CBB inside → 0
        b: mkMarket("cs2-b", "watching", 0.90),    // CS2 inside → 0
        c: mkMarket("lib-c", "watching", 0.95),    // default inside → 0
        d: mkMarket("cbb-d", "watching", 0.80),    // CBB below → 0.10
        e: mkMarket("cs2-e", "watching", 0.80),    // CS2 below → 0.07
      },
    };
    const cfgBig = { ...cfg, polling: { eval_max_markets_per_cycle: 50 } };
    const result = selectPipelineUniverse(state, cfgBig);
    const slugs = result.map(m => m.slug);
    // dist: a=0, b=0, c=0, e=0.07, d=0.10
    // First 3 are all dist=0 (order by lastSeen, all 0 → stable sort)
    assert.ok(slugs.indexOf("cbb-d") > slugs.indexOf("cs2-e")); // d farther than e
  });

  it("markets with no price get Infinity distance (last)", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "watching", null),   // no price → Infinity
        b: mkMarket("cbb-b", "watching", 0.91),   // inside → 0
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    assert.deepStrictEqual(slugs, ["cbb-b", "cbb-a"]);
  });

  it("signaled and expired markets excluded", () => {
    const state = {
      watchlist: {
        a: mkMarket("cbb-a", "signaled", 0.91),
        b: mkMarket("cbb-b", "expired", 0.91),
        c: mkMarket("cbb-c", "watching", 0.91),
      },
    };
    const result = selectPipelineUniverse(state, cfg);
    const slugs = result.map(m => m.slug);
    assert.deepStrictEqual(slugs, ["cbb-c"]);
  });
});
