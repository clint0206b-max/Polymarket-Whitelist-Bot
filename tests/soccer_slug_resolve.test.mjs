import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSlugTeamSuffix, resolveYesTeamFromSlug } from "../src/context/espn_soccer_scoreboard.mjs";

describe("extractSlugTeamSuffix", () => {
  it("extracts team code after YYYY-MM-DD", () => {
    assert.equal(extractSlugTeamSuffix("ucl-ben-rma-2026-02-17-ben"), "ben");
  });

  it("extracts multi-char code with trailing digits", () => {
    assert.equal(extractSlugTeamSuffix("ucl-bvb1-ata1-2026-02-17-bvb1"), "bvb1");
  });

  it("extracts code from EPL slug", () => {
    assert.equal(extractSlugTeamSuffix("epl-ars-che-2026-03-01-ars"), "ars");
  });

  it("returns null for non-team suffix: draw", () => {
    assert.equal(extractSlugTeamSuffix("epl-ars-che-2026-03-01-draw"), null);
  });

  it("returns null for non-team suffix: total-2pt5", () => {
    assert.equal(extractSlugTeamSuffix("lal-gir-bar-2026-02-16-total-2pt5"), null);
  });

  it("returns null for non-team suffix: spread-home-1pt5", () => {
    assert.equal(extractSlugTeamSuffix("por-spo-fam-2026-02-15-spread-home-1pt5"), null);
  });

  it("returns null for non-team suffix: btts", () => {
    assert.equal(extractSlugTeamSuffix("por-spo-fam-2026-02-15-btts"), null);
  });

  it("returns null for non-team suffix: over-2pt5", () => {
    assert.equal(extractSlugTeamSuffix("epl-ars-che-2026-03-01-over-2pt5"), null);
  });

  it("returns null for non-team suffix: under-3pt5", () => {
    assert.equal(extractSlugTeamSuffix("epl-ars-che-2026-03-01-under-3pt5"), null);
  });

  it("returns null when no date pattern found", () => {
    assert.equal(extractSlugTeamSuffix("some-random-slug"), null);
  });

  it("returns null when nothing after date", () => {
    assert.equal(extractSlugTeamSuffix("ucl-ben-rma-2026-02-17"), null);
  });

  it("returns null for empty/null input", () => {
    assert.equal(extractSlugTeamSuffix(""), null);
    assert.equal(extractSlugTeamSuffix(null), null);
    assert.equal(extractSlugTeamSuffix(undefined), null);
  });

  it("handles compound suffix codes (multi-segment team code)", () => {
    // If team code happens to have dashes but no banned word
    assert.equal(extractSlugTeamSuffix("ucl-xyz-abc-2026-01-15-fc-porto"), "fc-porto");
  });
});

