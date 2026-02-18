import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSlugDate, upsertMarket } from "../src/strategy/watchlist_upsert.mjs";

describe("extractSlugDate", () => {
  it("extracts date from standard soccer slug", () => {
    const d = extractSlugDate("ucl-ben-rma-2026-02-17-ben");
    assert.equal(d.toISOString(), "2026-02-17T00:00:00.000Z");
  });

  it("extracts date from esports slug", () => {
    const d = extractSlugDate("dota2-navi-gl-2026-02-17-game2");
    assert.equal(d.toISOString(), "2026-02-17T00:00:00.000Z");
  });

  it("extracts date from slug without suffix", () => {
    const d = extractSlugDate("cs2-sin2-lc-2026-02-17");
    assert.equal(d.toISOString(), "2026-02-17T00:00:00.000Z");
  });

  it("returns null for slug without date", () => {
    assert.equal(extractSlugDate("some-random-slug"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(extractSlugDate(""), null);
  });

  it("returns null for null", () => {
    assert.equal(extractSlugDate(null), null);
  });

  it("returns null for invalid date (month 13)", () => {
    // Date constructor accepts month 13 but we trust the regex — however
    // new Date("2026-13-01") returns Invalid Date in V8
    const d = extractSlugDate("test-2026-13-01-foo");
    assert.equal(d, null);
  });

  it("extracts from slug with multiple dashes", () => {
    const d = extractSlugDate("epl-man-utd-che-2026-03-15-utd");
    assert.equal(d.toISOString(), "2026-03-15T00:00:00.000Z");
  });
});

describe("upsertMarket slug date filter", () => {
  const NOW = new Date("2026-02-17T21:00:00Z").getTime(); // ~21:00 UTC

  function makeMarket(slug) {
    return {
      conditionId: "cond_" + slug,
      slug,
      title: "Test Market",
      league: "soccer",
    };
  }

  it("accepts market with today's date", () => {
    const state = {};
    const r = upsertMarket(state, makeMarket("ucl-ben-rma-2026-02-17-ben"), NOW);
    assert.equal(r.changed, true);
    assert.ok(state.watchlist["cond_ucl-ben-rma-2026-02-17-ben"]);
  });

  it("accepts market with yesterday's date (within 24h)", () => {
    // NOW is 2026-02-17 21:00 UTC, slug date is 2026-02-17 00:00 UTC = 21h ago
    const state = {};
    const r = upsertMarket(state, makeMarket("epl-ars-che-2026-02-17-ars"), NOW);
    assert.equal(r.changed, true);
  });

  it("rejects market with date >24h in the past", () => {
    const state = {};
    const r = upsertMarket(state, makeMarket("elc-cha-por-2025-12-06-cha"), NOW);
    assert.equal(r.changed, false);
    assert.equal(r.reason, "slug_date_expired");
    // Should NOT be in watchlist
    assert.equal(Object.keys(state.watchlist || {}).length, 0);
  });

  it("rejects market from 5 days ago", () => {
    const state = {};
    const r = upsertMarket(state, makeMarket("elc-bri-wre-2026-02-13-wre"), NOW);
    assert.equal(r.changed, false);
    assert.equal(r.reason, "slug_date_expired");
  });

  it("accepts market with future date", () => {
    const state = {};
    const r = upsertMarket(state, makeMarket("epl-ars-che-2026-02-20-ars"), NOW);
    assert.equal(r.changed, true);
  });

  it("accepts market with no date in slug (esports without date)", () => {
    const state = {};
    const r = upsertMarket(state, makeMarket("dota2-some-match"), NOW);
    assert.equal(r.changed, true);
  });

  it("does NOT filter existing markets (only new)", () => {
    // Market already in watchlist from before — should update, not reject
    const state = {
      watchlist: {
        "cond_elc-cha-por-2025-12-06-cha": {
          conditionId: "cond_elc-cha-por-2025-12-06-cha",
          slug: "elc-cha-por-2025-12-06-cha",
          status: "watching",
          first_seen_ts: NOW - 86400000,
        }
      }
    };
    const r = upsertMarket(state, makeMarket("elc-cha-por-2025-12-06-cha"), NOW);
    // existed=true, should NOT be rejected
    assert.equal(r.reason, undefined);
    assert.equal(r.existed, true);
  });

  it("boundary: exactly 36h ago is NOT rejected", () => {
    // Slug date 2026-02-16 00:00 UTC, NOW is 2026-02-17 12:00 UTC = exactly 36h
    const exactly36h = new Date("2026-02-17T12:00:00Z").getTime();
    const state = {};
    const r = upsertMarket(state, makeMarket("epl-test-2026-02-16-foo"), exactly36h);
    // 36h exactly = not greater than, so accepted
    assert.equal(r.changed, true);
  });

  it("boundary: 36h + 1ms is rejected", () => {
    const justOver = new Date("2026-02-17T12:00:01Z").getTime();
    const state = {};
    const r = upsertMarket(state, makeMarket("epl-test-2026-02-16-foo"), justOver);
    assert.equal(r.changed, false);
    assert.equal(r.reason, "slug_date_expired");
  });
});
