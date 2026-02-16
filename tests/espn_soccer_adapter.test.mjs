import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTeamName,
  teamMatchScore,
  buildSoccerIndex,
  matchMarketToGame,
  deriveSoccerContext,
  trackScoreChange,
  resetScoreHistory,
} from "../src/context/espn_soccer_scoreboard.mjs";

// ─── normalizeTeamName ───────────────────────────────────────

describe("normalizeTeamName", () => {
  it("lowercases", () => assert.equal(normalizeTeamName("Arsenal"), "arsenal"));
  it("strips FC", () => assert.equal(normalizeTeamName("Arsenal FC"), "arsenal"));
  it("strips CF", () => assert.equal(normalizeTeamName("Getafe CF"), "getafe"));
  it("strips SSC", () => assert.equal(normalizeTeamName("SSC Napoli"), "napoli"));
  it("strips RCD", () => assert.equal(normalizeTeamName("RCD Mallorca"), "mallorca"));
  it("strips AC", () => assert.equal(normalizeTeamName("AC Milan"), "milan"));
  it("strips CA", () => assert.equal(normalizeTeamName("CA Boca Juniors"), "boca juniors"));
  it("strips Club + Deportivo from longer name", () => assert.equal(normalizeTeamName("Club Deportivo Guadalajara"), "guadalajara"));
  it("strips Real", () => assert.equal(normalizeTeamName("Real Madrid"), "madrid"));
  it("strips multiple tokens from longer name", () => assert.equal(normalizeTeamName("Real Club Deportivo Espanyol"), "espanyol"));
  it("removes accents and applies alias", () => assert.equal(normalizeTeamName("Atlético Madrid"), "atletico madrid"));
  it("removes dots", () => assert.equal(normalizeTeamName("A.C. Milan"), "milan"));
  it("handles empty", () => assert.equal(normalizeTeamName(""), ""));
  it("handles null", () => assert.equal(normalizeTeamName(null), ""));

  // Aliases
  it("alias: Wolves → wolverhampton", () => assert.equal(normalizeTeamName("Wolves"), "wolverhampton"));
  it("alias: Spurs → tottenham", () => assert.equal(normalizeTeamName("Spurs"), "tottenham"));
  it("alias: Man Utd → manchester united", () => assert.equal(normalizeTeamName("Man Utd"), "manchester united"));
  it("alias: Man City → manchester city", () => assert.equal(normalizeTeamName("Man City"), "manchester city"));
  it("alias: Barca → barcelona", () => assert.equal(normalizeTeamName("Barca"), "barcelona"));
  it("alias: Barça → barcelona", () => assert.equal(normalizeTeamName("Barça"), "barcelona"));
  it("alias: PSG → paris saint germain", () => assert.equal(normalizeTeamName("PSG"), "paris saint germain"));
  it("alias: Bayern → bayern munich", () => assert.equal(normalizeTeamName("Bayern"), "bayern munich"));
  it("alias: Juve → juventus", () => assert.equal(normalizeTeamName("Juve"), "juventus"));
  it("alias: BVB → borussia dortmund", () => assert.equal(normalizeTeamName("BVB"), "borussia dortmund"));
  it("alias: Inter → internazionale", () => assert.equal(normalizeTeamName("Inter"), "internazionale"));
  it("alias: Boca → boca juniors", () => assert.equal(normalizeTeamName("Boca"), "boca juniors"));
});

// ─── teamMatchScore ──────────────────────────────────────────