describe("resolveYesTeamFromSlug", () => {
  // --- Real Polymarket slugs ---
  it("ben → Benfica (home) via fuzzy", () => {
    const r = resolveYesTeamFromSlug("ben", "Benfica", "Real Madrid");
    assert.equal(r.side, "home");
    assert.equal(r.name, "Benfica");
    assert.ok(r.score > 0.5);
  });

  it("rma → Real Madrid (away) via alias", () => {
    const r = resolveYesTeamFromSlug("rma", "Benfica", "Real Madrid");
    assert.equal(r.side, "away");
    assert.equal(r.name, "Real Madrid");
    assert.equal(r.via, "alias");
  });

  it("asm1 → AS Monaco (home) via fuzzy (strips trailing digits)", () => {
    const r = resolveYesTeamFromSlug("asm1", "AS Monaco", "Paris Saint-Germain");
    assert.equal(r.side, "home");
    assert.equal(r.name, "AS Monaco");
  });

  it("psg → Paris Saint-Germain (away) via alias", () => {
    const r = resolveYesTeamFromSlug("psg", "AS Monaco", "Paris Saint-Germain");
    assert.equal(r.side, "away");
    assert.equal(r.name, "Paris Saint-Germain");
  });

  it("bvb1 → Borussia Dortmund (home) via fuzzy", () => {
    const r = resolveYesTeamFromSlug("bvb1", "Borussia Dortmund", "Atalanta");
    assert.equal(r.side, "home");
    assert.equal(r.name, "Borussia Dortmund");
  });

  it("ata1 → Atalanta (away) via fuzzy", () => {
    const r = resolveYesTeamFromSlug("ata1", "Borussia Dortmund", "Atalanta");
    assert.equal(r.side, "away");
    assert.equal(r.name, "Atalanta");
  });

  // --- English lower leagues ---
  it("cha → Charlton Athletic (home)", () => {
    const r = resolveYesTeamFromSlug("cha", "Charlton Athletic", "Port Vale");
    assert.equal(r.side, "home");
  });

  it("por → Port Vale (away), not confused with Portugal-related names", () => {
    const r = resolveYesTeamFromSlug("por", "Charlton Athletic", "Port Vale");
    assert.equal(r.side, "away");
  });

  it("wre → Wrexham (away)", () => {
    const r = resolveYesTeamFromSlug("wre", "Brighton & Hove Albion", "Wrexham");
    assert.equal(r.side, "away");
  });

  // --- Alias-dependent codes ---
  it("fcb → Barcelona via alias", () => {
    const r = resolveYesTeamFromSlug("fcb", "Barcelona", "Real Betis");
    assert.equal(r.side, "home");
    assert.equal(r.via, "alias");
  });

  it("atm → Atletico Madrid via alias", () => {
    const r = resolveYesTeamFromSlug("atm", "Atletico Madrid", "Sevilla");
    assert.equal(r.side, "home");
    assert.equal(r.via, "alias");
  });

  it("liv → Liverpool via alias", () => {
    const r = resolveYesTeamFromSlug("liv", "Manchester City", "Liverpool");
    assert.equal(r.side, "away");
    assert.equal(r.via, "alias");
  });

  it("mci → Manchester City via alias", () => {
    const r = resolveYesTeamFromSlug("mci", "Manchester City", "Liverpool");
    assert.equal(r.side, "home");
    assert.equal(r.via, "alias");
  });

  it("tot → Tottenham via alias", () => {
    const r = resolveYesTeamFromSlug("tot", "Tottenham Hotspur", "Arsenal");
    assert.equal(r.side, "home");
    assert.equal(r.via, "alias");
  });

  // --- Fail-closed cases ---
  it("returns null for empty suffix", () => {
    assert.equal(resolveYesTeamFromSlug("", "Benfica", "Real Madrid"), null);
  });

  it("returns null for null suffix", () => {
    assert.equal(resolveYesTeamFromSlug(null, "Benfica", "Real Madrid"), null);
  });

  it("returns null for null team names", () => {
    assert.equal(resolveYesTeamFromSlug("ben", null, "Real Madrid"), null);
    assert.equal(resolveYesTeamFromSlug("ben", "Benfica", null), null);
  });

  it("returns null for suffix that matches neither team", () => {
    const r = resolveYesTeamFromSlug("xyz", "Benfica", "Real Madrid");
    assert.equal(r, null);
  });

  it("returns null for suffix matching both teams equally", () => {
    // Both teams contain 'real' — ambiguous
    const r = resolveYesTeamFromSlug("rea", "Real Sociedad", "Real Betis");
    // Should return null because both are equally matched
    // (or one slightly better — but scores should be equal given normalizeTeamName strips "Real")
    // After normalization: "sociedad" vs "betis", and "rea" matches neither.
    assert.equal(r, null);
  });

  it("returns null when suffix is only digits (stripped to empty)", () => {
    assert.equal(resolveYesTeamFromSlug("123", "Benfica", "Real Madrid"), null);
  });

  // --- Edge: code that's just a number suffix stripped entirely ---
  it("handles code that is entirely digits", () => {
    assert.equal(resolveYesTeamFromSlug("1", "Arsenal", "Chelsea"), null);
  });
});
