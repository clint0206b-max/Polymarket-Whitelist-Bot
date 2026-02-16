// ESPN Soccer Scoreboard Adapter
// Fail-closed: if confidence !== "high", no trade is allowed.
//
// Supports: Premier League, La Liga, Serie A, Ligue 1, Bundesliga,
//           Champions League, Europa League, Liga MX, Argentina,
//           Eredivisie, Portugal

// ─── League mapping ──────────────────────────────────────────

const ESPN_LEAGUES = {
  "eng.1":           { name: "Premier League",       slugPrefix: "epl" },
  "esp.1":           { name: "La Liga",              slugPrefix: "lal" },
  "ita.1":           { name: "Serie A",              slugPrefix: "sea" },
  "fra.1":           { name: "Ligue 1",              slugPrefix: "fl1" },
  "ger.1":           { name: "Bundesliga",           slugPrefix: "bun" },
  "uefa.champions":  { name: "Champions League",     slugPrefix: "ucl" },
  "uefa.europa":     { name: "Europa League",        slugPrefix: "uel" },
  "mex.1":           { name: "Liga MX",              slugPrefix: "mex" },
  "arg.1":           { name: "Liga Argentina",       slugPrefix: "arg" },
  "ned.1":           { name: "Eredivisie",           slugPrefix: "ere" },
  "por.1":           { name: "Liga Portugal",        slugPrefix: "por" },
};

export const ESPN_LEAGUE_IDS = Object.keys(ESPN_LEAGUES);
export const SLUG_PREFIX_TO_LEAGUE = Object.fromEntries(
  Object.entries(ESPN_LEAGUES).map(([id, v]) => [v.slugPrefix, id])
);

// ─── Team name normalization ─────────────────────────────────

const STRIP_TOKENS = [
  "fc", "cf", "sc", "cd", "ac", "ssc", "afc", "rc", "rcd", "ca",
  "club", "deportivo", "athletic", "atletico", "atlético",
  "real", "sporting", "olympique", "olympique lyonnais",
  "de", "la", "el", "los", "las", "le", "du", "des", "von", "van",
  "e", "y",
];

const TEAM_ALIASES = {
  "wolves": "wolverhampton",
  "spurs": "tottenham",
  "inter": "internazionale",
  "inter milan": "internazionale",
  "man utd": "manchester united",
  "man united": "manchester united",
  "man city": "manchester city",
  "atleti": "atletico madrid",
  "atletico": "atletico madrid",
  "atletico madrid": "atletico madrid",
  "atlético": "atletico madrid",
  "atletico de madrid": "atletico madrid",
  "barca": "barcelona",
  "barça": "barcelona",
  "psg": "paris saint germain",
  "bayern": "bayern munich",
  "bayern münchen": "bayern munich",
  "dortmund": "borussia dortmund",
  "bvb": "borussia dortmund",
  "juve": "juventus",
  "lyon": "lyonnais",
  "napoli": "napoli",
  "roma": "roma",
  "lazio": "lazio",
  "benfica": "benfica",
  "porto": "porto",
  "river": "river plate",
  "boca": "boca juniors",
};

