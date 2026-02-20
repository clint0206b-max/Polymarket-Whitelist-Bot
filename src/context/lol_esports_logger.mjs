/**
 * LoL Esports Edge Logger v1.0
 *
 * Observes LoL live matches (via Riot Esports API) and correlates with
 * Polymarket CLOB prices.  Writes to `state/journal/lol_edge_log.jsonl`.
 *
 * TWO record streams — decoupled:
 *   market_tick  – from WS callback (high-freq) or HTTP /book (candidate windows)
 *   game_frame   – from Riot feed API (~20s)
 *
 * DOES NOT modify signals, trading, or any core state.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePath } from "../core/state_store.js";

// ── Constants ────────────────────────────────────────────────────────────────

const LOG_PATH = "state/journal/lol_edge_log.jsonl";
const LOL_API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";
const LOL_ESPORTS_BASE = "https://esports-api.lolesports.com/persisted/gw";
const LOL_FEED_BASE = "https://feed.lolesports.com/livestats/v1";
const GAME_FRAME_INTERVAL_MS = 20_000;   // poll Riot feed every 20s
const CANDIDATE_BOOK_MIN_ASK = 0.70;
const CANDIDATE_BOOK_MAX_ASK = 0.95;
const CANDIDATE_BOOK_MAX_SPREAD = 0.06;

// ── State (module-level singleton) ───────────────────────────────────────────

let _initialized = false;
let _logPath = null;

// Active games being tracked:  riot_game_id → { mapping, lastFrameTs, lastFrameData }
const _activeGames = new Map();

// Token→game lookup for WS callback:  tokenId → riot_game_id
const _tokenToGame = new Map();

// Last game_frame ts per game (for age calculation in market_tick)
const _lastGameFrameTs = new Map();

// ── File helpers ─────────────────────────────────────────────────────────────

function ensureLog() {
  if (_logPath) return;
  _logPath = resolvePath(LOG_PATH);
  try { mkdirSync(dirname(_logPath), { recursive: true }); } catch {}
}

function appendLog(obj) {
  ensureLog();
  try {
    appendFileSync(_logPath, JSON.stringify(obj) + "\n");
  } catch (e) {
    console.error(`[LOL_EDGE] log write failed: ${e?.message}`);
  }
}

// ── Riot API helpers ─────────────────────────────────────────────────────────

async function fetchJson(url, headers = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: controller.signal });
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json();
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(to);
  }
}

async function getLiveLoLMatches() {
  const r = await fetchJson(
    `${LOL_ESPORTS_BASE}/getLive?hl=en-US`,
    { "x-api-key": LOL_API_KEY }
  );
  if (!r.ok) return [];
  const events = r.data?.data?.schedule?.events || [];
  return events.filter(e => e.type === "match" && e.state === "inProgress");
}

/**
 * Fetch live game stats window from Riot feed.
 * startingTime must be divisible by 10s and ≥20s behind current time.
 */
async function getGameWindow(gameId) {
  // Round to 10s, subtract 30s for safety margin
  const now = new Date();
  const safeMs = now.getTime() - 30_000;
  const safeDate = new Date(safeMs);
  const sec = safeDate.getUTCSeconds();
  safeDate.setUTCSeconds(sec - (sec % 10), 0);
  const ts = safeDate.toISOString().replace(/\.\d{3}Z$/, ".000Z");

  const r = await fetchJson(
    `${LOL_FEED_BASE}/window/${gameId}?startingTime=${ts}`
  );
  // 204 = game in champ select (no data yet)
  if (!r.ok) return null;
  return r.data;
}

// ── Mapping: Polymarket ↔ Riot ───────────────────────────────────────────────

/**
 * Build mapping between a Polymarket market and a Riot match/game.
 * Returns null if no match found.
 */