describe("teamMatchScore", () => {
  it("exact match → 1.0", () => {
    assert.equal(teamMatchScore("Arsenal", "Arsenal"), 1.0);
  });

  it("same after normalization → 1.0", () => {
    assert.equal(teamMatchScore("Arsenal FC", "Arsenal"), 1.0);
  });

  it("contains match → 0.85", () => {
    const s = teamMatchScore("Wolverhampton Wanderers", "Wolverhampton");
    assert.equal(s, 0.85);
  });

  it("no match → 0", () => {
    assert.equal(teamMatchScore("Arsenal", "Barcelona"), 0);
  });

  it("empty vs something → 0", () => {
    assert.equal(teamMatchScore("", "Arsenal"), 0);
  });

  it("both empty → 0", () => {
    assert.equal(teamMatchScore("", ""), 0);
  });

  it("alias: Wolves matches Wolverhampton Wanderers", () => {
    const s = teamMatchScore("Wolves", "Wolverhampton Wanderers");
    assert.ok(s >= 0.85, `expected >= 0.85, got ${s}`);
  });

  it("partial word overlap → positive score", () => {
    const s = teamMatchScore("Manchester United", "Manchester City");
    assert.ok(s > 0 && s < 0.85, `expected partial, got ${s}`);
  });

  it("SSC Napoli vs Napoli → exact after normalization", () => {
    assert.equal(teamMatchScore("SSC Napoli", "Napoli"), 1.0);
  });

  it("Real Betis Balompié vs Real Betis → contains match", () => {
    const s = teamMatchScore("Real Betis Balompié", "Real Betis");
    assert.ok(s >= 0.60, `expected >= 0.60, got ${s}`);
  });
});

// ─── matchMarketToGame ───────────────────────────────────────

describe("matchMarketToGame", () => {
  const mkGame = (id, homeName, awayName, state, period, clockMin, conf) => ({
    gameId: id,
    leagueId: "eng.1",
    name: `${awayName} at ${homeName}`,
    home: { name: homeName, shortName: homeName.substring(0, 3), score: 2, homeAway: "home" },
    away: { name: awayName, shortName: awayName.substring(0, 3), score: 0, homeAway: "away" },
    state,
    statusName: "STATUS_IN_PROGRESS",
    period,
    clockMinutes: clockMin,
    displayClock: `${clockMin}'`,
    minutesLeft: state === "in" && period === 2 ? Math.max(0, 90 - clockMin) : null,
    minutesLeftConfidence: conf || "high",
    startDate: "2026-02-18T20:00:00Z",
  });

  const wolves = mkGame("1001", "Wolverhampton Wanderers", "Arsenal", "in", 2, 82, "high");
  const chelsea = mkGame("1002", "Chelsea", "Manchester United", "in", 2, 75, "high");

  it("exact match → matched + high confidence", () => {
    const r = matchMarketToGame(
      { slug: "epl-wol-ars-2026-02-18-ars", title: "Wolverhampton Wanderers FC vs. Arsenal FC", endDateIso: "2026-02-18T20:00:00Z" },
      [wolves, chelsea]
    );
    assert.ok(r.matched);
    assert.equal(r.confidence, "high");
    assert.equal(r.game.gameId, "1001");
  });

  it("two candidates → fail closed (multiple_candidates)", () => {
    // Create two games with similar names
    const wolves2 = mkGame("1003", "Wolverhampton Wanderers Reserves", "Arsenal U23", "in", 2, 80, "high");
    const r = matchMarketToGame(
      { slug: "epl-wol-ars-2026-02-18-ars", title: "Wolverhampton Wanderers vs. Arsenal", endDateIso: "2026-02-18T20:00:00Z" },
      [wolves, wolves2]
    );
    assert.equal(r.matched, false);
    assert.ok(r.reasons.includes("multiple_candidates"));
  });

  it("no games → no match", () => {
    const r = matchMarketToGame(
      { slug: "epl-wol-ars-2026-02-18-ars", title: "Wolverhampton vs Arsenal" },
      []
    );
    assert.equal(r.matched, false);
    assert.ok(r.reasons.includes("no_input"));
  });

  it("no team match → fail closed", () => {
    const r = matchMarketToGame(
      { slug: "epl-bri-sou-2026-02-18-bri", title: "Brighton vs Southampton" },
      [wolves, chelsea]
    );
    assert.equal(r.matched, false);
    assert.ok(r.reasons.includes("no_team_match"));
  });

  it("time mismatch (>6h) → fail closed", () => {
    const r = matchMarketToGame(
      { slug: "epl-wol-ars-2026-02-18-ars", title: "Wolverhampton Wanderers vs. Arsenal", endDateIso: "2026-02-25T20:00:00Z" },
      [wolves]
    );
    assert.equal(r.matched, false);
    assert.ok(r.reasons.includes("time_mismatch"));
  });

  it("can't parse teams from title → fail closed", () => {
    const r = matchMarketToGame(
      { slug: "epl-wol-ars-2026-02-18-ars", title: "Some random title" },
      [wolves]
    );
    assert.equal(r.matched, false);
    assert.ok(r.reasons.includes("cant_parse_teams_from_title"));
  });

  it("low clock confidence → matched but low confidence", () => {
    const wolvesLow = { ...wolves, minutesLeftConfidence: "low" };
    const r = matchMarketToGame(
      { slug: "epl-wol-ars-2026-02-18-ars", title: "Wolverhampton Wanderers vs. Arsenal", endDateIso: "2026-02-18T20:00:00Z" },
      [wolvesLow]
    );
    assert.ok(r.matched);
    assert.equal(r.confidence, "low");
    assert.ok(r.reasons.includes("clock_not_reliable"));
  });

  it("alias matching: Wolves vs Arsenal → matches", () => {
    const r = matchMarketToGame(
      { slug: "epl-wol-ars-2026-02-18-ars", title: "Wolves vs. Arsenal", endDateIso: "2026-02-18T20:00:00Z" },
      [wolves]
    );
    assert.ok(r.matched);
    assert.equal(r.game.gameId, "1001");
  });

  it("SSC Napoli vs AS Roma → matches Napoli vs Roma", () => {
    const napoli = { ...mkGame("2001", "Napoli", "Roma", "in", 2, 85, "high"), startDate: "2026-02-15T19:45:00Z" };
    const r = matchMarketToGame(
      { slug: "sea-nap-rom-2026-02-15-nap", title: "SSC Napoli vs. AS Roma", endDateIso: "2026-02-15T19:45:00Z" },
      [napoli]
    );
    assert.ok(r.matched, `reasons: ${r.reasons}`);
    assert.equal(r.confidence, "high");
  });
});

