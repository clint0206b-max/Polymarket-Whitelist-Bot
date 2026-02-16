import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Simulates the stripEspnEvent function from loop_eval_http_only.mjs
// We duplicate the logic here to test it independently (the function is closure-scoped).
// If the strip logic changes, this test must be updated too.

function stripEspnEvent(ev) {
  if (!ev || typeof ev !== "object") return ev;
  const stripped = {
    id: ev.id,
    uid: ev.uid,
    date: ev.date,
    name: ev.name,
    shortName: ev.shortName,
    status: ev.status ? {
      clock: ev.status.clock,
      displayClock: ev.status.displayClock,
      period: ev.status.period,
      type: ev.status.type ? {
        id: ev.status.type.id,
        name: ev.status.type.name,
        state: ev.status.type.state,
        completed: ev.status.type.completed,
        description: ev.status.type.description,
      } : undefined,
    } : undefined,
  };
  const comp0 = ev.competitions?.[0];
  if (comp0) {
    const competitors = Array.isArray(comp0.competitors)
      ? comp0.competitors.map(c => ({
          homeAway: c.homeAway,
          score: c.score,
          winner: c.winner,
          team: c.team ? {
            id: c.team.id,
            name: c.team.name,
            shortDisplayName: c.team.shortDisplayName,
            displayName: c.team.displayName,
            abbreviation: c.team.abbreviation,
            location: c.team.location,
          } : undefined,
        }))
      : [];
    stripped.competitions = [{ competitors, startDate: comp0.startDate }];
  }
  return stripped;
}

// A realistic raw ESPN event with all the bloat fields
const RAW_ESPN_EVENT = {
  id: "401635123",
  uid: "s:40~l:41~e:401635123",
  date: "2026-02-15T23:00Z",
  name: "Team A at Team B",
  shortName: "TA @ TB",
  season: { year: 2026, type: 2, slug: "regular-season" },
  competitions: [{
    id: "401635123",
    uid: "s:40~l:41~e:401635123~c:401635123",
    date: "2026-02-15T23:00Z",
    startDate: "2026-02-15T23:00Z",
    attendance: 18000,
    type: { id: "1", abbreviation: "STD" },
    timeValid: true,
    neutralSite: false,
    conferenceCompetition: false,
    playByPlayAvailable: true,
    recent: true,
    venue: {
      id: "3456",
      fullName: "Big Arena",
      address: { city: "Somewhere", state: "NY" },
      capacity: 20000,
      indoor: true,
    },
    competitors: [
      {
        id: "100",
        uid: "s:40~l:41~t:100",
        type: "team",
        order: 1,
        homeAway: "home",
        winner: false,
        score: "78",
        linescores: [{ value: 40 }, { value: 38 }],
        statistics: [
          { name: "rebounds", displayValue: "35" },
          { name: "assists", displayValue: "22" },
          { name: "fieldGoalPct", displayValue: "45.2" },
        ],
        leaders: [
          { name: "pointsPerGame", leaders: [{ athlete: { fullName: "Player A" }, value: 28 }] },
        ],
        records: [{ summary: "20-5" }],
        team: {
          id: "100",
          uid: "s:40~l:41~t:100",
          location: "City A",
          name: "Wolves",
          abbreviation: "CIW",
          displayName: "City A Wolves",
          shortDisplayName: "Wolves",
          color: "003366",
          alternateColor: "ffffff",
          isActive: true,
          venue: { id: "3456" },
          links: [{ href: "https://espn.com/team/100" }],
          logo: "https://a.espncdn.com/logos/100.png",
        },
      },
      {
        id: "200",
        uid: "s:40~l:41~t:200",
        type: "team",
        order: 2,
        homeAway: "away",
        winner: false,
        score: "82",
        linescores: [{ value: 42 }, { value: 40 }],
        statistics: [
          { name: "rebounds", displayValue: "38" },
          { name: "assists", displayValue: "25" },
        ],
        leaders: [
          { name: "pointsPerGame", leaders: [{ athlete: { fullName: "Player B" }, value: 30 }] },
        ],
        records: [{ summary: "22-3" }],
        team: {
          id: "200",
          uid: "s:40~l:41~t:200",
          location: "City B",
          name: "Eagles",
          abbreviation: "CBE",
          displayName: "City B Eagles",
          shortDisplayName: "Eagles",
          color: "990000",
          alternateColor: "ffffff",
          isActive: true,
          venue: { id: "7890" },
          links: [{ href: "https://espn.com/team/200" }],
          logo: "https://a.espncdn.com/logos/200.png",
        },
      },
    ],
    odds: [{ provider: { name: "ESPN BET" }, details: "TB -3.5", overUnder: 160.5 }],
    broadcasts: [{ market: "national", names: ["ESPN"] }],
    headlines: [{ description: "Preview...", shortLinkText: "Game preview" }],
    situation: {
      lastPlay: { text: "Free throw made" },
      possession: "100",
    },
    format: { regulation: { periods: 2 } },
  }],
  links: [
    { href: "https://espn.com/game/401635123", text: "Gamecast" },
    { href: "https://espn.com/boxscore/401635123", text: "Box Score" },
  ],
  status: {
    clock: 120.0,
    displayClock: "2:00",
    period: 2,
    type: {
      id: "2",
      name: "STATUS_IN_PROGRESS",
      state: "in",
      completed: false,
      description: "In Progress",
      detail: "2:00 - 2nd Half",
      shortDetail: "2:00 - 2nd",
    },
  },
};