function buildMapping(market, riotMatch, riotGame) {
  const teams = riotMatch.match?.teams || [];
  if (teams.length !== 2) return null;

  const riotTeam0 = teams[0];
  const riotTeam1 = teams[1];

  // Find which Riot team matches the Polymarket YES outcome
  const yesOutcome = market.yes_outcome_name || market.outcomes?.[0] || null;
  if (!yesOutcome) return null;

  const yesNorm = normName(yesOutcome);
  const riot0Norm = normName(riotTeam0.name);
  const riot1Norm = normName(riotTeam1.name);

  let outcomeTeamRiotId = null;
  if (fuzzyMatch(yesNorm, riot0Norm)) {
    outcomeTeamRiotId = String(riotTeam0.id);
  } else if (fuzzyMatch(yesNorm, riot1Norm)) {
    outcomeTeamRiotId = String(riotTeam1.id);
  } else {
    // No match — log warning but don't map
    console.log(`[LOL_EDGE] Cannot match outcome "${yesOutcome}" to Riot teams: ${riotTeam0.name}, ${riotTeam1.name}`);
    return null;
  }

  // Game info
  const gameNumber = riotGame.number || null;
  const seriesScore = [
    riotTeam0.result?.gameWins ?? null,
    riotTeam1.result?.gameWins ?? null
  ];

  // Determine blue/red from game teams
  const gameTeams = riotGame.teams || [];
  let blueTeamRiotId = null;
  let redTeamRiotId = null;
  for (const gt of gameTeams) {
    if (gt.side === "blue") blueTeamRiotId = String(gt.id);
    if (gt.side === "red") redTeamRiotId = String(gt.id);
  }

  return {
    polymarket_slug: market.slug,
    condition_id: market.conditionId,
    outcome_token_id: market.tokens?.yes_token_id || null,
    outcome_team_name: yesOutcome,
    outcome_team_riot_id: outcomeTeamRiotId,
    riot_match_id: String(riotMatch.match?.id || riotMatch.id),
    riot_game_id: String(riotGame.id),
    game_number: gameNumber,
    series_score: seriesScore,
    blue_team_riot_id: blueTeamRiotId,
    red_team_riot_id: redTeamRiotId,
    blue_team_name: riotTeam0.name,
    red_team_name: riotTeam1.name,
  };
}

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fuzzyMatch(a, b) {
  if (a === b) return true;
  // One contains the other (handles "Dplus KIA" vs "DK" etc.)
  if (a.includes(b) || b.includes(a)) return true;
  // Common abbreviation patterns
  return false;
}

// ── WS Callback (market_tick from real-time price updates) ───────────────────

/**
 * Called from WS client's _updatePrice. Only logs for tracked LoL tokens.
 * Signature matches the slBreachTracker pattern.
 */
function onWsPriceUpdate(assetId, bestBid, bestAsk, msgTimestampRaw) {
  const gameId = _tokenToGame.get(String(assetId));
  if (!gameId) return;

  const recvTs = Date.now();
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const lastFrameTs = _lastGameFrameTs.get(gameId) || null;

  appendLog({
    type: "market_tick",
    recv_ts_local: recvTs,
    msg_ts_raw: (msgTimestampRaw && msgTimestampRaw > 0) ? msgTimestampRaw : null,
    msg_seq: null,
    riot_game_id: gameId,
    source: "ws",
    best_bid: bestBid,
    best_ask: bestAsk,
    mid: Math.round(mid * 10000) / 10000,
    spread: Math.round(spread * 10000) / 10000,
    last_game_frame_ts: lastFrameTs,
    game_frame_age_ms: lastFrameTs ? (recvTs - lastFrameTs) : null,
  });
}

// ── HTTP Book snapshot (candidate windows only) ──────────────────────────────

/**
 * Fetch full book and log with depth levels.
 * Called only when market conditions suggest a candidate window.
 */
async function logBookSnapshot(gameId, tokenId, hypSizeUsd) {
  const { getBook } = await import("../clob/book_http_client.mjs");
  const { parseAndNormalizeBook } = await import("../clob/book_parser.mjs");

  const raw = await getBook(tokenId, { polling: { http_timeout_ms: 2500 } });
  if (!raw.ok || !raw.rawBook) return;

  const parsed = parseAndNormalizeBook(raw.rawBook, { filters: { max_levels_considered: 10 } }, {});
  if (!parsed.ok || !parsed.book) return;

  const book = parsed.book;
  const askLevels = book.asks.slice(0, 3).map(l => ({ p: l.price, s: l.size }));
  const bidLevels = book.bids.slice(0, 3).map(l => ({ p: l.price, s: l.size }));

  // depth_to_ask_plus_1c: cumulative size on ask side within bestAsk+0.01
  let depthTo1c = 0;
  if (book.bestAsk != null) {
    const ceiling = book.bestAsk + 0.01;
    for (const l of book.asks) {
      if (l.price <= ceiling) depthTo1c += l.size;
      else break;
    }
  }

  const recvTs = Date.now();
  const lastFrameTs = _lastGameFrameTs.get(gameId) || null;

  appendLog({
    type: "market_tick",
    recv_ts_local: recvTs,
    msg_ts_raw: null,
    msg_seq: null,
    riot_game_id: gameId,
    source: "http_book",
    best_bid: book.bestBid,
    best_ask: book.bestAsk,
    mid: book.bestBid != null && book.bestAsk != null
      ? Math.round(((book.bestBid + book.bestAsk) / 2) * 10000) / 10000
      : null,
    spread: book.bestBid != null && book.bestAsk != null
      ? Math.round((book.bestAsk - book.bestBid) * 10000) / 10000
      : null,
    ask_levels: askLevels,
    bid_levels: bidLevels,
    depth_to_ask_plus_1c: Math.round(depthTo1c * 100) / 100,
    hypo_size_usd: hypSizeUsd,
    last_game_frame_ts: lastFrameTs,
    game_frame_age_ms: lastFrameTs ? (recvTs - lastFrameTs) : null,
  });
}

