import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSoccerSlug, isSoccerBannedSlug, isSpreadOrTotalSlug } from "../src/gamma/gamma_parser.mjs";

// ─── isSoccerSlug ────────────────────────────────────────────

describe("isSoccerSlug", () => {
  // Top 5 leagues
  it("recognizes EPL slug", () => assert.ok(isSoccerSlug("epl-wol-ars-2026-02-18-ars")));
  it("recognizes La Liga slug", () => assert.ok(isSoccerSlug("lal-gir-bar-2026-02-16-bar")));
  it("recognizes Serie A slug", () => assert.ok(isSoccerSlug("sea-nap-rom-2026-02-15-nap")));
  it("recognizes Ligue 1 slug", () => assert.ok(isSoccerSlug("fl1-lyo-ogc-2026-02-15-lyo")));
  it("recognizes Bundesliga slug", () => assert.ok(isSoccerSlug("bun-bay-dor-2026-02-15-bay")));

  // UEFA
  it("recognizes Champions League slug", () => assert.ok(isSoccerSlug("ucl-ben-rma-2026-02-17-ben")));
  it("recognizes Europa League slug", () => assert.ok(isSoccerSlug("uel-ath-bil-2026-02-17-ath")));

  // Other leagues
  it("recognizes Liga MX slug", () => assert.ok(isSoccerSlug("mex-caz-tig-2026-02-15-caz")));
  it("recognizes Argentina slug", () => assert.ok(isSoccerSlug("arg-boc-pla-2026-02-15-boc")));
  it("recognizes Eredivisie slug", () => assert.ok(isSoccerSlug("ere-spa-nec-2026-02-15-spa")));
  it("recognizes Portugal slug", () => assert.ok(isSoccerSlug("por-spo-fam-2026-02-15-spo")));

  // Non-soccer
  it("rejects NBA slug", () => assert.ok(!isSoccerSlug("nba-lakers-celtics-2026-02-15")));
  it("rejects esports slug", () => assert.ok(!isSoccerSlug("lol-c9-fly-2026-02-15")));
  it("rejects empty", () => assert.ok(!isSoccerSlug("")));
  it("rejects null", () => assert.ok(!isSoccerSlug(null)));

  // Case insensitive
  it("case insensitive", () => assert.ok(isSoccerSlug("EPL-WOL-ARS-2026-02-18-ARS")));
});

// ─── isSoccerBannedSlug ──────────────────────────────────────

describe("isSoccerBannedSlug", () => {
  // --- Must PASS (team-win markets) ---
  it("allows team-win market (EPL)", () => {
    assert.ok(!isSoccerBannedSlug("epl-wol-ars-2026-02-18-ars"));
  });
  it("allows team-win market (La Liga)", () => {
    assert.ok(!isSoccerBannedSlug("lal-mal-bet-2026-02-15-bet"));
  });
  it("allows team-win market (Serie A)", () => {
    assert.ok(!isSoccerBannedSlug("sea-nap-rom-2026-02-15-nap"));
  });
  it("allows team-win market (Champions League)", () => {
    assert.ok(!isSoccerBannedSlug("ucl-ben-rma-2026-02-17-rma"));
  });
  it("allows team-win market (Argentina)", () => {
    assert.ok(!isSoccerBannedSlug("arg-boc-pla-2026-02-15-boc"));
  });

  // --- Must BAN ---
  it("bans draw market", () => {
    assert.ok(isSoccerBannedSlug("epl-wol-ars-2026-02-18-draw"));
  });
  it("bans draw market (La Liga)", () => {
    assert.ok(isSoccerBannedSlug("lal-mal-bet-2026-02-15-draw"));
  });
  it("bans total market (2.5)", () => {
    assert.ok(isSoccerBannedSlug("fl1-lyo-ogc-2026-02-15-total-2pt5"));
  });
  it("bans total market (4.5)", () => {
    assert.ok(isSoccerBannedSlug("fl1-lyo-ogc-2026-02-15-total-4pt5"));
  });
  it("bans spread market (home)", () => {
    assert.ok(isSoccerBannedSlug("lal-get-vil-2026-02-15-spread-home-1pt5"));
  });
  it("bans spread market (away)", () => {
    assert.ok(isSoccerBannedSlug("lal-mal-bet-2026-02-15-spread-away-2pt5"));
  });
  it("bans btts market", () => {
    assert.ok(isSoccerBannedSlug("fl1-lyo-ogc-2026-02-15-btts"));
  });
  it("bans over market", () => {
    assert.ok(isSoccerBannedSlug("epl-wol-ars-2026-02-18-over-2pt5"));
  });
  it("bans under market", () => {
    assert.ok(isSoccerBannedSlug("epl-wol-ars-2026-02-18-under-3pt5"));
  });

  // --- Non-soccer slugs: never banned by this function ---
  it("non-soccer slug is never banned", () => {
    assert.ok(!isSoccerBannedSlug("nba-lakers-celtics-draw"));
  });
  it("esports slug is never banned", () => {
    assert.ok(!isSoccerBannedSlug("lol-c9-fly-2026-02-15-draw"));
  });

  // --- Edge cases ---
  it("empty slug not banned", () => assert.ok(!isSoccerBannedSlug("")));
  it("null slug not banned", () => assert.ok(!isSoccerBannedSlug(null)));
  it("case insensitive ban", () => {
    assert.ok(isSoccerBannedSlug("EPL-WOL-ARS-2026-02-18-DRAW"));
  });

  // --- Real Polymarket slugs from data ---
  it("real: fl1-lyo-ogc-2026-02-15-lyo → allowed", () => {
    assert.ok(!isSoccerBannedSlug("fl1-lyo-ogc-2026-02-15-lyo"));
  });
  it("real: fl1-lyo-ogc-2026-02-15-draw → banned", () => {
    assert.ok(isSoccerBannedSlug("fl1-lyo-ogc-2026-02-15-draw"));
  });
  it("real: por-spo-fam-2026-02-15-total-1pt5 → banned", () => {
    assert.ok(isSoccerBannedSlug("por-spo-fam-2026-02-15-total-1pt5"));
  });
  it("real: por-spo-fam-2026-02-15-spread-home-1pt5 → banned", () => {
    assert.ok(isSoccerBannedSlug("por-spo-fam-2026-02-15-spread-home-1pt5"));
  });
  it("real: por-spo-fam-2026-02-15-btts → banned", () => {
    assert.ok(isSoccerBannedSlug("por-spo-fam-2026-02-15-btts"));
  });
  it("real: mex-caz-tig-2026-02-15-total-2pt5 → banned", () => {
    assert.ok(isSoccerBannedSlug("mex-caz-tig-2026-02-15-total-2pt5"));
  });
  it("real: lal-gir-bar-2026-02-16-spread-away-1pt5 → banned", () => {
    assert.ok(isSoccerBannedSlug("lal-gir-bar-2026-02-16-spread-away-1pt5"));
  });
});