// ─── trackScoreChange ────────────────────────────────────────

describe("trackScoreChange", () => {
  beforeEach(() => resetScoreHistory());

  it("first observation → null (unknown)", () => {
    const r = trackScoreChange("g1", 1, 0, 1000000);
    assert.equal(r, null);
  });

  it("same score → null (never changed)", () => {
    trackScoreChange("g1", 1, 0, 1000000);
    const r = trackScoreChange("g1", 1, 0, 1001000);
    assert.equal(r, null);
  });

  it("score changes → 0 (just changed)", () => {
    trackScoreChange("g1", 1, 0, 1000000);
    const r = trackScoreChange("g1", 2, 0, 1001000);
    assert.equal(r, 0);
  });

  it("after change, stable → returns seconds since change", () => {
    trackScoreChange("g1", 1, 0, 1000000);
    trackScoreChange("g1", 2, 0, 1060000); // change at t=60s
    const r = trackScoreChange("g1", 2, 0, 1120000); // 60s later
    assert.equal(r, 60);
  });

  it("second change resets timer", () => {
    trackScoreChange("g1", 1, 0, 1000000);
    trackScoreChange("g1", 2, 0, 1060000); // change 1
    trackScoreChange("g1", 2, 0, 1120000); // stable
    trackScoreChange("g1", 3, 0, 1150000); // change 2
    const r = trackScoreChange("g1", 3, 0, 1200000); // 50s after change 2
    assert.equal(r, 50);
  });

  it("independent games don't interfere", () => {
    trackScoreChange("g1", 1, 0, 1000000);
    trackScoreChange("g2", 0, 0, 1000000);
    trackScoreChange("g1", 2, 0, 1060000); // g1 changes
    const r1 = trackScoreChange("g1", 2, 0, 1120000);
    const r2 = trackScoreChange("g2", 0, 0, 1120000);
    assert.equal(r1, 60); // g1: 60s since change
    assert.equal(r2, null); // g2: never changed
  });
});

// ─── deriveSoccerContext ─────────────────────────────────────