// ── Game frame poll (Riot live stats) ────────────────────────────────────────

async function pollGameFrame(gameId, mapping) {
  const windowData = await getGameWindow(gameId);
  if (!windowData || !windowData.frames || windowData.frames.length === 0) return null;

  const frame = windowData.frames[windowData.frames.length - 1];
  const blue = frame.blueTeam || {};
  const red = frame.redTeam || {};

  // Compute diffs relative to outcome team
  // We store raw blue/red and let analysis derive relative diffs
  const blueGold = blue.totalGold || 0;
  const redGold = red.totalGold || 0;
  const blueKills = blue.totalKills || 0;
  const redKills = red.totalKills || 0;
  const blueTowers = blue.towers || 0;
  const redTowers = red.towers || 0;
  const blueDragons = Array.isArray(blue.dragons) ? blue.dragons : [];
  const redDragons = Array.isArray(red.dragons) ? red.dragons : [];
  const blueBarons = blue.barons || 0;
  const redBarons = red.barons || 0;
  const blueInhibs = blue.inhibitors || 0;
  const redInhibs = red.inhibitors || 0;

  const recvTs = Date.now();
  const frameTs = frame.rfc460Timestamp || null;

  _lastGameFrameTs.set(gameId, recvTs);

  const record = {
    type: "game_frame",
    recv_ts_local: recvTs,
    frame_ts: frameTs,
    riot_game_id: gameId,
    game_state: frame.gameState || null,
    blue_gold: blueGold,
    red_gold: redGold,
    gold_diff: blueGold - redGold,
    blue_kills: blueKills,
    red_kills: redKills,
    kill_diff: blueKills - redKills,
    blue_towers: blueTowers,
    red_towers: redTowers,
    tower_diff: blueTowers - redTowers,
    blue_dragons: blueDragons.length,
    red_dragons: redDragons.length,
    blue_dragon_types: blueDragons,
    red_dragon_types: redDragons,
    blue_barons: blueBarons,
    red_barons: redBarons,
    blue_inhibs: blueInhibs,
    red_inhibs: redInhibs,
  };

  appendLog(record);

  // Check if game finished
  if (frame.gameState === "finished") {
    // Determine winner by gold (heuristic for finished games)
    // Better: check getLive for updated series score
    const winnerSide = blueGold > redGold ? "blue" : "red";
    const winnerTeamId = winnerSide === "blue"
      ? mapping.blue_team_riot_id
      : mapping.red_team_riot_id;

    appendLog({
      type: "outcome",
      recv_ts_local: Date.now(),
      riot_game_id: gameId,
      winner_team_riot_id: winnerTeamId,
      winner_determined_by: "gold_at_finish",
    });

    return { finished: true, winnerTeamId };
  }

  return { finished: false };
}

// ── Main orchestrator (called from eval loop) ────────────────────────────────

/**
 * Main entry point. Called once per eval cycle.
 * Discovers LoL live matches, maps to Polymarket markets, polls game frames.
 *
 * @param {object} state - bot state (read-only for watchlist + WS client)
 * @param {object} cfg - bot config
 * @param {number} now - current timestamp
 * @returns {{ active_games: number, ticks_logged: number }}
 */