// ─── Integration: soccer filter removes banned from event ────

describe("soccer market selection integration", () => {
  // Simulate what pickMarketsForEvent does for soccer
  function filterSoccerMarkets(slugs) {
    return slugs.filter(slug =>
      (isSoccerSlug(slug) && !isSoccerBannedSlug(slug)) ||
      (!isSoccerSlug(slug) && !isSpreadOrTotalSlug(slug))
    );
  }

  it("real Olympique Lyonnais event: keeps 2 team markets, bans 5", () => {
    const slugs = [
      "fl1-lyo-ogc-2026-02-15-lyo",       // team A ✓
      "fl1-lyo-ogc-2026-02-15-draw",       // draw ✗
      "fl1-lyo-ogc-2026-02-15-ogc",        // team B ✓
      "fl1-lyo-ogc-2026-02-15-total-4pt5", // total ✗
      "fl1-lyo-ogc-2026-02-15-btts",       // btts ✗
      "fl1-lyo-ogc-2026-02-15-total-2pt5", // total ✗
      "fl1-lyo-ogc-2026-02-15-total-3pt5", // total ✗
    ];
    const kept = filterSoccerMarkets(slugs);
    assert.deepEqual(kept, [
      "fl1-lyo-ogc-2026-02-15-lyo",
      "fl1-lyo-ogc-2026-02-15-ogc",
    ]);
  });

  it("real Sporting CP event: keeps 2 team, bans 8", () => {
    const slugs = [
      "por-spo-fam-2026-02-15-spo",
      "por-spo-fam-2026-02-15-draw",
      "por-spo-fam-2026-02-15-fam",
      "por-spo-fam-2026-02-15-total-1pt5",
      "por-spo-fam-2026-02-15-total-2pt5",
      "por-spo-fam-2026-02-15-total-3pt5",
      "por-spo-fam-2026-02-15-total-4pt5",
      "por-spo-fam-2026-02-15-btts",
      "por-spo-fam-2026-02-15-spread-home-1pt5",
      "por-spo-fam-2026-02-15-spread-away-1pt5",
    ];
    const kept = filterSoccerMarkets(slugs);
    assert.deepEqual(kept, [
      "por-spo-fam-2026-02-15-spo",
      "por-spo-fam-2026-02-15-fam",
    ]);
  });

  it("mixed event: keeps only non-banned", () => {
    const slugs = [
      "epl-wol-ars-2026-02-18-ars",
      "epl-wol-ars-2026-02-18-wol",
      "epl-wol-ars-2026-02-18-draw",
      "epl-wol-ars-2026-02-18-btts",
      "epl-wol-ars-2026-02-18-total-2pt5",
      "epl-wol-ars-2026-02-18-spread-away-1pt5",
    ];
    const kept = filterSoccerMarkets(slugs);
    assert.deepEqual(kept, [
      "epl-wol-ars-2026-02-18-ars",
      "epl-wol-ars-2026-02-18-wol",
    ]);
  });
});
