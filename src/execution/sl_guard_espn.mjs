/**
 * sl_guard_espn.mjs — ESPN-based stop-loss guard.
 * Before executing SL, verify with ESPN that the team is actually losing.
 * If ESPN shows our team winning comfortably, block the SL (likely a book glitch).
 *
 * Applies to: NBA, CBB (leagues with ESPN scoreboard providers).
 * Does NOT apply to: esports (no ESPN data).
 */

import { fetchEspnCbbScoreboardForDate, deriveCbbContextForMarket, computeDateWindow3, mergeScoreboardEventsByWindow } from "../context/espn_cbb_scoreboard.mjs";
import { fetchEspnNbaScoreboardForDate, deriveNbaContextForMarket } from "../context/espn_nba_scoreboard.mjs";
import { loadTeamOverrides, applyOutcomeOverride } from "../config/team_overrides.mjs";

// Lazy-load outcome overrides
let _outcomeOverrides = null;
function getOutcomeOverrides() {
  if (_outcomeOverrides === null) {
    const ov = loadTeamOverrides();
    _outcomeOverrides = ov.outcomeEntries;
  }
  return _outcomeOverrides;
}

function todayDateKey() {
  // UTC date key YYYYMMDD
  const d = new Date();
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function normTeam(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function nameMatch(yesN, teamN) {
  if (!yesN || !teamN) return false;
  return yesN === teamN || yesN.includes(teamN) || teamN.includes(yesN);
}

/**
 * Determine if our team is winning based on ESPN context.
 * @param {object} ctx - ESPN context from deriveXxxContextForMarket
 * @param {string} outcomeName - the outcome we hold (team name)
 * @returns {{ block: boolean, reason: string, details?: object }}
 */
function evaluateGuard(ctx, outcomeName) {
  if (!ctx?.ok || !ctx?.context) {
    return { block: false, reason: "no_espn_context" };
  }

  const c = ctx.context;

  // Only guard live games
  if (c.state !== "in") {
    return { block: false, reason: `game_state_${c.state}`, details: { state: c.state } };
  }

  const teams = c.teams;
  if (!teams?.a?.name || !teams?.b?.name) {
    return { block: false, reason: "no_team_data" };
  }

  // Match our outcome to a team (with outcome overrides for abbreviation mismatches)
  const normOutcome = applyOutcomeOverride(normTeam(outcomeName), getOutcomeOverrides());
  const normA = normTeam(teams.a.name);
  const normB = normTeam(teams.b.name);
  const normAFull = teams.a.fullName ? normTeam(teams.a.fullName) : null;
  const normBFull = teams.b.fullName ? normTeam(teams.b.fullName) : null;

  let ourScore = null;
  let theirScore = null;
  let ourTeam = null;

  const yesIsA = nameMatch(normOutcome, normA) || nameMatch(normOutcome, normAFull);
  const yesIsB = nameMatch(normOutcome, normB) || nameMatch(normOutcome, normBFull);

  if (yesIsA && !yesIsB) {
    ourScore = teams.a.score;
    theirScore = teams.b.score;
    ourTeam = teams.a.name;
  } else if (yesIsB && !yesIsA) {
    ourScore = teams.b.score;
    theirScore = teams.a.score;
    ourTeam = teams.b.name;
  }

  if (ourScore == null || theirScore == null) {
    return { block: false, reason: "team_match_failed", details: { outcome: outcomeName, a: teams.a.name, b: teams.b.name } };
  }

  const margin = ourScore - theirScore;
  const winning = margin > 0;

  // Block SL if our team is winning by > 5 points
  if (winning && margin > 5) {
    return {
      block: true,
      reason: "team_winning",
      details: {
        ourTeam, ourScore, theirScore, margin,
        period: c.period, displayClock: c.displayClock,
        minutes_left: c.minutes_left,
      }
    };
  }

  return {
    block: false,
    reason: winning ? "margin_too_small" : "team_losing",
    details: { ourTeam, ourScore, theirScore, margin }
  };
}

/**
 * Check if SL should be blocked for a given signal.
 * Fetches fresh ESPN data (not cached) to get latest score.
 *
 * @param {object} signal - signal_close object with slug, league info
 * @param {string} outcomeName - the outcome we bought
 * @param {string} league - "nba" | "cbb" | other
 * @param {object} cfg - config
 * @returns {Promise<{ block: boolean, reason: string, details?: object }>}
 */
export async function shouldBlockSl(signal, outcomeName, league, cfg) {
  // Only applies to NBA and CBB
  if (league !== "nba" && league !== "cbb") {
    return { block: false, reason: "league_not_guarded" };
  }

  try {
    const dateKey = todayDateKey();
    const market = { title: signal.title || signal.slug, slug: signal.slug };

    if (league === "cbb") {
      const days = computeDateWindow3(dateKey);
      const results = await Promise.all(days.map(dk => fetchEspnCbbScoreboardForDate(cfg, dk)));
      const merged = mergeScoreboardEventsByWindow(dateKey, results);
      if (!merged.events?.length) return { block: false, reason: "no_espn_events" };
      const ctx = deriveCbbContextForMarket(market, merged.events, cfg, Date.now());
      return evaluateGuard(ctx, outcomeName);
    }

    if (league === "nba") {
      const days = computeDateWindow3(dateKey);
      const results = await Promise.all(days.map(dk => fetchEspnNbaScoreboardForDate(cfg, dk)));
      const merged = mergeScoreboardEventsByWindow(dateKey, results);
      if (!merged.events?.length) return { block: false, reason: "no_espn_events" };
      const ctx = deriveNbaContextForMarket(market, merged.events, cfg, Date.now());
      return evaluateGuard(ctx, outcomeName);
    }

    return { block: false, reason: "unknown_league" };
  } catch (e) {
    // On error, don't block (let SL execute for safety)
    return { block: false, reason: "error", details: { error: String(e?.message || e) } };
  }
}