// Banned keys that should NOT survive stripping
const BANNED_TOP_KEYS = ["season", "links"];
const BANNED_COMP_KEYS = ["attendance", "venue", "odds", "broadcasts", "headlines", "situation", "format", "timeValid", "neutralSite", "conferenceCompetition", "playByPlayAvailable", "recent"];
const BANNED_COMPETITOR_KEYS = ["linescores", "statistics", "leaders", "records", "type", "order", "uid"];
const BANNED_TEAM_KEYS = ["uid", "color", "alternateColor", "isActive", "venue", "links", "logo"];

describe("ESPN cache strip — schema enforcement", () => {
  const stripped = stripEspnEvent(RAW_ESPN_EVENT);

  it("preserves required top-level fields", () => {
    assert.equal(stripped.id, "401635123");
    assert.equal(stripped.name, "Team A at Team B");
    assert.equal(stripped.shortName, "TA @ TB");
    assert.equal(stripped.date, "2026-02-15T23:00Z");
  });

  it("preserves status fields", () => {
    assert.equal(stripped.status.clock, 120.0);
    assert.equal(stripped.status.displayClock, "2:00");
    assert.equal(stripped.status.period, 2);
    assert.equal(stripped.status.type.name, "STATUS_IN_PROGRESS");
    assert.equal(stripped.status.type.state, "in");
  });

  it("preserves competitor score and homeAway", () => {
    const comps = stripped.competitions[0].competitors;
    assert.equal(comps.length, 2);
    assert.equal(comps[0].score, "78");
    assert.equal(comps[0].homeAway, "home");
    assert.equal(comps[1].score, "82");
    assert.equal(comps[1].homeAway, "away");
  });

  it("preserves team identity fields", () => {
    const t = stripped.competitions[0].competitors[0].team;
    assert.equal(t.id, "100");
    assert.equal(t.name, "Wolves");
    assert.equal(t.shortDisplayName, "Wolves");
    assert.equal(t.displayName, "City A Wolves");
    assert.equal(t.abbreviation, "CIW");
    assert.equal(t.location, "City A");
  });

  it("preserves startDate on competition", () => {
    assert.equal(stripped.competitions[0].startDate, "2026-02-15T23:00Z");
  });

  // --- BANNED FIELDS ---
  it("strips banned top-level keys", () => {
    for (const k of BANNED_TOP_KEYS) {
      assert.equal(stripped[k], undefined, `top-level '${k}' should be stripped`);
    }
  });

  it("strips banned competition keys", () => {
    const comp = stripped.competitions[0];
    for (const k of BANNED_COMP_KEYS) {
      assert.equal(comp[k], undefined, `competition '${k}' should be stripped`);
    }
  });

  it("strips banned competitor keys", () => {
    for (const c of stripped.competitions[0].competitors) {
      for (const k of BANNED_COMPETITOR_KEYS) {
        assert.equal(c[k], undefined, `competitor '${k}' should be stripped`);
      }
    }
  });

  it("strips banned team keys", () => {
    for (const c of stripped.competitions[0].competitors) {
      for (const k of BANNED_TEAM_KEYS) {
        assert.equal(c.team[k], undefined, `team '${k}' should be stripped`);
      }
    }
  });

  // --- SIZE ---
  it("stripped event is < 2KB", () => {
    const size = JSON.stringify(stripped).length;
    assert.ok(size < 2048, `stripped event is ${size} bytes, expected < 2048`);
  });

  it("raw event is > 2KB (confirms test has bloat to strip)", () => {
    const rawSize = JSON.stringify(RAW_ESPN_EVENT).length;
    assert.ok(rawSize > 2000, `raw event is ${rawSize} bytes, expected > 2KB`);
  });

  it("strip ratio is > 60%", () => {
    const rawSize = JSON.stringify(RAW_ESPN_EVENT).length;
    const strippedSize = JSON.stringify(stripped).length;
    const ratio = 1 - (strippedSize / rawSize);
    assert.ok(ratio > 0.6, `strip ratio is ${(ratio * 100).toFixed(1)}%, expected > 60%`);
  });

  // --- EDGE CASES ---
  it("handles null/undefined gracefully", () => {
    assert.equal(stripEspnEvent(null), null);
    assert.equal(stripEspnEvent(undefined), undefined);
  });

  it("handles event with no competitions", () => {
    const ev = { id: "1", name: "Test", status: { period: 1 } };
    const s = stripEspnEvent(ev);
    assert.equal(s.id, "1");
    assert.equal(s.competitions, undefined);
  });

  it("handles event with empty competitors", () => {
    const ev = { id: "2", competitions: [{ competitors: [] }] };
    const s = stripEspnEvent(ev);
    assert.equal(s.competitions[0].competitors.length, 0);
  });
});
