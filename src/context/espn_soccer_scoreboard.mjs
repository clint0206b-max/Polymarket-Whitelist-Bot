// ESPN Soccer Scoreboard Adapter
// Fail-closed: if confidence !== "high", no trade is allowed.
//
// Supports: 23 leagues — all major European, UEFA, Americas, Asia/Oceania
// Add new leagues to ESPN_LEAGUES below (ESPN API covers most FIFA leagues)

// ─── League mapping ──────────────────────────────────────────

const ESPN_LEAGUES = {
  // Top 5 European leagues
  "eng.1":           { name: "Premier League",       slugPrefix: "epl" },
  "esp.1":           { name: "La Liga",              slugPrefix: "lal" },
  "ita.1":           { name: "Serie A",              slugPrefix: "sea" },
  "fra.1":           { name: "Ligue 1",              slugPrefix: "fl1" },
  "ger.1":           { name: "Bundesliga",           slugPrefix: "bun" },
  // UEFA competitions
  "uefa.champions":  { name: "Champions League",     slugPrefix: "ucl" },
  "uefa.europa":     { name: "Europa League",        slugPrefix: "uel" },
  "uefa.europa.conf":{ name: "Conference League",    slugPrefix: "uec" },
  // Americas
  "mex.1":           { name: "Liga MX",              slugPrefix: "mex" },
  "arg.1":           { name: "Liga Argentina",       slugPrefix: "arg" },
  "bra.1":           { name: "Brazilian Serie A",    slugPrefix: "bra" },
  "usa.1":           { name: "MLS",                  slugPrefix: "mls" },
  "conmebol.libertadores": { name: "Copa Libertadores", slugPrefix: "lib" },
  "conmebol.sudamericana": { name: "Copa Sudamericana", slugPrefix: "sud" },
  // Other European
  "ned.1":           { name: "Eredivisie",           slugPrefix: "ere" },
  "por.1":           { name: "Liga Portugal",        slugPrefix: "por" },
  "tur.1":           { name: "Turkish Super Lig",    slugPrefix: "tur" },
  "sco.1":           { name: "Scottish Premiership",  slugPrefix: "sco" },
  "bel.1":           { name: "Belgian Pro League",   slugPrefix: "bel" },
  "gre.1":           { name: "Greek Super League",   slugPrefix: "gre" },
  "rus.1":           { name: "Russian Premier League", slugPrefix: "rus" },
  // Asia / Oceania
  "aus.1":           { name: "A-League Men",         slugPrefix: "aul" },
  "jpn.1":           { name: "J-League",             slugPrefix: "jpn" },
};

export const ESPN_LEAGUE_IDS = Object.keys(ESPN_LEAGUES);
export const SLUG_PREFIX_TO_LEAGUE = Object.fromEntries(
  Object.entries(ESPN_LEAGUES).map(([id, v]) => [v.slugPrefix, id])
);

// ─── Team name normalization ─────────────────────────────────