describe("deriveSoccerContext", () => {
  beforeEach(() => resetScoreHistory());

  const mkMatch = (game) => ({ matched: true, confidence: "high", reasons: [], game });
  const mkGame = (homeScore, awayScore, state, period, minLeft) => ({
    gameId: "g1",
    home: { name: "Arsenal", score: homeScore },
    away: { name: "Chelsea", score: awayScore },
    state,
    period,
    minutesLeft: minLeft,
    minutesLeftConfidence: "high",
    displayClock: `${90 - (minLeft || 0)}'`,
  });

  it("unmatched → unknown state", () => {
    const ctx = deriveSoccerContext({}, { matched: false, game: null }, 1000000);
    assert.equal(ctx.state, "unknown");
    assert.equal(ctx.confidence, "low");
  });

  it("matched in-game → full context", () => {
    const game = mkGame(2, 0, "in", 2, 8);
    const match = mkMatch(game);
    const ctx = deriveSoccerContext(
      { entry_outcome_name: "Arsenal" },
      match,
      1000000,
    );
    assert.equal(ctx.state, "in");
    assert.equal(ctx.period, 2);
    assert.equal(ctx.minutes_left, 8);
    assert.equal(ctx.confidence, "high");
    assert.equal(ctx.margin_for_yes, 2); // Arsenal is home, winning 2-0
    assert.equal(ctx.yes_team_side, "home");
  });

  it("yes team is away → margin computed correctly", () => {
    const game = mkGame(0, 3, "in", 2, 5);
    const match = mkMatch(game);
    const ctx = deriveSoccerContext(
      { entry_outcome_name: "Chelsea" },
      match,
      1000000,
    );
    assert.equal(ctx.margin_for_yes, 3); // Chelsea away, winning 3-0
    assert.equal(ctx.yes_team_side, "away");
  });

  it("yes team losing → negative margin", () => {
    const game = mkGame(0, 2, "in", 2, 10);
    const match = mkMatch(game);
    const ctx = deriveSoccerContext(
      { entry_outcome_name: "Arsenal" },
      match,
      1000000,
    );
    assert.equal(ctx.margin_for_yes, -2); // Arsenal home, losing 0-2
  });

  it("score change → lastScoreChangeAgoSec tracked", () => {
    const game = mkGame(1, 0, "in", 2, 15);
    const match = mkMatch(game);

    // First call: unknown
    deriveSoccerContext({ entry_outcome_name: "Arsenal" }, match, 1000000);

    // Change score
    const game2 = { ...game, home: { ...game.home, score: 2 } };
    const match2 = mkMatch(game2);
    deriveSoccerContext({ entry_outcome_name: "Arsenal" }, match2, 1060000);

    // Check after 30s
    const ctx = deriveSoccerContext({ entry_outcome_name: "Arsenal" }, match2, 1090000);
    assert.equal(ctx.lastScoreChangeAgoSec, 30);
  });
});

// ─── End-to-end: adapter → gate integration ──────────────────

describe("adapter → gate integration", () => {
  beforeEach(() => resetScoreHistory());

  it("margin=2, 8min left, confidence high → gate would allow", async () => {
    // This tests that the adapter output format is compatible with checkSoccerEntryGate
    const { checkSoccerEntryGate } = await import("../src/strategy/win_prob_table.mjs");

    const ctx = {
      period: 2,
      minutesLeft: 8,
      marginForYes: 2,
      confidence: "high",
      lastScoreChangeAgoSec: 120,
    };

    const r = checkSoccerEntryGate(ctx);
    assert.equal(r.allowed, true);
    assert.ok(r.win_prob > 0.97);
  });

  it("adapter low confidence → gate blocks", async () => {
    const { checkSoccerEntryGate } = await import("../src/strategy/win_prob_table.mjs");

    const ctx = {
      period: 2,
      minutesLeft: 8,
      marginForYes: 2,
      confidence: "low",
      lastScoreChangeAgoSec: 120,
    };

    const r = checkSoccerEntryGate(ctx);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "low_confidence");
  });

  it("recent score change → gate blocks with cooldown", async () => {
    const { checkSoccerEntryGate } = await import("../src/strategy/win_prob_table.mjs");

    const ctx = {
      period: 2,
      minutesLeft: 8,
      marginForYes: 2,
      confidence: "high",
      lastScoreChangeAgoSec: 30, // < 90s cooldown
    };

    const r = checkSoccerEntryGate(ctx);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "score_change_cooldown");
  });
});
