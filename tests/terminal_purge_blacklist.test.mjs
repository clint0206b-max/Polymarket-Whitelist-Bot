/**
 * Tests for terminal price purge blacklist.
 * Ensures Gamma can't re-add markets that were purged for having terminal prices.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { upsertMarket } from "../src/strategy/watchlist_upsert.mjs";

describe("terminal purge blacklist", () => {

  it("upsertMarket skips slug in _terminal_purged_slugs", () => {
    const state = {
      watchlist: {},
      _terminal_purged_slugs: new Set(["terminal-slug"]),
    };
    const result = upsertMarket(state, {
      conditionId: "cond1",
      slug: "terminal-slug",
      title: "Test",
      league: "cs2",
    }, Date.now());

    assert.equal(result.changed, false);
    assert.equal(result.reason, "terminal_purged");
    assert.equal(state.watchlist["cond1"], undefined, "should not be added");
  });

  it("upsertMarket allows slug NOT in blacklist", () => {
    const state = {
      watchlist: {},
      _terminal_purged_slugs: new Set(["other-slug"]),
    };
    const result = upsertMarket(state, {
      conditionId: "cond2",
      slug: "fresh-slug",
      title: "Test",
      league: "cs2",
    }, Date.now());

    assert.equal(result.reason, undefined);
    assert.ok(state.watchlist["cond2"], "should be added");
  });

  it("upsertMarket works when _terminal_purged_slugs is undefined", () => {
    const state = { watchlist: {} };
    const result = upsertMarket(state, {
      conditionId: "cond3",
      slug: "any-slug",
      title: "Test",
      league: "cs2",
    }, Date.now());

    assert.ok(state.watchlist["cond3"], "should be added");
  });

  it("upsertMarket works when _terminal_purged_slugs is empty Set", () => {
    const state = {
      watchlist: {},
      _terminal_purged_slugs: new Set(),
    };
    const result = upsertMarket(state, {
      conditionId: "cond4",
      slug: "any-slug",
      title: "Test",
      league: "cs2",
    }, Date.now());

    assert.ok(state.watchlist["cond4"], "should be added");
  });

  it("multiple purged slugs all blocked", () => {
    const state = {
      watchlist: {},
      _terminal_purged_slugs: new Set(["slug-a", "slug-b", "slug-c"]),
    };

    for (const slug of ["slug-a", "slug-b", "slug-c"]) {
      const result = upsertMarket(state, {
        conditionId: `cond-${slug}`,
        slug,
        title: "Test",
        league: "cs2",
      }, Date.now());
      assert.equal(result.reason, "terminal_purged", `${slug} should be blocked`);
    }

    assert.equal(Object.keys(state.watchlist).length, 0, "no markets added");
  });

  it("existing market with same conditionId but purged slug is blocked", () => {
    const state = {
      watchlist: {
        "cond5": { slug: "purged-slug", status: "watching" },
      },
      _terminal_purged_slugs: new Set(["purged-slug"]),
    };

    // Simulate: market was in watchlist, got purged, Gamma tries to re-add
    delete state.watchlist["cond5"];

    const result = upsertMarket(state, {
      conditionId: "cond5",
      slug: "purged-slug",
      title: "Test",
      league: "cs2",
    }, Date.now());

    assert.equal(result.reason, "terminal_purged");
    assert.equal(state.watchlist["cond5"], undefined);
  });
});