const STRIP_TOKENS = [
  "fc", "cf", "sc", "cd", "ac", "ssc", "afc", "rc", "rcd", "ca",
  "bv", "bc", "sv", "tsv", "vfb", "vfl", "fk", "nk", "sk", "pk",
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

  // Strip common tokens and founding-year numbers (09, 1899, 1904, etc.)
  const words = name.split(/\s+/).filter(w => w.length > 0);
  const filtered = words.filter(w => !STRIP_TOKENS.includes(w) && !/^\d{2,4}$/.test(w));

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

// ─── Resolve YES team from slug suffix ───────────────────────

/**
 * Polymarket soccer slug codes that are acronyms not derivable from ESPN team names.
 * Only add codes where fuzzy matching fails (i.e. the code is NOT a substring of
 * any word in the normalized ESPN name).
 */
const SLUG_CODE_ALIASES = {
  "rma": "real madrid",
  "fcb": "barcelona",
  "atm": "atletico madrid",
  "liv": "liverpool",
  "mci": "manchester city",
  "mun": "manchester united",
  "tot": "tottenham",
  "wol": "wolverhampton",
  "int": "internazionale",
  "bvb": "borussia dortmund",
  "ata": "atalanta",
};

/** Suffixes that indicate non-team markets (draw, totals, spreads, etc.) */
const NON_TEAM_SUFFIXES = new Set([
  "draw", "total", "spread", "btts", "over", "under",
]);

/**
 * Extract the team suffix from a soccer slug.
 * Format: <league>-<home>-<away>-YYYY-MM-DD-<teamCode>
 * Returns null if no valid date pattern found or suffix is a non-team token.
 */
export function extractSlugTeamSuffix(slug) {
  const parts = String(slug || "").split("-");
  // Find YYYY-MM-DD: 3 consecutive parts matching year (4 digits), month (2 digits), day (2 digits)
  for (let i = 0; i < parts.length - 2; i++) {
    const y = parts[i], mo = parts[i + 1], d = parts[i + 2];
    if (/^\d{4}$/.test(y) && /^\d{2}$/.test(mo) && /^\d{2}$/.test(d)) {
      const suffix = parts.slice(i + 3).join("-");
      if (!suffix) return null;
      // Check if ANY part of the suffix is a non-team token
      const suffixParts = suffix.split("-");
      if (suffixParts.some(p => NON_TEAM_SUFFIXES.has(p))) return null;
      return suffix;
    }
  }
  return null;
}

/**
 * Resolve which ESPN team the YES outcome refers to, using the slug suffix.
 *
 * Strategy:
 * 1. Strip trailing digits from suffix (e.g. "asm1" → "asm", "bvb1" → "bvb")
 * 2. Check explicit SLUG_CODE_ALIASES for known acronyms
 * 3. Fuzzy match (teamMatchScore) against individual words of each team name
 * 4. Only return if exactly ONE team matches (unambiguous)
 *
 * @param {string} suffix - team code from slug (e.g. "ben", "rma", "asm1")
 * @param {string} homeName - ESPN home team display name
 * @param {string} awayName - ESPN away team display name
 * @returns {{ side: "home"|"away", name: string, score: number, via: string }|null}
 */
export function resolveYesTeamFromSlug(suffix, homeName, awayName) {
  if (!suffix || !homeName || !awayName) return null;

  const cleaned = suffix.replace(/\d+$/, "").toLowerCase();
  if (!cleaned) return null;

  // 1. Check explicit alias
  const alias = SLUG_CODE_ALIASES[cleaned];
  if (alias) {
    const hScore = teamMatchScore(alias, homeName);
    const aScore = teamMatchScore(alias, awayName);
    if (hScore > aScore && hScore > 0.5) return { side: "home", name: homeName, score: hScore, via: "alias" };
    if (aScore > hScore && aScore > 0.5) return { side: "away", name: awayName, score: aScore, via: "alias" };
    // Alias matched neither team (unlikely) — fall through to fuzzy
  }

  // 2. Fuzzy match: compare cleaned suffix against each word of the team names
  const homeWords = homeName.split(/\s+/);
  const awayWords = awayName.split(/\s+/);
  const hScore = Math.max(
    teamMatchScore(cleaned, homeName),
    ...homeWords.map(w => teamMatchScore(cleaned, w)),
  );
  const aScore = Math.max(
    teamMatchScore(cleaned, awayName),
    ...awayWords.map(w => teamMatchScore(cleaned, w)),
  );

  // 3. Only accept if unambiguous
  if (hScore > 0 && aScore === 0) return { side: "home", name: homeName, score: hScore, via: "fuzzy" };
  if (aScore > 0 && hScore === 0) return { side: "away", name: awayName, score: aScore, via: "fuzzy" };
  // Clear gap (≥ 0.3 difference)
  if (hScore > aScore && (hScore - aScore) >= 0.3) return { side: "home", name: homeName, score: hScore, via: "fuzzy" };
  if (aScore > hScore && (aScore - hScore) >= 0.3) return { side: "away", name: awayName, score: aScore, via: "fuzzy" };

  return null; // ambiguous or no match — fail closed
}

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
    _scoreHistory.set(gameId, { homeScore, awayScore, lastChangeTs: null, _addedTs: nowMs });
    return null;
  }

  if (prev.homeScore !== homeScore || prev.awayScore !== awayScore) {
    // Score changed!
    _scoreHistory.set(gameId, { homeScore, awayScore, lastChangeTs: nowMs, _addedTs: prev._addedTs || nowMs });
    return 0; // just changed
  }

  // Score unchanged
  if (prev.lastChangeTs == null) return null; // never seen a change
  return Math.round((nowMs - prev.lastChangeTs) / 1000);
}

/**
 * Purge stale entries from score history (older than maxAgeMs).
 * @param {number} nowMs
 * @param {number} maxAgeMs - default 24h
 * @returns {number} number of purged entries
 */
export function purgeStaleScoreHistory(nowMs, maxAgeMs = 24 * 60 * 60 * 1000) {
  let purged = 0;
  for (const [gameId, entry] of _scoreHistory) {
    // Use lastChangeTs if available, otherwise consider it stale if we haven't
    // seen a change and it's been in the map a long time. We track an _addedTs.
    const age = nowMs - (entry._addedTs || entry.lastChangeTs || 0);
    if (age > maxAgeMs) {
      _scoreHistory.delete(gameId);
      purged++;
    }
  }
  return purged;
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
  // endDateIso is the game date (e.g. "2026-02-16"), startDateIso is the listing date
  const startIso = market?.endDateIso || market?.startDateIso || null;

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

  // Time cross-check (same calendar day, UTC)
  // Polymarket endDateIso can be date-only ("2026-02-16") or full ISO.
  // ESPN startDate is full ISO ("2026-02-16T22:00Z").
  // Compare calendar days (UTC) instead of ±6h window, because date-only strings
  // parse to midnight which can cause false mismatches with evening games.
  if (startIso && best.game.startDate) {
    try {
      const polyDay = new Date(startIso).toISOString().slice(0, 10);
      const espnDay = new Date(best.game.startDate).toISOString().slice(0, 10);
      if (polyDay !== espnDay) {
        // Allow 1-day tolerance for games near midnight UTC (e.g. Americas late evening)
        const polyMs = new Date(polyDay + "T00:00:00Z").getTime();
        const espnMs = new Date(espnDay + "T00:00:00Z").getTime();
        const diffDays = Math.abs(polyMs - espnMs) / (1000 * 60 * 60 * 24);
        if (diffDays > 1) {
          result.reasons.push("time_mismatch");
          return result;
        }
      }
    } catch {
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
