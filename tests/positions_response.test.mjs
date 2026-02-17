/**
 * Tests for buildPositionsResponse — open positions with current prices.
 *
 * Covers:
 * - Current bid/ask from watchlist state
 * - Unrealized PnL calculation
 * - Missing watchlist data (null current price)
 * - Empty positions
 * - Multiple positions
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Simulate buildPositionsResponse logic (extracted from health_server.mjs)
function buildPositionsResponse(openIndex, watchlistState) {
  const open = openIndex?.open || {};
  const wl = watchlistState || {};
  return {
    as_of_ts: Date.now(),
    items: Object.values(open).map(p => {
      const market = Object.values(wl).find(m => m?.slug === p.slug);
      const currentBid = market?.last_price?.yes_best_bid ?? null;
      const currentAsk = market?.last_price?.yes_best_ask ?? null;
      const entryPrice = p.entry_price || 0;
      const shares = p.paper_notional_usd ? p.paper_notional_usd / entryPrice : 0;
      const unrealizedPnl = currentBid != null && entryPrice > 0
        ? (currentBid - entryPrice) * shares : null;
      return {
        slug: p.slug, title: p.title || null,
        league: p.league || "", market_kind: p.market_kind || null,
        ts_open: p.ts_open, entry_price: entryPrice,
        current_bid: currentBid,
        current_ask: currentAsk,
        unrealized_pnl: unrealizedPnl != null ? Math.round(unrealizedPnl * 100) / 100 : null,
        paper_notional_usd: p.paper_notional_usd,
        entry_outcome_name: p.entry_outcome_name,
        price_tracking: p.price_tracking || null,
      };
    }),
  };
}

describe("buildPositionsResponse", () => {

  it("includes current_bid and current_ask from watchlist", () => {
    const idx = {
      open: {
        "sig1|slug-a": { slug: "slug-a", entry_price: 0.93, paper_notional_usd: 10, ts_open: 1000 },
      },
    };
    const wl = {
      "slug-a": { slug: "slug-a", last_price: { yes_best_bid: 0.95, yes_best_ask: 0.96 } },
    };
    const res = buildPositionsResponse(idx, wl);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].current_bid, 0.95);
    assert.equal(res.items[0].current_ask, 0.96);
  });

  it("calculates unrealized PnL correctly (profit)", () => {
    const idx = {
      open: {
        "sig|slug": { slug: "slug", entry_price: 0.93, paper_notional_usd: 10, ts_open: 1000 },
      },
    };
    const wl = {
      slug: { slug: "slug", last_price: { yes_best_bid: 0.97, yes_best_ask: 0.98 } },
    };
    const res = buildPositionsResponse(idx, wl);
    // shares = 10 / 0.93 ≈ 10.7527
    // unrealizedPnl = (0.97 - 0.93) * 10.7527 ≈ 0.43
    assert.ok(res.items[0].unrealized_pnl > 0);
    assert.ok(Math.abs(res.items[0].unrealized_pnl - 0.43) < 0.02);
  });

  it("calculates unrealized PnL correctly (loss)", () => {
    const idx = {
      open: {
        "sig|slug": { slug: "slug", entry_price: 0.93, paper_notional_usd: 10, ts_open: 1000 },
      },
    };
    const wl = {
      slug: { slug: "slug", last_price: { yes_best_bid: 0.80, yes_best_ask: 0.82 } },
    };
    const res = buildPositionsResponse(idx, wl);
    // shares = 10 / 0.93 ≈ 10.7527
    // unrealizedPnl = (0.80 - 0.93) * 10.7527 ≈ -1.40
    assert.ok(res.items[0].unrealized_pnl < 0);
    assert.ok(Math.abs(res.items[0].unrealized_pnl - (-1.40)) < 0.02);
  });

  it("returns null current_bid/ask when market not in watchlist", () => {
    const idx = {
      open: {
        "sig|slug": { slug: "slug", entry_price: 0.93, paper_notional_usd: 10, ts_open: 1000 },
      },
    };
    const wl = {}; // empty watchlist
    const res = buildPositionsResponse(idx, wl);
    assert.equal(res.items[0].current_bid, null);
    assert.equal(res.items[0].current_ask, null);
    assert.equal(res.items[0].unrealized_pnl, null);
  });

  it("returns null unrealized_pnl when bid is null", () => {
    const idx = {
      open: {
        "sig|slug": { slug: "slug", entry_price: 0.93, paper_notional_usd: 10, ts_open: 1000 },
      },
    };
    const wl = {
      slug: { slug: "slug", last_price: { yes_best_bid: null, yes_best_ask: 0.95 } },
    };
    const res = buildPositionsResponse(idx, wl);
    assert.equal(res.items[0].unrealized_pnl, null);
  });

  it("handles empty open index", () => {
    const res = buildPositionsResponse({ open: {} }, {});
    assert.equal(res.items.length, 0);
  });

  it("handles null open index", () => {
    const res = buildPositionsResponse(null, {});
    assert.equal(res.items.length, 0);
  });

  it("handles multiple positions with different prices", () => {
    const idx = {
      open: {
        "s1|a": { slug: "a", entry_price: 0.93, paper_notional_usd: 10, ts_open: 1000 },
        "s2|b": { slug: "b", entry_price: 0.95, paper_notional_usd: 10, ts_open: 2000 },
      },
    };
    const wl = {
      a: { slug: "a", last_price: { yes_best_bid: 0.99, yes_best_ask: 1.0 } },
      b: { slug: "b", last_price: { yes_best_bid: 0.70, yes_best_ask: 0.75 } },
    };
    const res = buildPositionsResponse(idx, wl);
    assert.equal(res.items.length, 2);
    const posA = res.items.find(p => p.slug === "a");
    const posB = res.items.find(p => p.slug === "b");
    assert.ok(posA.unrealized_pnl > 0, "position A should be profitable");
    assert.ok(posB.unrealized_pnl < 0, "position B should be losing");
  });

  it("preserves entry_price, league, title from open_index", () => {
    const idx = {
      open: {
        "s|x": {
          slug: "x", entry_price: 0.94, paper_notional_usd: 10,
          ts_open: 5000, title: "Test Match", league: "cs2",
          entry_outcome_name: "Team A", market_kind: "game",
        },
      },
    };
    const res = buildPositionsResponse(idx, {});
    assert.equal(res.items[0].entry_price, 0.94);
    assert.equal(res.items[0].league, "cs2");
    assert.equal(res.items[0].title, "Test Match");
    assert.equal(res.items[0].entry_outcome_name, "Team A");
    assert.equal(res.items[0].market_kind, "game");
  });

  it("unrealized PnL rounds to 2 decimal places", () => {
    const idx = {
      open: {
        "s|x": { slug: "x", entry_price: 0.93, paper_notional_usd: 10, ts_open: 1000 },
      },
    };
    const wl = {
      x: { slug: "x", last_price: { yes_best_bid: 0.9333, yes_best_ask: 0.94 } },
    };
    const res = buildPositionsResponse(idx, wl);
    // Should be rounded to 2 decimals
    const pnlStr = res.items[0].unrealized_pnl.toString();
    const decimals = pnlStr.includes(".") ? pnlStr.split(".")[1].length : 0;
    assert.ok(decimals <= 2, `PnL has ${decimals} decimals: ${pnlStr}`);
  });
});