export async function lolEdgeLoggerTick(state, cfg, now) {
  const stats = { active_games: 0, ticks_logged: 0, errors: 0 };

  // Find LoL markets in watchlist that are live
  const wl = state.watchlist || {};
  const lolMarkets = Object.values(wl).filter(m =>
    m && m.slug && m.tokens?.yes_token_id &&
    (m.title || "").toLowerCase().includes("lol") &&
    m.esports_ctx?.event?.live === true
  );

  if (lolMarkets.length === 0) {
    // Clean up if no active games
    if (_activeGames.size > 0) {
      _activeGames.clear();
      _tokenToGame.clear();
      _lastGameFrameTs.clear();
      // Detach WS callback
      const wsClient = state.runtime?.wsClient;
      if (wsClient && wsClient._lolEdgeCallback) {
        wsClient._lolEdgeCallback = null;
      }
    }
    return stats;
  }

  // Discover live matches from Riot API (throttled — only when we have new markets or periodically)
  const lastDiscovery = state.runtime?._lol_edge_last_discovery_ts || 0;
  const discoveryInterval = 60_000; // re-check Riot every 60s
  let riotMatches = null;

  if (now - lastDiscovery >= discoveryInterval || _activeGames.size === 0) {
    try {
      riotMatches = await getLiveLoLMatches();
      state.runtime._lol_edge_last_discovery_ts = now;
    } catch (e) {
      stats.errors++;
      console.error(`[LOL_EDGE] getLive failed: ${e?.message}`);
    }
  }

  // Build/update mappings
  if (riotMatches && riotMatches.length > 0) {
    for (const market of lolMarkets) {
      for (const riotEvent of riotMatches) {
        const games = riotEvent.match?.games || [];
        const inProgressGame = games.find(g => g.state === "inProgress");
        if (!inProgressGame) continue;

        const mapping = buildMapping(market, riotEvent, inProgressGame);
        if (!mapping) continue;

        const gid = mapping.riot_game_id;
        if (!_activeGames.has(gid)) {
          // New game — log mapping record
          appendLog({ type: "mapping", ts: now, ...mapping });
          console.log(`[LOL_EDGE] Tracking: ${mapping.blue_team_name} vs ${mapping.red_team_name} game ${mapping.game_number} → ${market.slug}`);
          stats.ticks_logged++;
        }

        _activeGames.set(gid, { mapping, lastFramePollTs: 0 });

        // Register token for WS callback
        const yesTokenId = market.tokens?.yes_token_id;
        if (yesTokenId) {
          _tokenToGame.set(String(yesTokenId), gid);
        }
      }
    }
  }

  // Attach WS callback if not already
  const wsClient = state.runtime?.wsClient;
  if (wsClient && !wsClient._lolEdgeCallback) {
    const origUpdatePrice = wsClient._updatePrice.bind(wsClient);
    wsClient._updatePrice = function (assetId, bestBid, bestAsk, timestamp) {
      origUpdatePrice(assetId, bestBid, bestAsk, timestamp);
      onWsPriceUpdate(assetId, bestBid, bestAsk, timestamp);
    };
    wsClient._lolEdgeCallback = true;
    console.log("[LOL_EDGE] WS price callback attached");
  }

  // Poll game frames for active games
  const toRemove = [];
  for (const [gid, entry] of _activeGames) {
    const elapsed = now - entry.lastFramePollTs;
    if (elapsed < GAME_FRAME_INTERVAL_MS) continue;

    entry.lastFramePollTs = now;

    try {
      const result = await pollGameFrame(gid, entry.mapping);
      if (result) {
        stats.ticks_logged++;
        if (result.finished) {
          toRemove.push(gid);
          console.log(`[LOL_EDGE] Game finished: ${gid}`);
        }
      }
    } catch (e) {
      stats.errors++;
      console.error(`[LOL_EDGE] pollGameFrame failed for ${gid}: ${e?.message}`);
    }

    // Candidate window → fetch HTTP book
    // Trigger only on market conditions (not game state)
    const tokenId = entry.mapping.outcome_token_id;
    if (tokenId && wsClient) {
      const cached = wsClient.cache.get(String(tokenId));
      if (cached) {
        const ask = cached.bestAsk;
        const spread = cached.spread;
        if (ask >= CANDIDATE_BOOK_MIN_ASK && ask <= CANDIDATE_BOOK_MAX_ASK && spread <= CANDIDATE_BOOK_MAX_SPREAD) {
          const hypSize = Number(cfg?.trading?.max_position_usd || 10);
          try {
            await logBookSnapshot(gid, tokenId, hypSize);
            stats.ticks_logged++;
          } catch (e) {
            stats.errors++;
          }
        }
      }
    }
  }

  // Clean up finished games
  for (const gid of toRemove) {
    const entry = _activeGames.get(gid);
    if (entry) {
      const tokenId = entry.mapping.outcome_token_id;
      if (tokenId) _tokenToGame.delete(String(tokenId));
    }
    _activeGames.delete(gid);
    _lastGameFrameTs.delete(gid);
  }

  stats.active_games = _activeGames.size;
  return stats;
}

/**
 * Check if the logger has any active game tracking.
 */
export function hasActiveGames() {
  return _activeGames.size > 0;
}

/**
 * Get active game IDs (for health endpoint).
 */
export function getActiveGameIds() {
  return Array.from(_activeGames.keys());
}
