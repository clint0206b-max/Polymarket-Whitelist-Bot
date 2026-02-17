import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTeamName, teamMatchScore, resolveYesTeamFromSlug } from "../src/context/espn_soccer_scoreboard.mjs";

describe("normalizeTeamName strips club prefixes/suffixes and founding years", () => {
  it("BV Borussia 09 Dortmund → borussia dortmund", () => {
    assert.equal(normalizeTeamName("BV Borussia 09 Dortmund"), "borussia dortmund");
  });
  it("Atalanta BC → atalanta", () => {
    assert.equal(normalizeTeamName("Atalanta BC"), "atalanta");
  });
  it("TSV 1860 München → munchen", () => {
    assert.equal(normalizeTeamName("TSV 1860 München"), "munchen");
  });
  it("VfB Stuttgart → stuttgart", () => {
    assert.equal(normalizeTeamName("VfB Stuttgart"), "stuttgart");
  });
  it("FK Bodø/Glimt → strips FK, keeps ø (not a combining accent)", () => {
    assert.equal(normalizeTeamName("FK Bodø/Glimt"), "bodø/glimt");
  });
  it("NK Maribor → maribor", () => {
    assert.equal(normalizeTeamName("NK Maribor"), "maribor");
  });
  it("plain name unchanged", () => {
    assert.equal(normalizeTeamName("Borussia Dortmund"), "borussia dortmund");
  });
  it("only stripped tokens → keep original", () => {
    // Edge: a name that IS all stripped tokens shouldn't return empty
    assert.ok(normalizeTeamName("FC 09").length > 0);
  });
});

describe("teamMatchScore: BVB and Atalanta edge cases", () => {
  it("BV Borussia 09 Dortmund ↔ Borussia Dortmund → 1.0", () => {
    assert.equal(teamMatchScore("BV Borussia 09 Dortmund", "Borussia Dortmund"), 1.0);
  });
  it("Atalanta BC ↔ Atalanta → 1.0", () => {
    assert.equal(teamMatchScore("Atalanta BC", "Atalanta"), 1.0);
  });
  it("BV Borussia 09 Dortmund ↔ Atalanta → 0 (no match)", () => {
    assert.equal(teamMatchScore("BV Borussia 09 Dortmund", "Atalanta"), 0);
  });
});

describe("SLUG_CODE_ALIASES: bvb and ata", () => {
  it("bvb1 resolves to home=Borussia Dortmund", () => {
    const r = resolveYesTeamFromSlug("bvb1", "Borussia Dortmund", "Atalanta");
    assert.equal(r.side, "home");
    assert.equal(r.via, "alias");
  });
  it("ata1 resolves to away=Atalanta", () => {
    const r = resolveYesTeamFromSlug("ata1", "Borussia Dortmund", "Atalanta");
    assert.equal(r.side, "away");
    assert.equal(r.via, "alias");
  });
});
