// tests/orphan_purge_protection.test.mjs
// Verifies that orphan_pending trades with real shares protect their slugs
// from watchlist purge via openPositionSlugs construction.
//
// Key scenario: big1-sge was purged because execution_state wasn't consulted.
// After defense-in-depth fix, openPositionSlugs includes orphan_pending trades
// with filledShares > 0, preventing purge of markets with real positions.

import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Replicates the fromExec filter from loop_eval_http_only.mjs (lines ~1249-1253).
 * This is the exact logic that builds the execution_state portion of openPositionSlugs.
 */
function buildFromExec(execState) {
  return Object.values(execState?.trades || {})
    .filter(t => String(t.side).toUpperCase() === "BUY" && !t.closed
      && Number(t.filledShares) > 0
      && (t.status === "filled" || t.status === "orphan_pending"))
    .map(t => t.slug);
}

/**
 * Simulates the purge predicate: should this market be purged?
 * Returns true if purge would remove it (not protected).
 */
function wouldPurge(watchlistEntry, openPositionSlugs) {
  return !openPositionSlugs.has(watchlistEntry.slug);
}

describe("orphan_pending purge protection via openPositionSlugs", () => {
  it("orphan_pending with filledShares > 0 protects slug from purge", () => {
    const execState = {
      trades: {
        "buy:sig1|lol-big1-sge-2026-02-19": {
          slug: "lol-big1-sge-2026-02-19",
          side: "BUY",
          status: "orphan_pending",
          filledShares: 15.05882,
          closed: false,
        },
      },
    };

    const fromExec = buildFromExec(execState);
    const openPositionSlugs = new Set(fromExec);

    assert.ok(openPositionSlugs.has("lol-big1-sge-2026-02-19"), "slug should be in openPositionSlugs");

    // Watchlist key is conditionId (different from slug) — verifies key≠slug edge case
    const watchlistEntry = {
      slug: "lol-big1-sge-2026-02-19",
      status: "expired",
      conditionId: "0xabc123conditionid",
    };

    assert.equal(wouldPurge(watchlistEntry, openPositionSlugs), false, "purge should skip protected slug");
  });

  it("orphan_pending with filledShares = 0 does NOT protect slug", () => {
    const execState = {
      trades: {
        "buy:sig2|ghost-trade": {
          slug: "ghost-trade",
          side: "BUY",
          status: "orphan_pending",
          filledShares: 0,
          closed: false,
        },
      },
    };

    const fromExec = buildFromExec(execState);
    const openPositionSlugs = new Set(fromExec);

    assert.ok(!openPositionSlugs.has("ghost-trade"), "slug should NOT be in openPositionSlugs");

    const watchlistEntry = { slug: "ghost-trade", status: "expired" };
    assert.equal(wouldPurge(watchlistEntry, openPositionSlugs), true, "purge should remove unprotected slug");
  });

  it("closed orphan_pending does NOT protect slug even with shares", () => {
    const execState = {
      trades: {
        "buy:sig3|closed-orphan": {
          slug: "closed-orphan",
          side: "BUY",
          status: "orphan_pending",
          filledShares: 50,
          closed: true,
        },
      },
    };

    const fromExec = buildFromExec(execState);
    const openPositionSlugs = new Set(fromExec);

    assert.ok(!openPositionSlugs.has("closed-orphan"), "closed trade should not protect slug");
  });

  it("SELL side orphan_pending does NOT protect slug", () => {
    const execState = {
      trades: {
        "sell:sig4|sell-side": {
          slug: "sell-side",
          side: "SELL",
          status: "orphan_pending",
          filledShares: 10,
          closed: false,
        },
      },
    };

    const fromExec = buildFromExec(execState);
    const openPositionSlugs = new Set(fromExec);

    assert.ok(!openPositionSlugs.has("sell-side"), "SELL trades should not protect slug");
  });

  it("filled trade still protects slug (regression check)", () => {
    const execState = {
      trades: {
        "buy:sig5|normal-filled": {
          slug: "normal-filled",
          side: "BUY",
          status: "filled",
          filledShares: 25,
          closed: false,
        },
      },
    };

    const fromExec = buildFromExec(execState);
    const openPositionSlugs = new Set(fromExec);

    assert.ok(openPositionSlugs.has("normal-filled"), "filled trades must always protect slug");
  });

  it("mixed trades: only valid ones protect their slugs", () => {
    const execState = {
      trades: {
        "buy:real-orphan": {
          slug: "protected-by-orphan",
          side: "BUY",
          status: "orphan_pending",
          filledShares: 10,
          closed: false,
        },
        "buy:real-filled": {
          slug: "protected-by-filled",
          side: "BUY",
          status: "filled",
          filledShares: 20,
          closed: false,
        },
        "buy:ghost": {
          slug: "not-protected-ghost",
          side: "BUY",
          status: "orphan_pending",
          filledShares: 0,
          closed: false,
        },
        "buy:queued": {
          slug: "not-protected-queued",
          side: "BUY",
          status: "queued",
          filledShares: 0,
          closed: false,
        },
        "buy:closed-filled": {
          slug: "not-protected-closed",
          side: "BUY",
          status: "filled",
          filledShares: 30,
          closed: true,
        },
      },
    };

    const fromExec = buildFromExec(execState);
    const openPositionSlugs = new Set(fromExec);

    assert.ok(openPositionSlugs.has("protected-by-orphan"), "orphan with shares protects");
    assert.ok(openPositionSlugs.has("protected-by-filled"), "filled with shares protects");
    assert.ok(!openPositionSlugs.has("not-protected-ghost"), "orphan without shares does not protect");
    assert.ok(!openPositionSlugs.has("not-protected-queued"), "queued does not protect");
    assert.ok(!openPositionSlugs.has("not-protected-closed"), "closed does not protect");
  });

  it("watchlist key differs from slug (conditionId key) — purge still uses m.slug", () => {
    // This is the actual production structure: watchlist keys are conditionIds,
    // but purge checks openPositionSlugs.has(m.slug), not the key.
    const execState = {
      trades: {
        "buy:sig-token": {
          slug: "lol-vitb-zybesp-2026-02-19",
          side: "BUY",
          status: "orphan_pending",
          filledShares: 8.5,
          closed: false,
        },
      },
    };

    const fromExec = buildFromExec(execState);
    const openPositionSlugs = new Set(fromExec);

    // Watchlist keyed by conditionId (0x...) — slug is a property, not the key
    const watchlist = {
      "0xdeadbeef1234567890abcdef": {
        slug: "lol-vitb-zybesp-2026-02-19",
        status: "expired",
        conditionId: "0xdeadbeef1234567890abcdef",
        yes_token_id: "token123",
      },
    };

    for (const [key, m] of Object.entries(watchlist)) {
      // Key is conditionId, NOT slug — but purge checks m.slug
      assert.notEqual(key, m.slug, "key should differ from slug (conditionId-based)");
      assert.equal(wouldPurge(m, openPositionSlugs), false, "purge should skip because m.slug is protected");
    }
  });
});
