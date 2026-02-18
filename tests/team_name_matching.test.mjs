import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Replicate normTeam from loop_eval_http_only.mjs
function normTeam(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameMatch(yesN, teamN) {
  if (!yesN || !teamN) return false;
  return yesN === teamN || yesN.includes(teamN) || teamN.includes(yesN);
}

function resolveMargin(yesOutcomeName, teamA, teamB) {
  const yesNorm = normTeam(yesOutcomeName);
  const aNorm = normTeam(teamA.name);
  const bNorm = normTeam(teamB.name);
  const aFullNorm = teamA.fullName ? normTeam(teamA.fullName) : null;
  const bFullNorm = teamB.fullName ? normTeam(teamB.fullName) : null;

  let yesIsA = nameMatch(yesNorm, aNorm) || nameMatch(yesNorm, aFullNorm);
  let yesIsB = nameMatch(yesNorm, bNorm) || nameMatch(yesNorm, bFullNorm);

  if (yesIsA && !yesIsB) return teamA.score - teamB.score;
  if (yesIsB && !yesIsA) return teamB.score - teamA.score;
  return null; // ambiguous or no match
}

describe("team name matching for context entry gate", () => {
  it("matches ESPN shortDisplayName directly", () => {
    const margin = resolveMargin(
      "Purdue Boilermakers",
      { name: "Purdue", fullName: "Purdue Boilermakers", score: 60 },
      { name: "Michigan", fullName: "Michigan Wolverines", score: 50 }
    );
    assert.equal(margin, 10);
  });

  it("matches via fullName when shortDisplayName is abbreviated (E Michigan bug)", () => {
    const margin = resolveMargin(
      "Eastern Michigan Eagles",
      { name: "E Michigan", fullName: "Eastern Michigan Eagles", score: 44 },
      { name: "C Michigan", fullName: "Central Michigan Chippewas", score: 30 }
    );
    assert.equal(margin, 14);
  });

  it("matches via fullName for team B", () => {
    const margin = resolveMargin(
      "Central Michigan Chippewas",
      { name: "E Michigan", fullName: "Eastern Michigan Eagles", score: 44 },
      { name: "C Michigan", fullName: "Central Michigan Chippewas", score: 30 }
    );
    assert.equal(margin, -14); // Central Michigan is behind
  });

  it("returns null when no match at all", () => {
    const margin = resolveMargin(
      "Duke Blue Devils",
      { name: "E Michigan", fullName: "Eastern Michigan Eagles", score: 44 },
      { name: "C Michigan", fullName: "Central Michigan Chippewas", score: 30 }
    );
    assert.equal(margin, null);
  });

  it("returns null when ambiguous (both match)", () => {
    // Contrived: both team names are substrings of the outcome
    const margin = resolveMargin(
      "Michigan Wolverines Michigan State",
      { name: "Michigan", fullName: "Michigan Wolverines", score: 60 },
      { name: "Michigan St", fullName: "Michigan State Spartans", score: 55 }
    );
    assert.equal(margin, null);
  });

  it("works without fullName (backward compat)", () => {
    const margin = resolveMargin(
      "Purdue Boilermakers",
      { name: "Purdue", score: 60 },
      { name: "Michigan", score: 50 }
    );
    assert.equal(margin, 10);
  });

  it("handles NBA team names (shortDisplayName usually enough)", () => {
    const margin = resolveMargin(
      "Los Angeles Lakers",
      { name: "Lakers", fullName: "Los Angeles Lakers", score: 105 },
      { name: "Celtics", fullName: "Boston Celtics", score: 100 }
    );
    assert.equal(margin, 5);
  });

  it("handles W Michigan vs E Michigan correctly (no cross-match)", () => {
    // "W Michigan" should NOT match "Eastern Michigan Eagles"
    const margin = resolveMargin(
      "Western Michigan Broncos",
      { name: "E Michigan", fullName: "Eastern Michigan Eagles", score: 44 },
      { name: "W Michigan", fullName: "Western Michigan Broncos", score: 30 }
    );
    assert.equal(margin, -14); // W Michigan (team B) is behind
  });
});