export function normalizeTeamName(raw) {
  if (!raw) return "";
  let name = String(raw).toLowerCase().trim();

  // Remove accents
  name = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Remove punctuation (dots, hyphens at boundaries)
  name = name.replace(/[.']/g, "").replace(/-/g, " ");

  // Collapse whitespace
  name = name.replace(/\s+/g, " ").trim();

  // Check aliases BEFORE stripping (so "Man Utd" → "manchester united", "Atletico Madrid" → "atletico madrid")
  const aliased = TEAM_ALIASES[name];
  if (aliased) return aliased;

  // Strip common tokens
  const words = name.split(/\s+/).filter(w => w.length > 0);
  const filtered = words.filter(w => !STRIP_TOKENS.includes(w));

  // If stripping removed everything, keep original words
  const result = (filtered.length > 0 ? filtered : words).join(" ");

  // Check aliases AFTER stripping too (catch edge cases)
  const aliasedPost = TEAM_ALIASES[result];
  if (aliasedPost) return aliasedPost;

  return result;
}

// ─── Team matching ───────────────────────────────────────────

/**
 * Score how well two team names match.
 * Returns a number between 0 (no match) and 1 (exact).
 */
export function teamMatchScore(nameA, nameB) {
  const a = normalizeTeamName(nameA);
  const b = normalizeTeamName(nameB);
  if (!a || !b) return 0;

  // Exact match
  if (a === b) return 1.0;

  // One contains the other (e.g., "wolverhampton wanderers" contains "wolverhampton")
  if (a.includes(b) || b.includes(a)) return 0.85;

  // Word overlap: Jaccard similarity on words
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccard = union > 0 ? intersection / union : 0;

  // Require at least 1 word overlap
  if (intersection === 0) return 0;

  return Math.min(jaccard, 0.80); // cap below includes-match
}

const MATCH_THRESHOLD = 0.60; // minimum score to consider a team match

// ─── Fetch scoreboard ────────────────────────────────────────

/**
 * Fetch ESPN scoreboard for a single league.
 * @param {string} leagueId - e.g. "eng.1"
 * @param {object} opts - { timeout_ms }
 * @returns {Array} - normalized game objects
 */
export async function fetchSoccerScoreboard(leagueId, opts = {}) {
  const timeout = Number(opts.timeout_ms || 2500);
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueId}/scoreboard`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return [];
    const data = await res.json();

    const games = [];
    for (const event of (data.events || [])) {
      const comp = event.competitions?.[0];
      if (!comp) continue;

      const status = comp.status || {};
      const type = status.type || {};

      // Extract teams
      const competitors = comp.competitors || [];
      const teams = competitors.map(c => ({
        name: c.team?.displayName || c.team?.name || "",
        shortName: c.team?.shortDisplayName || c.team?.abbreviation || "",
        score: Number(c.score || 0),
        homeAway: c.homeAway || "",
      }));

      const home = teams.find(t => t.homeAway === "home");
      const away = teams.find(t => t.homeAway === "away");

      // Clock: ESPN returns seconds
      const clockSeconds = Number(status.clock || 0);
      const clockMinutes = clockSeconds / 60;
      const period = Number(status.period || 0);
      const state = String(type.state || "").toLowerCase(); // "pre", "in", "post"
      const statusName = String(type.name || "");

      // Minutes left calculation (conservative)
      let minutesLeft = null;
      let minutesLeftConfidence = "low";

      if (state === "in" && period === 2) {
        // Second half: clock counts from 45:00 up
        // minutes_left = 90 - clockMinutes (clamped to >= 0)
        if (clockMinutes >= 45 && clockMinutes <= 90) {
          minutesLeft = Math.max(0, 90 - clockMinutes);
          minutesLeftConfidence = "high";
        } else if (clockMinutes > 90) {
          // Injury time: we know there's < ~5 min left but not exactly how much
          minutesLeft = 0;
          minutesLeftConfidence = "low"; // can't reliably know how much injury time remains
        }
      } else if (state === "in" && period === 1) {
        minutesLeft = Math.max(0, 90 - clockMinutes); // rough estimate, not used for entry
        minutesLeftConfidence = "low"; // first half = not eligible for entry anyway
      }

      games.push({
        gameId: String(event.id || ""),
        leagueId,
        name: event.name || "",
        home,
        away,
        state,
        statusName,
        period,
        clockMinutes,
        displayClock: status.displayClock || "",
        minutesLeft,
        minutesLeftConfidence,
        startDate: event.date || comp.date || null,
      });
    }

    return games;
  } catch (err) {
    return []; // fail closed: no data = no trades
  }
}

// ─── Score change tracking (runtime state) ───────────────────

// In-memory map: gameId → { homeScore, awayScore, lastChangeTs }
const _scoreHistory = new Map();

/**
 * Track score changes and return seconds since last change.
 * @param {string} gameId
 * @param {number} homeScore
 * @param {number} awayScore
 * @param {number} nowMs - current timestamp
 * @returns {number|null} - seconds since last score change, or null if unknown
 */
export function trackScoreChange(gameId, homeScore, awayScore, nowMs) {
  const prev = _scoreHistory.get(gameId);

  if (!prev) {
    // First observation: no history, return null (unknown)
    _scoreHistory.set(gameId, { homeScore, awayScore, lastChangeTs: null });
    return null;
  }

  if (prev.homeScore !== homeScore || prev.awayScore !== awayScore) {
    // Score changed!
    _scoreHistory.set(gameId, { homeScore, awayScore, lastChangeTs: nowMs });
    return 0; // just changed
  }

  // Score unchanged
  if (prev.lastChangeTs == null) return null; // never seen a change
  return Math.round((nowMs - prev.lastChangeTs) / 1000);
}

/**
 * Reset score history (for testing).
 */
export function resetScoreHistory() {
  _scoreHistory.clear();
}

// ─── Build index + matching ──────────────────────────────────

/**
 * Build a searchable index from fetched scoreboard games.
 * @param {Array} games - from fetchSoccerScoreboard
 * @returns {Map<string, Array>} - normalized team tokens → game refs
 */
export function buildSoccerIndex(games) {
  const index = new Map();
  for (const game of games) {
    // Index by gameId for direct lookup
    index.set(`id:${game.gameId}`, [game]);

    // Index by team names (both home and away)
    for (const team of [game.home, game.away].filter(Boolean)) {
      const key = normalizeTeamName(team.name);
      if (!key) continue;
      const existing = index.get(`team:${key}`) || [];
      existing.push(game);
      index.set(`team:${key}`, existing);
    }
  }
  return index;
}

/**
 * Match a Polymarket market to an ESPN game.
 *
 * @param {object} market - { slug, title, startDateIso, event_title }
 * @param {Array} games   - all fetched games (flat array)
 * @returns {{ matched: boolean, confidence: string, reasons: string[], game: object|null }}
 */
export function matchMarketToGame(market, games) {
  const slug = String(market?.slug || "").toLowerCase();
  const title = String(market?.title || market?.event_title || "");
  const startIso = market?.startDateIso || market?.endDateIso || null;

  const result = {
    matched: false,
    confidence: "low",
    reasons: [],
    game: null,
  };

  if (!slug || !games || games.length === 0) {
    result.reasons.push("no_input");
    return result;
  }

  // Extract team names from Polymarket title: "Team A vs. Team B" or "Team A vs Team B"
  const vsMatch = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*[-–—|]|$)/i);
  const polyTeamA = vsMatch ? vsMatch[1].trim() : null;
  const polyTeamB = vsMatch ? vsMatch[2].trim() : null;

  if (!polyTeamA || !polyTeamB) {
    result.reasons.push("cant_parse_teams_from_title");
    return result;
  }

  // Score each game
  const candidates = [];
  for (const game of games) {
    const homeScore = Math.max(
      teamMatchScore(polyTeamA, game.home?.name),
      teamMatchScore(polyTeamA, game.home?.shortName),
    );
    const awayScore = Math.max(
      teamMatchScore(polyTeamA, game.away?.name),
      teamMatchScore(polyTeamA, game.away?.shortName),
    );
    const homeScoreB = Math.max(
      teamMatchScore(polyTeamB, game.home?.name),
      teamMatchScore(polyTeamB, game.home?.shortName),
    );
    const awayScoreB = Math.max(
      teamMatchScore(polyTeamB, game.away?.name),
      teamMatchScore(polyTeamB, game.away?.shortName),
    );

    // Best pairing: A↔home + B↔away or A↔away + B↔home
    const pairing1 = Math.min(homeScore, awayScoreB);  // A=home, B=away
    const pairing2 = Math.min(awayScore, homeScoreB);   // A=away, B=home
    const bestPairing = Math.max(pairing1, pairing2);

    if (bestPairing >= MATCH_THRESHOLD) {
      candidates.push({ game, score: bestPairing, pairing1, pairing2 });
    }
  }

  if (candidates.length === 0) {
    result.reasons.push("no_team_match");
    return result;
  }

  if (candidates.length > 1) {
    // Multiple candidates: fail closed
    result.reasons.push("multiple_candidates");
    return result;
  }

  const best = candidates[0];

  // Time cross-check (±6h window)
  if (startIso && best.game.startDate) {
    try {
      const polyTime = new Date(startIso).getTime();
      const espnTime = new Date(best.game.startDate).getTime();
      const diffH = Math.abs(polyTime - espnTime) / (1000 * 60 * 60);
      if (diffH > 6) {
        result.reasons.push("time_mismatch");
        return result;
      }
    } catch {
      // If date parsing fails, don't block — but note it
      result.reasons.push("time_parse_error");
    }
  }

  result.matched = true;
  result.game = best.game;

  // Confidence: high only if we have strong match + reliable clock
  if (best.score >= MATCH_THRESHOLD &&
      best.game.minutesLeftConfidence === "high") {
    result.confidence = "high";
  } else {
    result.confidence = "low";
    if (best.game.minutesLeftConfidence !== "high") result.reasons.push("clock_not_reliable");
  }

  return result;
}

// ─── Derive context for the soccer gate ──────────────────────

/**
 * Derive full context object for the soccer entry gate.
 *
 * @param {object} market  - watchlist market entry (with slug, title, entry_outcome_name or outcomes)
 * @param {object} match   - result from matchMarketToGame
 * @param {number} nowMs   - current timestamp
 * @returns {object}       - context for checkSoccerEntryGate
 */
export function deriveSoccerContext(market, match, nowMs) {
  if (!match?.matched || !match?.game) {
    return {
      state: "unknown",
      period: null,
      minutes_left: null,
      confidence: "low",
      margin_for_yes: null,
      lastScoreChangeAgoSec: null,
      teams: null,
    };
  }

  const g = match.game;

  // Track score changes
  const secSinceChange = trackScoreChange(
    g.gameId,
    g.home?.score || 0,
    g.away?.score || 0,
    nowMs,
  );

  // Determine which team is the "Yes" outcome
  const yesOutcome = String(market?.entry_outcome_name || market?.outcomes?.[0] || "");
  const homeMatch = teamMatchScore(yesOutcome, g.home?.name);
  const awayMatch = teamMatchScore(yesOutcome, g.away?.name);

  let marginForYes = null;
  let yesTeamSide = null;

  if (homeMatch > awayMatch && homeMatch >= MATCH_THRESHOLD) {
    marginForYes = (g.home?.score || 0) - (g.away?.score || 0);
    yesTeamSide = "home";
  } else if (awayMatch > homeMatch && awayMatch >= MATCH_THRESHOLD) {
    marginForYes = (g.away?.score || 0) - (g.home?.score || 0);
    yesTeamSide = "away";
  }

  return {
    state: g.state,
    period: g.period,
    minutes_left: g.minutesLeft,
    confidence: match.confidence,
    margin_for_yes: marginForYes,
    lastScoreChangeAgoSec: secSinceChange,
    teams: {
      home: { name: g.home?.name, score: g.home?.score },
      away: { name: g.away?.name, score: g.away?.score },
    },
    yes_team_side: yesTeamSide,
    display_clock: g.displayClock,
    game_id: g.gameId,
  };
}
