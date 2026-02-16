import { getBook } from "../clob/book_http_client.mjs";
import { parseAndNormalizeBook } from "../clob/book_parser.mjs";
import { CLOBWebSocketClient } from "../clob/ws_client.mjs";
import { is_base_signal_candidate, is_near_signal_margin } from "../strategy/stage1.mjs";
import { compute_depth_metrics, is_depth_sufficient } from "../strategy/stage2.mjs";
import { createHttpQueue } from "./http_queue.mjs";
import { fetchEspnCbbScoreboardForDate, deriveCbbContextForMarket, computeDateWindow3, mergeScoreboardEventsByWindow } from "../context/espn_cbb_scoreboard.mjs";
import { fetchEspnNbaScoreboardForDate, deriveNbaContextForMarket } from "../context/espn_nba_scoreboard.mjs";
import { estimateWinProb, checkContextEntryGate, checkSoccerEntryGate, soccerWinProb } from "../strategy/win_prob_table.mjs";
import { fetchSoccerScoreboard, matchMarketToGame, deriveSoccerContext, ESPN_LEAGUE_IDS, SLUG_PREFIX_TO_LEAGUE, resetScoreHistory, purgeStaleScoreHistory } from "../context/espn_soccer_scoreboard.mjs";
import { isSoccerSlug } from "../gamma/gamma_parser.mjs";
import { loadDailyEvents, saveDailyEvents, recordMarketTick, purgeStaleDates } from "../metrics/daily_events.mjs";
import { appendJsonl } from "../core/journal.mjs";
import { selectPriceUpdateUniverse, selectPipelineUniverse } from "./universe.mjs";

function ensure(obj, k, v) { if (obj[k] === undefined) obj[k] = v; }

// --- Esports series guard (tag-only) ---
function normTeam(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTeamsFromTitle(title) {
  const raw = String(title || "").trim();
  if (!raw) return null;
  const low = ` ${raw.toLowerCase()} `;
  const seps = [" vs ", " vs. ", " v ", " v. "];
  for (const sep of seps) {
    const idx = low.indexOf(sep);
    if (idx > 0) {
      const left = raw.slice(0, idx).trim();
      const right = raw.slice(idx + sep.trim().length).trim();
      if (!left || !right) continue;
      return { a: left, b: right };
    }
  }
  return null;
}

function parseBoFromScoreOrPeriod(scoreRaw, periodRaw) {
  const s = String(scoreRaw || "");
  const m = s.match(/\bBo\s*(3|5)\b/i);
  if (m) return Number(m[1]);

  const p = String(periodRaw || "");
  const mp = p.match(/^(\d+)\/(\d+)$/);
  if (mp) {
    const den = Number(mp[2]);
    if (den === 3 || den === 5) return den;
  }
  return null;
}

function parseMapsFromScore(scoreRaw) {
  const s = String(scoreRaw || "");
  // e.g. "...|0-1|Bo3" or "0-1|Bo3"
  const m = s.match(/\b(\d+)\s*-\s*(\d+)\b/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { a, b };
}

function computeEsportsDerived(m, cfg) {
  // Returns derived or null (never throws)
  const ctx = m?.esports_ctx;
  const ev = ctx?.event;
  const mk = ctx?.market;

  const out = {
    v: 1,
    series_format: "unknown",
    maps_a: null,
    maps_b: null,
    leader_name: null,
    leader_maps: null,
    required_wins: null,
    yes_outcome_name: null,
    guard_status: "unknown",
    guard_reason: "unknown"
  };

  const bo = parseBoFromScoreOrPeriod(ev?.score_raw, ev?.period_raw);
  if (bo === 3) { out.series_format = "bo3"; out.required_wins = 1; }
  else if (bo === 5) { out.series_format = "bo5"; out.required_wins = 2; }
  else { out.series_format = "unknown"; out.required_wins = null; }

  const maps = parseMapsFromScore(ev?.score_raw);
  if (maps) {
    out.maps_a = maps.a;
    out.maps_b = maps.b;
  }

  const teams = parseTeamsFromTitle(ev?.title);
  const tA = teams ? normTeam(teams.a) : null;
  const tB = teams ? normTeam(teams.b) : null;

  // Determine leader name (if score parsed)
  if (maps && teams) {
    if (maps.a > maps.b) { out.leader_name = teams.a; out.leader_maps = maps.a; }
    else if (maps.b > maps.a) { out.leader_name = teams.b; out.leader_maps = maps.b; }
    else { out.leader_name = null; out.leader_maps = maps.a; }
  }

  // Determine yes_outcome_name from outcomes + clobTokenIds ordering
  const yesId = m?.tokens?.yes_token_id;
  const clobIds = Array.isArray(mk?.clobTokenIds) ? mk.clobTokenIds : null;
  const outcomes = Array.isArray(mk?.outcomes) ? mk.outcomes : null;
  if (yesId && clobIds && outcomes && clobIds.length === 2 && outcomes.length === 2) {
    const idx = clobIds.findIndex(x => String(x) === String(yesId));
    if (idx >= 0) out.yes_outcome_name = outcomes[idx];
  }

  // Guard applies only when price entry is high enough AND format known
  const thr = Number(cfg?.esports?.series_guard_threshold_high ?? 0.94);
  const ask = Number(m?.last_price?.yes_best_ask);
  const high = Number.isFinite(ask) && ask >= thr;

  if (!high) {
    out.guard_status = "unknown";
    out.guard_reason = "below_threshold";
    return out;
  }

  // must have format
  if (out.series_format !== "bo3" && out.series_format !== "bo5") {
    out.guard_status = "unknown";
    out.guard_reason = "no_format";
    return out;
  }

  if (!maps) {
    out.guard_status = "unknown";
    out.guard_reason = "no_score";
    return out;
  }

  if (!outcomes || !clobIds) {
    out.guard_status = "unknown";
    out.guard_reason = "no_outcomes";
    return out;
  }

  if (!yesId) {
    out.guard_status = "unknown";
    out.guard_reason = "no_yes_token";
    return out;
  }

  if (!teams || !tA || !tB) {
    out.guard_status = "unknown";
    out.guard_reason = "no_teams";
    return out;
  }

  if (!out.yes_outcome_name) {
    out.guard_status = "unknown";
    out.guard_reason = "no_yes_outcome_name";
    return out;
  }

  if (!out.leader_name) {
    out.guard_status = "unknown";
    out.guard_reason = "tie";
    return out;
  }

  // Compare yes outcome to leader
  const yesNorm = normTeam(out.yes_outcome_name);
  const leaderNorm = normTeam(out.leader_name);

  if (yesNorm !== leaderNorm) {
    out.guard_status = "blocked";
    out.guard_reason = "not_ahead";
    return out;
  }

  if (out.required_wins != null && out.leader_maps != null && out.leader_maps < out.required_wins) {
    out.guard_status = "blocked";
    out.guard_reason = "ahead_but_not_enough_maps";
    return out;
  }

  out.guard_status = "allowed";
  out.guard_reason = "allowed";
  return out;
}

function nowSecFromMs(ms) { return Math.round(ms / 1000); }

function isValidTokenPair(arr) { return Array.isArray(arr) && arr.length === 2 && arr.every(x => typeof x === "string" && x.length > 0); }

function getTokenPair(m) {
  const t = m?.tokens;
  const ids = t?.clobTokenIds;
  return isValidTokenPair(ids) ? ids : null;
}

export async function loopEvalHttpOnly(state, cfg, now) {
  state.runtime = state.runtime || {};
  state.runtime.health = state.runtime.health || {};
  const health = state.runtime.health;

  // Initialize WebSocket client (singleton pattern, lazy connect)
  if (!state.runtime.wsClient) {
    state.runtime.wsClient = new CLOBWebSocketClient(cfg);
    // Don't call connect() here - let it connect on first subscribe() call
    console.log("[WS] Client initialized (lazy mode)");
  }
  const wsClient = state.runtime.wsClient;

  // Eval tick observability
  health.last_eval_tick_ts = now;

  function upsertTopN(key, row, sortFn, n = 5) {
    const cur = Array.isArray(state.runtime[key]) ? state.runtime[key] : [];
    const kept = cur.filter(x => x && x.slug !== row.slug);
    kept.push(row);
    kept.sort(sortFn);
    state.runtime[key] = kept.slice(0, n);
  }

  function recordHotCandidate(m, quote, metrics) {
    // Triggered snapshot for diagnosis: store last hot candidates even if pending_enter==0 in window.
    const entryDepth = Number(metrics?.entry_depth_usd_ask || 0);
    const exitDepth = Number(metrics?.exit_depth_usd_bid || 0);
    const row = {
      ts: now,
      quote_ts: now,
      slug: String(m.slug || ""),
      status: m.status,
      probAsk: Number(quote?.probAsk),
      probBid: Number(quote?.probBid),
      spread: Number(quote?.spread),
      entry_depth_usd_ask: entryDepth,
      exit_depth_usd_bid: exitDepth,
      base_range_pass: null,
      last_reject: m.last_reject?.reason || "-"
    };

    upsertTopN(
      "last_hot_candidates",
      row,
      (a, b) =>
        (Number(b.probAsk) - Number(a.probAsk)) ||
        (Number(a.spread) - Number(b.spread)) ||
        (Number(b.exit_depth_usd_bid) - Number(a.exit_depth_usd_bid)) ||
        (Number(b.ts) - Number(a.ts)) ||
        String(a.slug).localeCompare(String(b.slug)),
      5
    );
  }

  function recordHotCandidateRelaxed(m, quote, metrics, baseRangePass) {
    const entryDepth = Number(metrics?.entry_depth_usd_ask || 0);
    const exitDepth = Number(metrics?.exit_depth_usd_bid || 0);
    const row = {
      ts: now,
      quote_ts: now,
      slug: String(m.slug || ""),
      status: m.status,
      probAsk: Number(quote?.probAsk),
      probBid: Number(quote?.probBid),
      spread: Number(quote?.spread),
      entry_depth_usd_ask: entryDepth,
      exit_depth_usd_bid: exitDepth,
      base_range_pass: !!baseRangePass,
      last_reject: m.last_reject?.reason || "-"
    };

    upsertTopN(
      "last_hot_candidates_relaxed",
      row,
      (a, b) =>
        (Number(b.probAsk) - Number(a.probAsk)) ||
        (Number(a.spread) - Number(b.spread)) ||
        (Number(b.exit_depth_usd_bid) - Number(a.exit_depth_usd_bid)) ||
        (Number(b.entry_depth_usd_ask) - Number(a.entry_depth_usd_ask)) ||
        (Number(a.quote_ts) - Number(b.quote_ts)) ||
        String(a.slug).localeCompare(String(b.slug)),
      5
    );
  }

  // Resolver-local strict parsing that is "usable" if EITHER side has valid levels
  function toNumStrict(x) {
    if (typeof x === "number") return Number.isFinite(x) ? x : null;
    if (typeof x === "string") {
      const t = x.trim();
      if (!t) return null;
      if (t.includes(",")) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function parseLevels(rawLevels, maxLevels, side) {
    const levels = Array.isArray(rawLevels) ? rawLevels : [];
    const parsed = [];
    for (const lv of levels) {
      const p = toNumStrict(lv?.price);
      const s = toNumStrict(lv?.size);
      if (p == null || s == null) continue;
      if (!(p > 0 && p <= 1)) continue;
      if (!(s > 0)) continue;
      parsed.push({ price: p, size: s });
    }
    parsed.sort((a, b) => side === "bids" ? (b.price - a.price) : (a.price - b.price));
    return parsed.slice(0, maxLevels);
  }

  function parseBookForScore(rawBook, cfg) {
    const maxLevels = Number(cfg?.filters?.max_levels_considered || 50);
    const bids = parseLevels(rawBook?.bids, maxLevels, "bids");
    const asks = parseLevels(rawBook?.asks, maxLevels, "asks");

    const bestBid = bids.length ? bids[0].price : null;
    const bestAsk = asks.length ? asks[0].price : null;

    if (bestBid == null && bestAsk == null) {
      return { ok: false, reason: "book_not_usable", bestBid: null, bestAsk: null };
    }
    return { ok: true, reason: null, bestBid, bestAsk };
  }

  // Cumulative reject counts (never reset, survives across cycles)
  if (!health.reject_counts_cumulative) health.reject_counts_cumulative = {};
  function setReject(m, reason, extra) {
    m.last_reject = { reason, ts: Date.now(), ...extra };
    health.reject_counts_cumulative[reason] = (health.reject_counts_cumulative[reason] || 0) + 1;
  }

  // reset per-cycle counters
  health.reject_counts_last_cycle = {};
  health.http_fallback_fail_by_reason_last_cycle = {};
  health.token_resolve_fail_by_reason_last_cycle = {};
  health.pending_confirm_fail_by_reason_last_cycle = {};
  health.stage1_evaluated_last_cycle = 0;
  health.quote_incomplete_missing_best_ask_last_cycle = 0;
  health.quote_incomplete_missing_best_bid_last_cycle = 0;
  ensure(health, "gray_zone_count", 0);

  const queue = createHttpQueue(cfg, health);

  // --- Context feed (CBB D2 v0, tag-only) ---
  // NOTE: cache is keyed by market dateKey (derived from market.endDateIso in UTC), not by utc-now.
  const contextEnabled = !!cfg?.context?.enabled;

  // cache accessor for CBB events
  function dateKeyFromIsoUtc(iso) {
    if (!iso) return null;
    const d = new Date(String(iso));
    if (!Number.isFinite(d.getTime())) return null;
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
  }

  function daysDeltaFromNowUtc(dateKey) {
    const m = String(dateKey || "").match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const nowDay = (() => {
      const d = new Date(now);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    })();
    return Math.round((day - nowDay) / (24 * 60 * 60 * 1000));
  }

  // Purge stale context cache entries (dateKeys > 2 days old with no active markets)
  {
    const cc = state.runtime?.context_cache;
    if (cc) {
      const activeDateKeys = new Set();
      for (const m of Object.values(state.watchlist || {})) {
        if (!(m.status === "watching" || m.status === "pending_signal")) continue;
        const dk = dateKeyFromIsoUtc(m.endDateIso || m.startDateIso);
        if (dk) activeDateKeys.add(dk);
      }
      for (const cacheKey of ["cbb_by_dateKey", "nba_by_dateKey"]) {
        const node = cc[cacheKey];
        if (!node || typeof node !== "object") continue;
        for (const dk of Object.keys(node)) {
          const delta = daysDeltaFromNowUtc(dk);
          if (delta != null && delta < -2 && !activeDateKeys.has(dk)) {
            delete node[dk];
            bumpBucket("health", `context_cache_purged:${cacheKey}:${dk}`, 1);
          }
        }
      }
      // Purge legacy cbb cache if present
      if (cc.cbb && typeof cc.cbb === "object") {
        const legacySize = JSON.stringify(cc.cbb).length;
        if (legacySize > 1000) {
          delete cc.cbb;
          bumpBucket("health", "context_cache_purged:cbb_legacy", 1);
        }
      }
    }
  }

  // Purge stale daily_events entries (>7 days) — once per eval cycle, cheap O(n) on date keys
  {
    const de = loadDailyEvents();
    const purged = purgeStaleDates(de, 7);
    if (purged > 0) {
      saveDailyEvents(de);
      bumpBucket("health", "daily_events_purged", purged);
    }
  }

  // Purge stale score history entries (>24h)
  purgeStaleScoreHistory(now);

  // Strip ESPN event to only the fields needed for matching/context (saves ~90% of cache size)
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
    // Only keep competitors from competitions[0]
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

  function stripEspnEvents(events) {
    if (!Array.isArray(events)) return events;
    return events.map(stripEspnEvent);
  }

  async function getCbbEventsForDateKey(dateKey) {
    if (!contextEnabled) return null;
    if (!dateKey) return null;

    const maxDays = Number(cfg?.context?.cbb?.max_days_delta_fetch ?? 7);
    const delta = daysDeltaFromNowUtc(dateKey);
    if (delta != null && Math.abs(delta) > maxDays) {
      bumpBucket("health", "context_cbb_tag_skipped_date_too_far", 1);
      return null;
    }

    state.runtime.context_cache = state.runtime.context_cache || {};
    const node = state.runtime.context_cache.cbb_by_dateKey || (state.runtime.context_cache.cbb_by_dateKey = {});

    const everyMs = Number(cfg?.context?.cbb?.fetch_seconds || 15) * 1000;
    const cur = node[dateKey] || { ts: 0, events: null, date_key: dateKey, days_fetched: null, games_total: 0, games_unique: 0 };

    const shouldFetch = (!cur.ts || (now - Number(cur.ts)) >= everyMs || !Array.isArray(cur.events));
    if (shouldFetch) {
      bumpBucket("health", "context_cbb_cache_miss", 1);
      bumpBucket("health", "context_cbb_cache_miss_by_dateKey", 1);

      const days = computeDateWindow3(dateKey);
      bumpBucket("health", "context_cbb_fetch_days_3", 1);

      const results = await Promise.all(days.map(dk => fetchEspnCbbScoreboardForDate(cfg, dk)));

      for (const r of results) {
        if (r.ok) {
          bumpBucket("health", "context_cbb_fetch_ok", 1);
          if (!Array.isArray(r.events) || r.events.length === 0) bumpBucket("health", "context_cbb_fetch_empty_events", 1);
        } else {
          bumpBucket("health", "context_cbb_fetch_fail", 1);
          if (r.reason === "parse") bumpBucket("health", "context_cbb_fetch_parse_fail", 1);
        }
      }

      const merged = mergeScoreboardEventsByWindow(dateKey, results);

      state.runtime.last_context_cbb_fetch = {
        ts: now,
        ok: true,
        provider: "espn",
        date_key: dateKey,
        days_fetched: days,
        games_total: merged.games_total,
        games_unique: merged.games_unique
      };

      cur.ts = now;
      cur.date_key = dateKey;
      cur.days_fetched = days;
      cur.events = stripEspnEvents(merged.events);
      cur.games_total = merged.games_total;
      cur.games_unique = merged.games_unique;

      bumpBucket("health", "context_cbb_games_total", Number(merged.games_total || 0));
      bumpBucket("health", "context_cbb_games_unique", Number(merged.games_unique || 0));

      node[dateKey] = cur;
    } else {
      bumpBucket("health", "context_cbb_cache_hit", 1);
      bumpBucket("health", "context_cbb_cache_hit_by_dateKey", 1);
    }

    return Array.isArray(node[dateKey]?.events) ? node[dateKey].events : null;
  }

  async function getNbaEventsForDateKey(dateKey) {
    if (!contextEnabled) return null;
    if (!dateKey) return null;

    const maxDays = Number(cfg?.context?.nba?.max_days_delta_fetch ?? 7);
    const delta = daysDeltaFromNowUtc(dateKey);
    if (delta != null && Math.abs(delta) > maxDays) {
      bumpBucket("health", "context_nba_tag_skipped_date_too_far", 1);
      return null;
    }

    state.runtime.context_cache = state.runtime.context_cache || {};
    const node = state.runtime.context_cache.nba_by_dateKey || (state.runtime.context_cache.nba_by_dateKey = {});

    const everyMs = Number(cfg?.context?.nba?.fetch_seconds || 15) * 1000;
    const cur = node[dateKey] || { ts: 0, events: null, date_key: dateKey, days_fetched: null, games_total: 0, games_unique: 0 };

    const shouldFetch = (!cur.ts || (now - Number(cur.ts)) >= everyMs || !Array.isArray(cur.events));
    if (shouldFetch) {
      bumpBucket("health", "context_nba_cache_miss", 1);
      bumpBucket("health", "context_nba_cache_miss_by_dateKey", 1);

      const days = computeDateWindow3(dateKey);
      bumpBucket("health", "context_nba_fetch_days_3", 1);

      const results = await Promise.all(days.map(dk => fetchEspnNbaScoreboardForDate(cfg, dk)));

      for (const r of results) {
        if (r.ok) {
          bumpBucket("health", "context_nba_fetch_ok", 1);
          if (!Array.isArray(r.events) || r.events.length === 0) bumpBucket("health", "context_nba_fetch_empty_events", 1);
        } else {
          bumpBucket("health", "context_nba_fetch_fail", 1);
          if (r.reason === "parse") bumpBucket("health", "context_nba_fetch_parse_fail", 1);
        }
      }

      const merged = mergeScoreboardEventsByWindow(dateKey, results);

      state.runtime.last_context_nba_fetch = {
        ts: now,
        ok: true,
        provider: "espn",
        date_key: dateKey,
        days_fetched: days,
        games_total: merged.games_total,
        games_unique: merged.games_unique
      };

      cur.ts = now;
      cur.date_key = dateKey;
      cur.days_fetched = days;
      cur.events = stripEspnEvents(merged.events);
      cur.games_total = merged.games_total;
      cur.games_unique = merged.games_unique;

      bumpBucket("health", "context_nba_games_total", Number(merged.games_total || 0));
      bumpBucket("health", "context_nba_games_unique", Number(merged.games_unique || 0));

      node[dateKey] = cur;
    } else {
      bumpBucket("health", "context_nba_cache_hit", 1);
      bumpBucket("health", "context_nba_cache_hit_by_dateKey", 1);
    }

    return Array.isArray(node[dateKey]?.events) ? node[dateKey].events : null;
  }

  const hasPending = Object.values(state.watchlist || {}).some(m => m?.status === "pending_signal");
  const startedWithPending = hasPending;

  // Scheduling fix: don't spend cycles resolving tokens while there are pending confirmations.
  const maxResolves = hasPending ? 0 : Number(cfg?.polling?.max_token_resolves_per_cycle || 5);
  let resolveAttemptsThisCycle = 0;
  let resolveSuccessThisCycle = 0;

  // --- token resolver ---
  // Pick unresolved markets deterministically across the whole watchlist (not just eval universe)
  const wlAll = Object.values(state.watchlist || {}).filter(Boolean);
  const resolveCandidates = wlAll
    .filter(m => (m.status === "watching" || m.status === "pending_signal"))
    .filter(m => getTokenPair(m) && (m?.tokens?.yes_token_id == null))
    .map(m => ({
      m,
      vol: Number(m.gamma_vol24h_usd || 0),
      lastSeen: Number(m.last_seen_ts || 0)
    }));
  resolveCandidates.sort((a, b) => (b.vol - a.vol) || (b.lastSeen - a.lastSeen));

  // Per-league quota scheduling (infra): ensure no league starves when vol signals are noisy/zero.
  const minByLeague = (cfg?.polling?.min_resolves_per_cycle_by_league && typeof cfg.polling.min_resolves_per_cycle_by_league === "object")
    ? cfg.polling.min_resolves_per_cycle_by_league
    : { esports: 2, nba: 1, cbb: 1 };

  // Pending counts by league (for status/debug)
  {
    const pending = {};
    for (const row of resolveCandidates) {
      const lg = String(row?.m?.league || "unknown");
      pending[lg] = (pending[lg] || 0) + 1;
    }
    health.token_resolve_pending_by_league_last_cycle = pending;
    health.token_resolve_quota_cfg = { ...minByLeague };
  }

  // Build plan: take per-league quota first, then fill remaining slots by global rank.
  const plan = [];
  const used = new Set();
  const pick = (row) => {
    const key = String(row?.m?.slug || "");
    if (!key) return false;
    if (used.has(key)) return false;
    used.add(key);
    plan.push(row);
    return true;
  };

  for (const lg of ["esports", "nba", "cbb"]) {
    const quota = Number(minByLeague?.[lg] ?? 0);
    if (!(quota > 0)) continue;
    let taken = 0;
    for (const row of resolveCandidates) {
      if (plan.length >= maxResolves) break;
      if (String(row?.m?.league || "") !== lg) continue;
      if (pick(row)) taken++;
      if (taken >= quota) break;
    }
  }

  for (const row of resolveCandidates) {
    if (plan.length >= maxResolves) break;
    pick(row);
  }

  for (const { m } of plan) {
    if (resolveAttemptsThisCycle >= maxResolves) break;
    m.tokens = m.tokens || {};
    if (m.tokens.yes_token_id != null) continue;

    const pair = getTokenPair(m);
    if (!pair) continue;

    resolveAttemptsThisCycle++;
    bumpBucket("token", `attempt:${m.league}`, 1);

    const [a, b] = pair;
    const ra = await queue.enqueue(() => getBook(a, cfg), { reason: "token_resolve" });
    const rb = await queue.enqueue(() => getBook(b, cfg), { reason: "token_resolve" });

    // token resolve failure breakdown (mutually exclusive primary reason)
    const bumpResolveFail = (reason) => {
      health.token_resolve_failed_count = (health.token_resolve_failed_count || 0) + 1;
      health.token_resolve_fail_by_reason_last_cycle = health.token_resolve_fail_by_reason_last_cycle || {};
      health.token_resolve_fail_by_reason_last_cycle[reason] = (health.token_resolve_fail_by_reason_last_cycle[reason] || 0) + 1;
      bumpBucket("token", `fail_reason:${reason}`, 1);
      bumpBucket("token", `fail_reason:${reason}:${m.league}`, 1);
    };

    if (!ra.ok || !rb.ok) {
      // optional subreason (health only)
      const is429 = (x) => (x?.http_status === 429 || x?.error_code === "http_429");
      if (is429(ra) || is429(rb)) health.resolve_http_429_count = (health.resolve_http_429_count || 0) + 1;
      bumpResolveFail("resolve_http_fail");
      continue;
    }

    const pa = parseBookForScore(ra.rawBook, cfg);
    const pb = parseBookForScore(rb.rawBook, cfg);
    if (!pa.ok || !pb.ok) {
      bumpResolveFail("resolve_book_not_usable");
      continue;
    }

    const score = (p) => (p.bestAsk != null ? Number(p.bestAsk) : (p.bestBid != null ? Number(p.bestBid) : null));
    const scoreA = score(pa);
    const scoreB = score(pb);

    if (scoreA == null || scoreB == null) {
      bumpResolveFail("resolve_missing_score");
      health.token_complement_sanity_skipped_count = (health.token_complement_sanity_skipped_count || 0) + 1;
      continue;
    }

    if (scoreA === scoreB) {
      bumpResolveFail("resolve_tie_score");
      health.token_complement_sanity_skipped_count = (health.token_complement_sanity_skipped_count || 0) + 1;
      continue;
    }

    const yes = (scoreA > scoreB) ? a : b;
    const no = (yes === a) ? b : a;

    m.tokens.yes_token_id = yes;
    m.tokens.no_token_id = no;
    m.tokens.resolved_by = "book_score_compare";
    m.tokens.resolved_ts = now;

    // Complement sanity (health only): p_hi(token) = bestAsk if exists else bestBid
    const complementSum = scoreA + scoreB;
    const ok = (complementSum >= 0.90 && complementSum <= 1.10);
    m.tokens.token_complement_sanity_ok = ok;
    if (!ok) health.token_complement_sanity_fail_count = (health.token_complement_sanity_fail_count || 0) + 1;

    resolveSuccessThisCycle++;
    bumpBucket("token", `success:${m.league}`, 1);
  }

  // Per-cycle + cumulative counters (calibration)
  const resolveFailThisCycle = Math.max(0, resolveAttemptsThisCycle - resolveSuccessThisCycle);
  health.token_resolve_attempts_last_cycle = resolveAttemptsThisCycle;
  health.token_resolve_success_last_cycle = resolveSuccessThisCycle;
  health.token_resolve_fail_last_cycle = resolveFailThisCycle;

  health.token_resolve_attempt_count = (health.token_resolve_attempt_count || 0) + resolveAttemptsThisCycle;
  health.token_resolve_success_count = (health.token_resolve_success_count || 0) + resolveSuccessThisCycle;
  health.token_resolve_fail_count = (health.token_resolve_fail_count || 0) + resolveFailThisCycle;

  // Helper: rolling 5-min buckets (rejects + token resolve)
  function bumpBucket(kind, key, by = 1) {
    const nowMs = now;
    const minuteStart = Math.floor(nowMs / 60000) * 60000;
    health.buckets = health.buckets || { reject: { idx: 0, buckets: [] }, token: { idx: 0, buckets: [] } };
    const node = health.buckets[kind] || (health.buckets[kind] = { idx: 0, buckets: [] });
    if (!Array.isArray(node.buckets) || node.buckets.length !== 5) {
      node.buckets = Array.from({ length: 5 }, () => ({ start_ts: 0, counts: {} }));
      node.idx = 0;
    }
    // advance to current minute bucket
    const cur = node.buckets[node.idx];
    if (cur.start_ts !== minuteStart) {
      node.idx = (node.idx + 1) % 5;
      node.buckets[node.idx] = { start_ts: minuteStart, counts: {} };
    }
    const b = node.buckets[node.idx];
    b.counts[key] = (b.counts[key] || 0) + by;
  }

  // record token resolve deltas into rolling buckets
  bumpBucket("token", "attempt", resolveAttemptsThisCycle);
  bumpBucket("token", "success", resolveSuccessThisCycle);
  bumpBucket("token", "fail", resolveFailThisCycle);

  // NOTE: attempts/success by league are recorded inline during resolver loop.

  // eval tick counter (rolling)
  bumpBucket("health", "eval_tick", 1);

  // --- D2 context tagging (tag-only) ---
  // IMPORTANT: tag is infra/observability; it must NOT depend on which markets happen to be in the eval universe.
  // Cache is keyed by market dateKey (UTC derived from market.endDateIso).
  {
    const tNow = Date.now();
    const wl = Object.values(state.watchlist || {}).filter(Boolean);

    // CBB
    for (const m of wl) {
      if (m.league !== "cbb") continue;
      if (!(m.status === "watching" || m.status === "pending_signal")) continue;

      bumpBucket("health", "context_cbb_tag_attempt", 1);

      const iso = m?.endDateIso || m?.startDateIso || null;
      const dateKey = dateKeyFromIsoUtc(iso);
      if (!dateKey) {
        bumpBucket("health", "context_cbb_tag_skipped_missing_market_date", 1);
        continue;
      }

      const events = await getCbbEventsForDateKey(dateKey);
      if (!events) {
        bumpBucket("health", "context_cbb_tag_skipped_no_cache", 1);
        continue;
      }

      const ctx = deriveCbbContextForMarket(m, events, cfg, tNow);
      if (ctx.ok) {
        const fetchTs = (() => {
          const node = state.runtime?.context_cache?.cbb_by_dateKey;
          const row = node && node[dateKey];
          return row ? Number(row.ts || 0) : 0;
        })();
        ctx.context.fetch_ts = fetchTs || null;
        m.context = ctx.context;

        const kind = String(ctx.context?.match?.kind || "unknown");
        if (kind === "teamsKey_exact") bumpBucket("health", "context_cbb_match_teamsKey_exact", 1);
        else if (kind === "legacy_exact") bumpBucket("health", "context_cbb_match_legacy_exact", 1);
        else if (kind === "legacy_alias") bumpBucket("health", "context_cbb_match_legacy_alias", 1);
        else if (kind === "exact") bumpBucket("health", "context_cbb_match_exact", 1);
        else if (kind === "alias") bumpBucket("health", "context_cbb_match_alias", 1);
        else bumpBucket("health", `context_cbb_match_${kind}`, 1);

        const maxAge = Number(cfg?.context?.cbb?.max_ctx_age_ms || 120000);
        const ageMs = fetchTs ? Math.max(0, tNow - fetchTs) : null;
        if (ageMs != null && ageMs <= maxAge) bumpBucket("health", "context_cbb_tag_with_fresh_ctx", 1);
        else bumpBucket("health", "context_cbb_tag_with_stale_ctx", 1);

        if (ctx.context.decided_pass) bumpBucket("health", "context_cbb_decided_pass", 1);
      } else {
        bumpBucket("health", `context_cbb_match_${ctx.reason}`, 1);

        if (ctx.reason === "no_match" || ctx.reason === "ambiguous") {
          state.runtime.last_context_cbb_no_match_examples = Array.isArray(state.runtime.last_context_cbb_no_match_examples)
            ? state.runtime.last_context_cbb_no_match_examples
            : [];

          state.runtime.last_context_cbb_no_match_examples.push({
            ts: tNow,
            slug: String(m.slug || ""),
            title: String(m.title || m.question || ""),
            reason: ctx.reason,
            debug: { ...(ctx.debug || null), dateKey }
          });
          if (state.runtime.last_context_cbb_no_match_examples.length > 5) {
            state.runtime.last_context_cbb_no_match_examples = state.runtime.last_context_cbb_no_match_examples.slice(-5);
          }
        }
      }
    }

    // NBA
    for (const m of wl) {
      if (m.league !== "nba") continue;
      if (!(m.status === "watching" || m.status === "pending_signal")) continue;

      bumpBucket("health", "context_nba_tag_attempt", 1);

      const iso = m?.endDateIso || m?.startDateIso || null;
      const dateKey = dateKeyFromIsoUtc(iso);
      if (!dateKey) {
        bumpBucket("health", "context_nba_tag_skipped_missing_market_date", 1);
        continue;
      }

      const events = await getNbaEventsForDateKey(dateKey);
      if (!events) {
        bumpBucket("health", "context_nba_tag_skipped_no_cache", 1);
        continue;
      }

      const ctx = deriveNbaContextForMarket(m, events, cfg, tNow);
      if (ctx.ok) {
        const fetchTs = (() => {
          const node = state.runtime?.context_cache?.nba_by_dateKey;
          const row = node && node[dateKey];
          return row ? Number(row.ts || 0) : 0;
        })();
        ctx.context.fetch_ts = fetchTs || null;
        m.context = ctx.context;

        const kind = String(ctx.context?.match?.kind || "unknown");
        if (kind === "teamsKey_exact") bumpBucket("health", "context_nba_match_teamsKey_exact", 1);
        else if (kind === "legacy_exact") bumpBucket("health", "context_nba_match_legacy_exact", 1);
        else if (kind === "legacy_alias") bumpBucket("health", "context_nba_match_legacy_alias", 1);
        else bumpBucket("health", `context_nba_match_${kind}`, 1);

        const maxAge = Number(cfg?.context?.nba?.max_ctx_age_ms || 120000);
        const ageMs = fetchTs ? Math.max(0, tNow - fetchTs) : null;
        if (ageMs != null && ageMs <= maxAge) bumpBucket("health", "context_nba_tag_with_fresh_ctx", 1);
        else bumpBucket("health", "context_nba_tag_with_stale_ctx", 1);

        if (ctx.context.decided_pass) bumpBucket("health", "context_nba_decided_pass", 1);
      } else {
        bumpBucket("health", `context_nba_match_${ctx.reason}`, 1);

        if (ctx.reason === "no_match" || ctx.reason === "ambiguous") {
          state.runtime.last_context_nba_no_match_examples = Array.isArray(state.runtime.last_context_nba_no_match_examples)
            ? state.runtime.last_context_nba_no_match_examples
            : [];

          state.runtime.last_context_nba_no_match_examples.push({
            ts: tNow,
            slug: String(m.slug || ""),
            title: String(m.title || m.question || ""),
            reason: ctx.reason,
            debug: { ...(ctx.debug || null), dateKey }
          });
          if (state.runtime.last_context_nba_no_match_examples.length > 5) {
            state.runtime.last_context_nba_no_match_examples = state.runtime.last_context_nba_no_match_examples.slice(-5);
          }
        }
      }
    }

    // --- Win probability + context entry gate (tag-only dry run) ---
    for (const m of wl) {
      if (m.league !== "cbb" && m.league !== "nba") continue;
      if (!(m.status === "watching" || m.status === "pending_signal")) continue;
      if (!m.context || m.context.provider !== "espn") continue;
      if (m.context.state !== "in") continue;

      const sport = String(m.context.sport);
      bumpBucket("health", `context_winprob_computed:${sport}`, 1);

      // Derive yes_outcome_name from watchlist outcomes + clobTokenIds
      let yesOutcomeName = null;
      const outcomes = Array.isArray(m.outcomes) ? m.outcomes : null;
      const clobIds = Array.isArray(m.tokens?.clobTokenIds) ? m.tokens.clobTokenIds : null;
      const yesId = m.tokens?.yes_token_id;
      if (outcomes && clobIds && yesId && outcomes.length === 2 && clobIds.length === 2) {
        const yesIdx = clobIds.findIndex(x => String(x) === String(yesId));
        if (yesIdx >= 0) yesOutcomeName = String(outcomes[yesIdx]);
      }

      // Match yes_outcome to ESPN team (a or b)
      const teamA = m.context.teams?.a;
      const teamB = m.context.teams?.b;
      let marginForYes = null;

      if (yesOutcomeName && teamA?.name && teamB?.name &&
          teamA.score != null && teamB.score != null) {
        const yesNorm = normTeam(yesOutcomeName);
        const aNorm = normTeam(teamA.name);
        const bNorm = normTeam(teamB.name);

        // Match: check if yes_outcome contains or is contained in either team name
        let yesIsA = false;
        let yesIsB = false;
        if (yesNorm && aNorm && bNorm) {
          yesIsA = (yesNorm === aNorm || yesNorm.includes(aNorm) || aNorm.includes(yesNorm));
          yesIsB = (yesNorm === bNorm || yesNorm.includes(bNorm) || bNorm.includes(yesNorm));
        }

        if (yesIsA && !yesIsB) {
          marginForYes = teamA.score - teamB.score;
        } else if (yesIsB && !yesIsA) {
          marginForYes = teamB.score - teamA.score;
        } else {
          // Ambiguous or no match — can't determine direction
          bumpBucket("health", `context_entry_team_match_fail:${sport}`, 1);
        }
      }

      // Check entry gate
      const gate = checkContextEntryGate({
        sport,
        period: m.context.period,
        minutesLeft: m.context.minutes_left,
        marginForYes,
        minWinProb: Number(cfg?.context?.entry_rules?.min_win_prob ?? 0.90),
        maxMinutesLeft: Number(cfg?.context?.entry_rules?.max_minutes_left ?? 5),
        minMargin: Number(cfg?.context?.entry_rules?.min_margin ?? 1),
      });

      // Persist on market for signal snapshot
      m.context_entry = {
        yes_outcome_name: yesOutcomeName,
        margin_for_yes: marginForYes,
        win_prob: gate.win_prob,
        entry_allowed: gate.allowed,
        entry_blocked_reason: gate.allowed ? null : gate.reason,
      };

      // Observability buckets
      bumpBucket("health", `context_entry_evaluated:${sport}`, 1);
      if (gate.allowed) {
        bumpBucket("health", `context_entry_allowed:${sport}`, 1);
      } else {
        bumpBucket("health", `context_entry_blocked:${sport}`, 1);
        bumpBucket("health", `context_entry_blocked_reason:${sport}:${gate.reason}`, 1);
      }
    }

    // --- Soccer context (ESPN multi-league, cached per league, fail-closed) ---
    {
      const soccerMarkets = wl.filter(m => m.league === "soccer" && (m.status === "watching" || m.status === "pending_signal"));

      if (soccerMarkets.length > 0) {
        bumpBucket("health", "soccer_context_attempt", 1);

        // Determine which ESPN leagues we need from slug prefixes
        const neededLeagues = new Set();
        for (const m of soccerMarkets) {
          const slug = String(m.slug || "").toLowerCase();
          for (const [prefix, leagueId] of Object.entries(SLUG_PREFIX_TO_LEAGUE)) {
            if (slug.startsWith(prefix + "-")) {
              neededLeagues.add(leagueId);
              break;
            }
          }
        }

        // Cache: fetch each league at most every 15s
        if (!state.runtime.soccer_cache) state.runtime.soccer_cache = {};
        const soccerFetchInterval = Number(cfg?.context?.soccer?.fetch_seconds ?? 15) * 1000;
        const soccerTimeout = Number(cfg?.context?.soccer?.timeout_ms ?? 2500);

        let allGames = [];
        for (const leagueId of neededLeagues) {
          const cached = state.runtime.soccer_cache[leagueId];
          const cacheAge = cached ? (tNow - (cached.ts || 0)) : Infinity;

          if (cacheAge < soccerFetchInterval && Array.isArray(cached.games)) {
            allGames.push(...cached.games);
            bumpBucket("health", `soccer_cache_hit:${leagueId}`, 1);
          } else {
            try {
              const games = await fetchSoccerScoreboard(leagueId, { timeout_ms: soccerTimeout });
              state.runtime.soccer_cache[leagueId] = { ts: tNow, games };
              allGames.push(...games);
              bumpBucket("health", `soccer_fetch_ok:${leagueId}`, 1);
            } catch (err) {
              // Fail closed: no data = no trades
              bumpBucket("health", `soccer_fetch_fail:${leagueId}`, 1);
            }
          }
        }

        // Match and derive context for each soccer market
        for (const m of soccerMarkets) {
          bumpBucket("health", "soccer_match_attempt", 1);

          const match = matchMarketToGame(m, allGames);

          if (!match.matched) {
            bumpBucket("health", `soccer_match_fail:${match.reasons?.[0] || "unknown"}`, 1);
            m.soccer_context = { state: "unknown", confidence: "low", match_reasons: match.reasons };
            continue;
          }

          // Derive yes_outcome_name for context
          let yesOutcomeName = null;
          const outcomes = Array.isArray(m.outcomes) ? m.outcomes : null;
          const clobIds = Array.isArray(m.tokens?.clobTokenIds) ? m.tokens.clobTokenIds : null;
          const yesId = m.tokens?.yes_token_id;
          if (outcomes && clobIds && yesId && outcomes.length === 2 && clobIds.length === 2) {
            const yesIdx = clobIds.findIndex(x => String(x) === String(yesId));
            if (yesIdx >= 0) yesOutcomeName = String(outcomes[yesIdx]);
          }

          const ctx = deriveSoccerContext(
            { ...m, entry_outcome_name: yesOutcomeName },
            match,
            tNow,
          );

          m.soccer_context = ctx;

          // Run the bloqueante gate
          const soccerCfg = cfg?.soccer || {};
          const gate = checkSoccerEntryGate({
            period: ctx.period,
            minutesLeft: ctx.minutes_left,
            marginForYes: ctx.margin_for_yes,
            confidence: ctx.confidence,
            lastScoreChangeAgoSec: ctx.lastScoreChangeAgoSec,
            minWinProbMargin2: Number(soccerCfg.win_prob_margin2 ?? 0.97),
            minWinProbMargin3: Number(soccerCfg.win_prob_margin3 ?? 0.95),
            maxMinutesMargin2: Number(soccerCfg.max_minutes_left ?? 15),
            maxMinutesMargin3: Number(soccerCfg.max_minutes_left_3goals ?? 20),
            scoreChangeCooldownSec: Number(soccerCfg.cooldown_seconds ?? 90),
          });

          m.context_entry = {
            yes_outcome_name: yesOutcomeName,
            margin_for_yes: ctx.margin_for_yes,
            win_prob: gate.win_prob,
            entry_allowed: gate.allowed,
            entry_blocked_reason: gate.allowed ? null : gate.reason,
          };

          bumpBucket("health", "context_entry_evaluated:soccer", 1);
          if (gate.allowed) {
            bumpBucket("health", "context_entry_allowed:soccer", 1);
          } else {
            bumpBucket("health", "context_entry_blocked:soccer", 1);
            bumpBucket("health", `context_entry_blocked_reason:soccer:${gate.reason}`, 1);
          }
        }
      }
    }
  }

  // --- evaluation loop ---
  let changed = false;
  const pendingWinMs = Number(cfg?.polling?.pending_window_seconds || 6) * 1000;
  let createdPendingThisTick = false;
  const enteredPendingThisTick = new Set();

  // Universe A: price updates (watching, pending_signal, signaled)
  
  // === GAMMA LIVE PROTECTION ===
  // Markets that Gamma reports as live should NOT be purged by TTL or gates.
  // Uses rolling cache (current + previous cycle) for fault tolerance.
  // Freshness: only trust if snapshot is <90s old (3x gamma_discovery_seconds).
  // Safety cap: if market has been "live but degraded" for >2h, allow purge anyway.
  const GAMMA_LIVE_MAX_STALE_MS = 90000; // 90s (3x 30s gamma interval)
  const GAMMA_LIVE_MAX_PROTECT_MS = 2 * 60 * 60 * 1000; // 2h cap
  const gammaSnapshot = state.runtime?.gamma_live_snapshot;
  const gammaSnapshotFresh = gammaSnapshot && (now - gammaSnapshot.ts) < GAMMA_LIVE_MAX_STALE_MS;
  
  // Build merged live set (current + previous cycle)
  const gammaLiveSet = new Set();
  if (gammaSnapshotFresh) {
    for (const id of (gammaSnapshot.ids || [])) gammaLiveSet.add(id);
    for (const id of (gammaSnapshot.prev_ids || [])) gammaLiveSet.add(id);
  }

  // WS activity threshold: if no WS update for this token in 10min, Gamma "live" is stale
  const WS_ACTIVITY_THRESHOLD_MS = Number(cfg?.purge?.ws_activity_threshold_ms || 600000);
  // Check WS global health: if WS is down, don't penalize individual markets
  const wsHealthy = wsClient?.isConnected === true;

  function isGammaLiveProtected(m) {
    if (!gammaSnapshotFresh) return false;
    if (!gammaLiveSet.has(m.conditionId)) return false;
    
    // Safety cap: don't protect forever if market is stuck degraded
    const expiredAt = m.expired_at_ts || 0;
    if (expiredAt && (now - expiredAt) > GAMMA_LIVE_MAX_PROTECT_MS) return false;
    
    // WS activity check: if WS is healthy but token has no recent activity, market is dead
    // If WS is unhealthy or token is missing, stay conservative (keep protection)
    if (wsHealthy) {
      const yesToken = m.tokens?.yes_token_id;
      if (yesToken) {
        const wsPrice = wsClient.getPrice(yesToken);
        if (wsPrice) {
          const wsAge = now - wsPrice.lastUpdate;
          if (wsAge > WS_ACTIVITY_THRESHOLD_MS) {
            bumpBucket("health", "gamma_live_unprotected_ws_stale", 1);
            return false; // WS healthy, token exists, but no activity → dead market
          }
        }
        // wsPrice null = never received WS data for this token
        // Could be newly subscribed — stay conservative, keep protection
      }
      // No token = data incomplete — stay conservative, keep protection
    }
    // WS unhealthy = can't judge — stay conservative, keep protection
    
    return true;
  }

  // === PURGE EXPIRED TTL ===
  // For only_live strategy: purge expired/resolved markets older than X hours
  // This keeps the watchlist fresh and prevents accumulation of stale entries
  const expiredTtlMinutes = Number(cfg?.purge?.expired_ttl_minutes ?? (Number(cfg?.purge?.expired_ttl_hours || 0) * 60) || 30);
  const expiredTtlMs = expiredTtlMinutes * 60 * 1000;
  const expiredTtlHours = expiredTtlMinutes / 60;
  let expiredPurgedCount = 0;
  
  for (const [key, m] of Object.entries(state.watchlist || {})) {
    const isExpiredOrResolved = (m.status === "expired" || m.status === "resolved");
    if (!isExpiredOrResolved) continue;

    // Determine age timestamp (use expired_at_ts, resolved_at, or fallback to last_update)
    const ageTs = m.expired_at_ts || m.resolved_at || m.last_price?.updated_ts || null;
    
    if (ageTs == null) {
      // Missing timestamp: backfill with now so it purges after TTL
      m.expired_at_ts = now;
      bumpBucket("health", "expired_ttl_backfilled_timestamp", 1);
      continue;
    }

    // Sanity: future timestamp (clock skew/bad data) → don't purge
    if (ageTs > now) {
      bumpBucket("health", "expired_ttl_future_timestamp", 1);
      continue;
    }

    const ageHours = (now - ageTs) / (1000 * 60 * 60);
    
    if (ageHours > expiredTtlHours) {
      // Live event protection: don't TTL-purge if Gamma says it's still live
      if (isGammaLiveProtected(m)) {
        bumpBucket("health", "ttl_purge_blocked_live", 1);
        continue;
      }
      
      delete state.watchlist[key];
      expiredPurgedCount++;
      bumpBucket("health", "expired_purged_ttl", 1);
      bumpBucket("health", `expired_purged_ttl:${m.league}`, 1);
      console.log(`[PURGE_EXPIRED] ${m.slug} | age=${ageHours.toFixed(1)}h | status=${m.status}`);
    }
  }

  if (expiredPurgedCount > 0) {
    state.runtime.health.expired_purged_ttl_count = (state.runtime.health.expired_purged_ttl_count || 0) + expiredPurgedCount;
    state.runtime.health.expired_purged_ttl_last_cycle = expiredPurgedCount;
  }

  // === PURGE BY TERMINAL PRICE ===
  // If WS shows price ≥0.995 on one side, market is decided → purge
  // Anti-flicker: require terminal price for ≥30 seconds before purging
  // Safety: NEVER purge if there's an open paper position (let resolution tracker handle it)
  const TERMINAL_THRESHOLD = 0.995;
  const TERMINAL_CONFIRM_MS = 30000; // 30s anti-flicker window
  let terminalPurgedCount = 0;

  // Load open paper positions to check exclusion
  let openPaperSlugs;
  try {
    const { loadOpenIndex } = await import("../core/journal.mjs");
    const idx = loadOpenIndex();
    openPaperSlugs = new Set(Object.values(idx.open || {}).map(p => p.slug));
  } catch {
    openPaperSlugs = new Set();
  }

  for (const [key, m] of Object.entries(state.watchlist || {})) {
    // Skip non-expired/non-watching (signaled markets need resolution tracker first)
    if (m.status !== "expired" && m.status !== "watching") continue;

    // STRICT EXCLUSION: never purge if paper position is open
    if (openPaperSlugs.has(m.slug)) continue;

    // Check WS cache for terminal price
    const yesToken = m.tokens?.yes_token_id;
    if (!yesToken) continue;

    const wsPrice = wsClient.getPrice(yesToken);
    if (!wsPrice) continue;

    const isTerminal = (wsPrice.bestBid >= TERMINAL_THRESHOLD) || (wsPrice.bestAsk <= (1 - TERMINAL_THRESHOLD));
    if (!isTerminal) {
      // Reset confirmation timer if price drops back
      if (m._terminal_first_seen_ts) delete m._terminal_first_seen_ts;
      continue;
    }

    // Anti-flicker: track first time we saw terminal price
    if (!m._terminal_first_seen_ts) {
      m._terminal_first_seen_ts = now;
      continue; // First sighting — wait for confirmation
    }

    const terminalAge = now - m._terminal_first_seen_ts;
    if (terminalAge < TERMINAL_CONFIRM_MS) continue; // Not confirmed yet

    // Confirmed terminal for ≥30s → purge
    delete state.watchlist[key];
    terminalPurgedCount++;
    bumpBucket("health", "purged_terminal_price", 1);
    bumpBucket("health", `purged_terminal_price:${m.league}`, 1);
    console.log(`[PURGE_TERMINAL] ${m.slug} | bid=${wsPrice.bestBid.toFixed(4)} ask=${wsPrice.bestAsk.toFixed(4)} | confirmed=${Math.round(terminalAge/1000)}s | status=${m.status}`);
  }

  if (terminalPurgedCount > 0) {
    state.runtime.health.terminal_purged_count = (state.runtime.health.terminal_purged_count || 0) + terminalPurgedCount;
  }

  // Universe B: signal pipeline (only watching, pending_signal)
  const priceUpdateUniverse = selectPriceUpdateUniverse(state, cfg);
  const pipelineUniverse = new Set(selectPipelineUniverse(state, cfg).map(m => m.conditionId || m.slug));

  for (const m of priceUpdateUniverse) {
    const tNow = Date.now();
    
    // Determine if this market should enter signal pipeline (Universe B)
    // Note: pipelineUniverse already filters by status (watching, pending_signal only)
    const inPipeline = pipelineUniverse.has(m.conditionId || m.slug);

    const startedPending = (m.status === "pending_signal");
    const recordPendingConfirmFail = (reason) => {
      if (!startedPending) return;
      health.pending_confirm_fail_by_reason_last_cycle[reason] = (health.pending_confirm_fail_by_reason_last_cycle[reason] || 0) + 1;
      bumpBucket("health", `pending_confirm_fail:${reason}`, 1);
      m.pending_confirm_fail_last_reason = reason;
      m.pending_confirm_fail_last_ts = tNow;
    };

    // === PURGE GATES ===
    // Purge markets in 'watching' status that have sustained tradeability issues
    // Rule A: Book stale (15 min) → purge
    // Rule B: Quote incomplete (10 min) → purge
    // Rule C: Double condition: spread > max AND depth insufficient (12 min) → purge
    if (m.status === "watching" && m.purge_gates) {
      const gates = m.purge_gates;
      const staleBookMin = Number(cfg?.purge?.stale_book_minutes || 15);
      const staleQuoteMin = Number(cfg?.purge?.stale_quote_incomplete_minutes || 10);
      const staleTradeMin = Number(cfg?.purge?.stale_tradeability_minutes || 12);

      const bookStaleSec = gates.last_book_update_ts ? (tNow - gates.last_book_update_ts) / 1000 : null;
      const quoteStaleSec = gates.first_incomplete_quote_ts ? (tNow - gates.first_incomplete_quote_ts) / 1000 : null;
      const tradeStaleSec = gates.first_bad_tradeability_ts ? (tNow - gates.first_bad_tradeability_ts) / 1000 : null;

      let purgeReason = null;
      let purgeDetail = {};

      // Rule A: Book stale
      if (bookStaleSec != null && bookStaleSec > staleBookMin * 60) {
        purgeReason = "purge_book_stale";
        purgeDetail = { stale_minutes: (bookStaleSec / 60).toFixed(1) };
      }
      // Rule B: Quote incomplete
      else if (quoteStaleSec != null && quoteStaleSec > staleQuoteMin * 60) {
        purgeReason = "purge_quote_incomplete";
        purgeDetail = { stale_minutes: (quoteStaleSec / 60).toFixed(1) };
      }
      // Rule C: Tradeability degraded (both spread and depth fail)
      else if (tradeStaleSec != null && tradeStaleSec > staleTradeMin * 60) {
        purgeReason = "purge_tradeability_degraded";
        purgeDetail = { stale_minutes: (tradeStaleSec / 60).toFixed(1) };
      }

      if (purgeReason) {
        // Live event protection: don't expire if Gamma says it's still live
        if (isGammaLiveProtected(m)) {
          bumpBucket("health", "purge_blocked_live", 1);
          bumpBucket("health", `purge_blocked_live:${purgeReason}`, 1);
          // Reset purge gate timers so we re-evaluate fresh next cycle
          if (m.purge_gates) {
            if (purgeReason === "purge_book_stale") m.purge_gates.last_book_update_ts = tNow;
            if (purgeReason === "purge_quote_incomplete") m.purge_gates.first_incomplete_quote_ts = null;
            if (purgeReason === "purge_tradeability_degraded") m.purge_gates.first_bad_tradeability_ts = null;
          }
          // Don't expire — continue evaluation
        } else {
          m.status = "expired";
          m.expired_at_ts = tNow;
          m.expired_reason = purgeReason;
          m.purge_detail = purgeDetail;
          bumpBucket("health", purgeReason, 1);
          bumpBucket("health", `purge:${m.league}:${purgeReason}`, 1);
          
          // Log purge event with full diagnostics
          const lastPrice = m.last_price || {};
          console.log(`[PURGE] ${purgeReason} | ${m.slug} | ${purgeDetail.stale_minutes}min | spread=${lastPrice.spread?.toFixed(4)} ask=${lastPrice.yes_best_ask?.toFixed(4)} bid=${lastPrice.yes_best_bid?.toFixed(4)} | depth_bid=$${m.liquidity?.exit_depth_usd_bid?.toFixed(0)} depth_ask=$${m.liquidity?.entry_depth_usd_ask?.toFixed(0)}`);
          
          continue; // Skip further processing
        }
      }
    }

    m.tokens = m.tokens || {};

    // Esports series guard (tag-only): compute and persist derived context for audit.
    // NOTE: counters are only for match_series.
    if (m.league === "esports" && m.esports_ctx && typeof m.esports_ctx === "object") {
      m.esports_ctx.derived = computeEsportsDerived(m, cfg);
      if (String(m.market_kind || "") === "match_series") {
        bumpBucket("health", "esports_series_guard_eval", 1);
        const st = String(m.esports_ctx.derived?.guard_status || "unknown");
        const rs = String(m.esports_ctx.derived?.guard_reason || "unknown");
        bumpBucket("health", `esports_series_guard_status:${st}`, 1);
        bumpBucket("health", `esports_series_guard_reason:${rs}`, 1);
      }
    }

    // Pending timeout MUST be evaluated independently (before Stage 1/2)
    if (m.status === "pending_signal") {
      const ps = Number(m.pending_since_ts || 0);
      const dl = Number(m.pending_deadline_ts || 0);

      if (!ps || !Number.isFinite(ps)) {
        // conservative auto-fix: invalid pending timestamp
        health.pending_integrity_fix_count = (health.pending_integrity_fix_count || 0) + 1;
        bumpBucket("health", "pending_integrity_fix", 1);
        setReject(m, "pending_integrity_fix");
        m.status = "watching";
        delete m.pending_since_ts;
        delete m.pending_deadline_ts;
        changed = true;
        continue;
      }

      const deadline = (dl && Number.isFinite(dl)) ? dl : (ps + pendingWinMs);
      if (deadline <= tNow) {
        // timeout: back to watching
        health.pending_timeout_count = (health.pending_timeout_count || 0) + 1;
        bumpBucket("health", "pending_timeout", 1);

        if (enteredPendingThisTick.has(String(m.slug || ""))) {
          bumpBucket("health", "pending_enter_then_timeout_same_tick", 1);
        }

        // Persist last_pending_timeout snapshot (runtime)
        const lp_timeout = m.last_price || {};
        state.runtime.last_pending_timeout = {
          ts: tNow,
          slug: String(m.slug || ""),
          conditionId: String(m.conditionId || ""),
          pending_since_ts: Number(ps),
          pending_deadline_ts: Number(deadline),
          remaining_ms_at_timeout: Math.max(0, Number(deadline) - tNow),
          last_reason_before_timeout: String(m.last_reject?.reason || "-")
        };

        // Log timeout for future outcome analysis (was this a good or bad filter?)
        try {
          const { appendJsonl } = await import("../core/journal.mjs");
          appendJsonl("state/journal/signals.jsonl", {
            type: "signal_timeout",
            runner_id: process.env.SHADOW_ID || "prod",
            ts: tNow,
            slug: String(m.slug || ""),
            conditionId: String(m.conditionId || ""),
            league: String(m.league || ""),
            market_kind: String(m.market_kind || ""),
            entry_bid_at_pending: Number(m.pending_entry_bid || lp_timeout.yes_best_bid || 0),
            bid_at_timeout: Number(lp_timeout.yes_best_bid || 0),
            ask_at_timeout: Number(lp_timeout.yes_best_ask || 0),
            spread_at_timeout: Number(lp_timeout.spread || 0),
            pending_duration_ms: tNow - Number(ps),
            timeout_reason: String(m.pending_confirm_fail_last_reason || m.last_reject?.reason || "unknown"),
          });
        } catch {}

        setReject(m, "pending_timeout");
        m.status = "watching";
        delete m.pending_since_ts;
        delete m.pending_deadline_ts;
        changed = true;
        continue;
      }

      // pending second-check observability
      bumpBucket("health", "pending_second_check", 1);
      const ageMs = Math.max(0, tNow - ps);
      bumpBucket("health", "pending_age_sum_ms", ageMs);
      bumpBucket("health", "pending_age_count", 1);
    }

    const yesToken = m.tokens.yes_token_id;
    if (yesToken == null) {
      health.reject_counts_last_cycle.gamma_metadata_missing = (health.reject_counts_last_cycle.gamma_metadata_missing || 0) + 1;
      bumpBucket("reject", "gamma_metadata_missing", 1);
      bumpBucket("reject", `reject_by_league:${m.league}:gamma_metadata_missing`, 1);
      setReject(m, "gamma_metadata_missing");
      // integrity: pending should never be missing tokens; don't classify as confirm fail reason
      if (startedPending) health.pending_confirm_integrity_missing_yes_token_count = (health.pending_confirm_integrity_missing_yes_token_count || 0) + 1;
      continue;
    }

    // Dynamic subscription: subscribe to YES/NO tokens via WebSocket
    const noToken = m.tokens.no_token_id;
    const tokensToSubscribe = [yesToken];
    if (noToken) tokensToSubscribe.push(noToken);
    wsClient.subscribe(tokensToSubscribe);

    // Reason A: need usable price (WS primary, HTTP fallback)
    // Try WebSocket first (real-time, zero HTTP overhead)
    const wsMaxStaleSec = Number(cfg?.ws?.max_stale_seconds ?? 10);
    let bestAskFromSource = null;
    let bestBidFromSource = null;
    let priceSource = null;

    const wsYes = wsClient.getPrice(yesToken);
    const wsNo = noToken ? wsClient.getPrice(noToken) : null;
    
    const wsYesFresh = wsYes && ((tNow - wsYes.lastUpdate) < wsMaxStaleSec * 1000);
    const wsNoFresh = wsNo && ((tNow - wsNo.lastUpdate) < wsMaxStaleSec * 1000);

    // WS as primary source: use if YES token has fresh data
    // (NO token is optional for complementary pricing)
    if (wsYesFresh) {
      if (wsNoFresh) {
        // Both tokens fresh: use complementary pricing
        bestAskFromSource = Math.min(wsYes.bestAsk, 1 - wsNo.bestBid);
        bestBidFromSource = Math.max(wsYes.bestBid, 1 - wsNo.bestAsk);
        priceSource = "ws_both";
        bumpBucket("health", "price_source_ws_both", 1);
      } else {
        // Only YES fresh: use YES prices directly
        bestAskFromSource = wsYes.bestAsk;
        bestBidFromSource = wsYes.bestBid;
        priceSource = "ws_yes_only";
        bumpBucket("health", "price_source_ws_yes", 1);
      }
    } else {
      // WS stale or missing: fallback to HTTP
      priceSource = "http_fallback";
      bumpBucket("health", "price_source_http_fallback", 1);
      
      // Distinguish cache_miss vs stale for diagnosis
      if (!wsYes) {
        bumpBucket("health", "price_source_http_fallback_cache_miss", 1);
      } else {
        // wsYes exists but !wsYesFresh
        bumpBucket("health", "price_source_http_fallback_stale", 1);
      }
    }

    // HTTP fallback if WS didn't provide usable prices
    let respYes = { ok: false };
    let respNo = { ok: false };
    
    if (priceSource === "http_fallback") {
      respYes = await queue.enqueue(() => getBook(yesToken, cfg), { reason: "price" });
      respNo = noToken ? await queue.enqueue(() => getBook(noToken, cfg), { reason: "price" }) : { ok: false };
    }
    
    // Process HTTP fallback if used
    let bestAsk = bestAskFromSource;
    let bestBid = bestBidFromSource;
    let parsedYes = { ok: false };

    if (priceSource === "http_fallback") {
      if (!respYes.ok && !respNo.ok) {
        // HTTP failed
        if (respYes.http_status === 429 || respYes.error_code === "http_429") {
          health.rate_limited_count = (health.rate_limited_count || 0) + 1;
          health.last_rate_limited_ts = now;
        }
        health.http_fallback_fail_count = (health.http_fallback_fail_count || 0) + 1;
        health.reject_counts_last_cycle.http_fallback_failed = (health.reject_counts_last_cycle.http_fallback_failed || 0) + 1;
        bumpBucket("reject", "http_fallback_failed", 1);
        bumpBucket("reject", `reject_by_league:${m.league}:http_fallback_failed`, 1);

        const r = "http_fail";
        health.http_fallback_fail_by_reason_last_cycle[r] = (health.http_fallback_fail_by_reason_last_cycle[r] || 0) + 1;
        bumpBucket("reject", `http_fallback_failed:${r}`, 1);
        bumpBucket("reject", `reject_by_league:${m.league}:http_fallback_failed:${r}`, 1);

        setReject(m, "http_fallback_failed", { detail: r });
        recordPendingConfirmFail("fail_http_fallback_failed");
        continue;
      }

      health.http_fallback_success_count = (health.http_fallback_success_count || 0) + 1;

      // Parse both books
      parsedYes = respYes.ok ? parseAndNormalizeBook(respYes.rawBook, cfg, health) : { ok: false, reason: "no_yes_book" };
      const parsedNo = respNo.ok ? parseAndNormalizeBook(respNo.rawBook, cfg, health) : { ok: false, reason: "no_no_book" };

      if (!parsedYes.ok && !parsedNo.ok) {
        health.http_fallback_fail_count = (health.http_fallback_fail_count || 0) + 1;
        health.reject_counts_last_cycle.http_fallback_failed = (health.reject_counts_last_cycle.http_fallback_failed || 0) + 1;
        bumpBucket("reject", "http_fallback_failed", 1);
        bumpBucket("reject", `reject_by_league:${m.league}:http_fallback_failed`, 1);

        const r = String(parsedYes.reason || "book_not_usable");
        health.http_fallback_fail_by_reason_last_cycle[r] = (health.http_fallback_fail_by_reason_last_cycle[r] || 0) + 1;
        bumpBucket("reject", `http_fallback_failed:${r}`, 1);
        bumpBucket("reject", `reject_by_league:${m.league}:http_fallback_failed:${r}`, 1);

        setReject(m, "http_fallback_failed", { detail: r });
        recordPendingConfirmFail("fail_http_fallback_failed");
        continue;
      }

      // Construct best ask/bid with complementary pricing logic (HTTP path)
      const yesBookAsk = parsedYes.ok ? parsedYes.book.bestAsk : null;
      const yesBookBid = parsedYes.ok ? parsedYes.book.bestBid : null;
      const noBookBid = parsedNo.ok ? parsedNo.book.bestBid : null;
      const noBookAsk = parsedNo.ok ? parsedNo.book.bestAsk : null;

      // Synthetic prices from NO book (complement)
      const yesSyntheticAsk = noBookBid != null ? (1 - noBookBid) : null;
      const yesSyntheticBid = noBookAsk != null ? (1 - noBookAsk) : null;

      // Choose best prices (min for ask, max for bid)
      if (yesBookAsk != null && yesSyntheticAsk != null) {
        bestAsk = Math.min(yesBookAsk, yesSyntheticAsk);
      } else {
        bestAsk = yesBookAsk ?? yesSyntheticAsk;
      }

      if (yesBookBid != null && yesSyntheticBid != null) {
        bestBid = Math.max(yesBookBid, yesSyntheticBid);
      } else {
        bestBid = yesBookBid ?? yesSyntheticBid;
      }

      // Observability: log when synthetic prices are used
      if (bestAsk != null && yesBookAsk == null && yesSyntheticAsk != null) {
        bumpBucket("health", "price_synthetic_ask_used", 1);
      }
      if (bestBid != null && yesBookBid == null && yesSyntheticBid != null) {
        bumpBucket("health", "price_synthetic_bid_used", 1);
      }
    } else {
      // WS path: prices already computed, need parsedYes for depth checks later
      // Create a mock parsedYes with empty book (depth will come from HTTP if needed)
      parsedYes = { ok: true, book: { bids: [], asks: [], bestBid, bestAsk } };
    }

    // Quote usability gate (v1 strict): need BOTH bestAsk + bestBid to compute spread and evaluate Stage 1.
    if (bestAsk == null || bestBid == null) {
      // Track incomplete quote gate for purge
      if (!m.purge_gates) {
        m.purge_gates = {
          first_incomplete_quote_ts: tNow,
          first_bad_tradeability_ts: null,
          last_book_update_ts: tNow
        };
      } else if (m.purge_gates.first_incomplete_quote_ts == null) {
        m.purge_gates.first_incomplete_quote_ts = tNow;
      }

      // primary reject
      health.reject_counts_last_cycle.quote_incomplete_one_sided_book = (health.reject_counts_last_cycle.quote_incomplete_one_sided_book || 0) + 1;
      bumpBucket("reject", "quote_incomplete_one_sided_book", 1);
      bumpBucket("reject", `reject_by_league:${m.league}:quote_incomplete_one_sided_book`, 1);

      // subreason (health)
      if (bestAsk == null) {
        health.quote_incomplete_missing_best_ask_count = (health.quote_incomplete_missing_best_ask_count || 0) + 1;
        health.quote_incomplete_missing_best_ask_last_cycle = (health.quote_incomplete_missing_best_ask_last_cycle || 0) + 1;
        bumpBucket("health", "quote_incomplete_missing_best_ask", 1);
        bumpBucket("reject", `reject_by_league:${m.league}:quote_incomplete_missing_best_ask`, 1);
      }
      if (bestBid == null) {
        health.quote_incomplete_missing_best_bid_count = (health.quote_incomplete_missing_best_bid_count || 0) + 1;
        health.quote_incomplete_missing_best_bid_last_cycle = (health.quote_incomplete_missing_best_bid_last_cycle || 0) + 1;
        bumpBucket("health", "quote_incomplete_missing_best_bid", 1);
        bumpBucket("reject", `reject_by_league:${m.league}:quote_incomplete_missing_best_bid`, 1);
      }
      if (bestAsk == null && bestBid == null) {
        health.quote_incomplete_integrity_both_missing_count = (health.quote_incomplete_integrity_both_missing_count || 0) + 1;
        bumpBucket("health", "quote_incomplete_integrity_both_missing", 1);
        bumpBucket("reject", `reject_by_league:${m.league}:quote_incomplete_integrity_both_missing`, 1);
      }

      setReject(m, "quote_incomplete_one_sided_book", {
        detail: (bestAsk == null && bestBid == null) ? "missing_best_ask+missing_best_bid" : (bestAsk == null ? "missing_best_ask" : "missing_best_bid")
      });
      recordPendingConfirmFail("fail_quote_incomplete");

      // still persist partial last_price for observability
      {
        const prevTs = Number(m.last_price?.updated_ts || 0);
        m.last_price = {
          yes_best_ask: bestAsk ?? null,
          yes_best_bid: bestBid ?? null,
          spread: null,
          updated_ts: tNow,
          source: "http"
        };
        if (!prevTs || prevTs !== now) bumpBucket("health", "quote_update", 1);
      }
      continue;
    }

    // Health: quote is complete (bid+ask) at parse level
    bumpBucket("health", "quote_complete", 1);
    bumpBucket("health", `quote_complete:${m.league}`, 1);

    const quote = { probAsk: bestAsk, probBid: bestBid, spread: bestAsk - bestBid };

    // Initialize purge_gates if needed
    if (!m.purge_gates) {
      m.purge_gates = {
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: null,
        last_book_update_ts: tNow
      };
    }

    // Update last_book_update_ts (book was successfully fetched and parsed)
    m.purge_gates.last_book_update_ts = tNow;

    // Reset incomplete quote gate (quote is complete now)
    m.purge_gates.first_incomplete_quote_ts = null;

    // persist last_price snapshot
    {
      const prevTs = Number(m.last_price?.updated_ts || 0);
      m.last_price = {
        yes_best_ask: bestAsk,
        yes_best_bid: bestBid,
        spread: quote.spread,
        updated_ts: tNow,
        source: "http"
      };
      if (!prevTs || prevTs !== now) bumpBucket("health", "quote_update", 1);

      // Terminal price check via HTTP (catches markets without WS data)
      if (bestBid >= 0.995 && m.status === "watching") {
        m.status = "expired";
        m.expired_at_ts = tNow;
        m.expired_reason = "terminal_price_http";
        bumpBucket("health", "expired_terminal_http", 1);
        console.log(`[TERMINAL_HTTP] ${m.slug} | bid=${bestBid.toFixed(3)} → expired`);
        continue;
      }
    }

    // --- Context snapshot for win_prob validation (throttled) ---
    // Captures ask/bid/win_prob for in-game markets across ALL price levels (0.80-0.98)
    // for post-hoc model calibration and mispricing analysis.
    {
      const ce = m.context_entry;
      // Soccer uses m.soccer_context, CBB/NBA use m.context
      const ctx = m.league === "soccer" ? m.soccer_context : m.context;
      const ctxState = ctx?.state;
      const minutesLeft = ctx?.minutes_left;
      const wp = ce?.win_prob;

      // Soccer: wider window (minutes_left <= 15 for margin=2, <= 20 for margin>=3)
      const snapshotMaxMin = m.league === "soccer" ? 20 : 8;

      // Conditions: in-game, has win_prob, minutes_left <= threshold, ask in [0.80, 0.98]
      if (ctxState === "in" && wp != null && minutesLeft != null && minutesLeft <= snapshotMaxMin &&
          bestAsk >= 0.80 && bestAsk <= 0.98) {
        // Throttle: max 1 snapshot per market per 30s
        const lastSnap = Number(m._last_ctx_snapshot_ts || 0);
        if (!lastSnap || (tNow - lastSnap) >= 30000) {
          m._last_ctx_snapshot_ts = tNow;
          appendJsonl("state/journal/context_snapshots.jsonl", {
            ts: tNow,
            league: m.league,
            event_id: m.event_id || m.event_slug || null,
            conditionId: m.conditionId || null,
            slug: m.slug,
            yes_outcome_name: ce.yes_outcome_name ?? null,
            ask: bestAsk,
            bid: bestBid,
            spread: Number((bestAsk - bestBid).toFixed(4)),
            win_prob: wp,
            ev_edge: Number((wp - bestAsk).toFixed(4)),
            margin_for_yes: ce.margin_for_yes ?? null,
            minutes_left: minutesLeft,
            period: ctx.period ?? null,
            win_prob_model: m.league === "soccer" ? "poisson" : "normal",
            confidence: m.league === "soccer" ? (ctx?.confidence ?? null) : null,
            schema_version: 2,
          });
          bumpBucket("health", "context_snapshot_written", 1);
          bumpBucket("health", `context_snapshot_written:${m.league}`, 1);
        }
      }
    }

    // === PIPELINE GATE ===
    // Markets with status=signaled stop here: price update done, skip stage1/stage2/state_machine
    // Spec requirement: "signaled behavior under fluctuations: update last_price/liquidity for visibility"
    if (!inPipeline) {
      // Price update completed for signaled market, skip pipeline
      continue;
    }

    // --- Soccer BLOQUEANTE gate ---
    // For soccer markets, the context entry gate is MANDATORY (not tag-only).
    // If the gate hasn't explicitly allowed entry, skip the entire eval pipeline.
    if (m.league === "soccer") {
      const soccerAllowed = m.context_entry?.entry_allowed === true;
      if (!soccerAllowed) {
        const reason = m.context_entry?.entry_blocked_reason || "no_soccer_context";
        bumpBucket("reject", `soccer_gate_blocked:${reason}`, 1);
        bumpBucket("reject", `reject_by_league:soccer:soccer_gate_blocked`, 1);
        setReject(m, `soccer_gate:${reason}`);
        if (startedPending) recordPendingConfirmFail(`soccer_gate:${reason}`);
        continue;
      }
      bumpBucket("health", "soccer_gate_passed", 1);
    }

    // Stage 1 evaluated counter (only when quote complete and we actually run Stage 1)
    health.stage1_evaluated_count = (health.stage1_evaluated_count || 0) + 1;
    health.stage1_evaluated_last_cycle = (health.stage1_evaluated_last_cycle || 0) + 1;
    bumpBucket("health", "stage1_evaluated", 1);
    bumpBucket("health", `stage1_evaluated:${m.league}`, 1);

    // Funnel counters (health-only): computed locally, independent from reject reasons
    const EPS = Number(cfg?.filters?.EPS || 1e-6);
    const minProb = Number(cfg?.filters?.min_prob);
    const maxEntry = Number(cfg?.filters?.max_entry_price);
    const maxSpread = Number(cfg?.filters?.max_spread);

    const baseRangePass = (quote.probAsk + EPS) >= minProb && (quote.probAsk - EPS) <= maxEntry;
    const spreadPassFunnel = (quote.spread - EPS) <= maxSpread;
    if (baseRangePass) bumpBucket("health", "base_range_pass", 1);
    if (spreadPassFunnel) bumpBucket("health", "spread_pass", 1);

    // per-market Stage 1 observability
    m.stage1 = m.stage1 || {};
    m.stage1.last_eval_ts = tNow;

    // Triggered relaxed hot candidate (observability): ignore base range, require spread+near+depth
    const nearOkForRelaxed = (await Promise.resolve(is_near_signal_margin(quote, cfg)));
    if (spreadPassFunnel && nearOkForRelaxed) {
      const metricsRelax = compute_depth_metrics(parsedYes.book, cfg);
      const depthRelax = is_depth_sufficient(metricsRelax, cfg);
      if (depthRelax.pass) {
        bumpBucket("health", "hot_candidate_relaxed", 1);
        recordHotCandidateRelaxed(m, quote, metricsRelax, baseRangePass);

        // cooldown influence diagnostic: hot but blocked by cooldown (watching -> pending gate)
        if (m.status === "watching") {
          const cooldownUntil = Number(m.cooldown_until_ts || 0);
          if (cooldownUntil && tNow < cooldownUntil) {
            bumpBucket("health", "cooldown_active_while_hot", 1);
          }
        }
      }
    }

    // Lazy HTTP fetch for depth if WS was used (WS only provides best bid/ask, not full book)
    if (priceSource !== "http_fallback" && parsedYes.book.bids.length === 0 && parsedYes.book.asks.length === 0) {
      // WS was used, but we need full book for depth check → HTTP fetch now
      const respYesDepth = await queue.enqueue(() => getBook(yesToken, cfg), { reason: "depth" });
      if (respYesDepth.ok) {
        const parsedDepth = parseAndNormalizeBook(respYesDepth.rawBook, cfg, health);
        if (parsedDepth.ok) {
          parsedYes.book = parsedDepth.book;
          bumpBucket("health", "depth_http_fetch_after_ws", 1);
        }
      } else {
        bumpBucket("health", "depth_http_fetch_failed", 1);
      }
    }

    // Evaluate Stage 2 depth metrics early (before Stage 1 rejects) to track tradeability gate
    const metrics = compute_depth_metrics(parsedYes.book, cfg);
    const depth = is_depth_sufficient(metrics, cfg);
    const depthPass = depth.pass;

    // Evaluate Stage 1 (spread) for tradeability gate tracking
    const base = is_base_signal_candidate(quote, cfg);
    const spreadPass = base.pass;

    // Track or reset tradeability gate (double condition: !spreadPass && !depthPass)
    if (!spreadPass && !depthPass) {
      // Both fail: track first occurrence
      if (!m.purge_gates) {
        m.purge_gates = {
          first_incomplete_quote_ts: null,
          first_bad_tradeability_ts: tNow,
          last_book_update_ts: tNow
        };
      } else if (m.purge_gates.first_bad_tradeability_ts == null) {
        m.purge_gates.first_bad_tradeability_ts = tNow;
      }
    } else if (spreadPass || depthPass) {
      // At least one passes: reset gate
      if (m.purge_gates) {
        m.purge_gates.first_bad_tradeability_ts = null;
      }
    }

    // Stage 1 reject (spread)
    if (!base.pass) {
      health.reject_counts_last_cycle[base.reason] = (health.reject_counts_last_cycle[base.reason] || 0) + 1;
      bumpBucket("reject", base.reason, 1);
      bumpBucket("reject", `reject_by_league:${m.league}:${base.reason}`, 1);
      setReject(m, base.reason);
      if (base.reason === "price_out_of_range") recordPendingConfirmFail("fail_base_price_out_of_range");
      else if (base.reason === "spread_above_max") recordPendingConfirmFail("fail_spread_above_max");
      continue;
    }

    // Determine near_by deterministically (same policy as status.mjs):
    // near_pass = askOk OR spreadOk
    const EPS_NEAR = Number(cfg?.filters?.EPS || 1e-6);
    const nearProbMin = Number(cfg?.filters?.near_prob_min ?? 0.945);
    const nearSpreadMax = Number(cfg?.filters?.near_spread_max ?? 0.015);
    const askOkNear = (Number(quote.probAsk) + EPS_NEAR) >= nearProbMin;
    const spreadOkNear = (Number(quote.spread) - EPS_NEAR) <= nearSpreadMax;
    const near_by = (askOkNear && spreadOkNear) ? "both" : (askOkNear ? "ask" : (spreadOkNear ? "spread" : "none"));
    const near = (near_by !== "none");

    if (!near) {
      // not a reject for watching, but it IS the primary reason pending confirmation fails
      health.gray_zone_count = (health.gray_zone_count || 0) + 1;
      health.gray_zone_count_last_cycle = (health.gray_zone_count_last_cycle || 0) + 1;
      // Action 2: terminal outcome of tick
      setReject(m, "fail_near_margin");
      if (startedPending) recordPendingConfirmFail("fail_near_margin");
      continue;
    }

    bumpBucket("health", "near_margin_pass", 1);

    // Persist liquidity metrics (already computed earlier for tradeability gate)
    m.liquidity = {
      entry_depth_usd_ask: metrics.entry_depth_usd_ask,
      exit_depth_usd_bid: metrics.exit_depth_usd_bid,
      bid_levels_used: metrics.bid_levels_used,
      ask_levels_used: metrics.ask_levels_used,
      updated_ts: tNow,
      source: "http"
    };

    // Stage 2 reject (depth, already evaluated earlier)
    if (!depth.pass) {
      health.reject_counts_last_cycle[depth.reason] = (health.reject_counts_last_cycle[depth.reason] || 0) + 1;
      bumpBucket("reject", depth.reason, 1);
      bumpBucket("reject", `reject_by_league:${m.league}:${depth.reason}`, 1);
      setReject(m, depth.reason);
      if (depth.reason === "depth_bid_below_min") recordPendingConfirmFail("fail_depth_bid_below_min");
      else if (depth.reason === "depth_ask_below_min") recordPendingConfirmFail("fail_depth_ask_below_min");
      continue;
    }

    bumpBucket("health", "depth_pass", 1);

    // Triggered snapshot: passes near margin + depth in this tick
    bumpBucket("health", "hot_candidate", 1);
    recordHotCandidate(m, quote, metrics);

    // Cooldown gate (v1): blocks only watching -> pending_signal, never pending_signal -> signaled
    // Integrity counter: if we ever block pending via cooldown, something is wrong.
    if (m.status === "watching") {
      const cooldownUntil = Number(m.cooldown_until_ts || 0);
      if (cooldownUntil && tNow < cooldownUntil) {
        health.cooldown_active_count = (health.cooldown_active_count || 0) + 1;
        health.reject_counts_last_cycle.cooldown_active = (health.reject_counts_last_cycle.cooldown_active || 0) + 1;
        bumpBucket("reject", "cooldown_active", 1);
        bumpBucket("reject", `reject_by_league:${m.league}:cooldown_active`, 1);
        setReject(m, "cooldown_active");
        continue;
      }
    } else if (m.status === "pending_signal") {
      const cooldownUntil = Number(m.cooldown_until_ts || 0);
      if (cooldownUntil && tNow < cooldownUntil) {
        // should not matter for control flow; record as integrity signal
        health.pending_blocked_by_cooldown_count = (health.pending_blocked_by_cooldown_count || 0) + 1;
      }
    }

    if (m.status === "watching") {
      m.status = "pending_signal";
      // IMPORTANT: set timing at the moment of transition (real time)
      m.pending_since_ts = tNow;
      m.pending_deadline_ts = tNow + pendingWinMs;
      m.pending_entry_bid = Number(quote?.probBid || 0); // Save for timeout analysis

      // classify pending_enter by near_by (mutually exclusive)
      const pendingType = (near_by === "spread") ? "microstructure" : ((near_by === "ask" || near_by === "both") ? "highprob" : "unknown");
      bumpBucket("health", "pending_enter", 1);
      if (pendingType === "microstructure") bumpBucket("health", "pending_enter_microstructure", 1);
      if (pendingType === "highprob") bumpBucket("health", "pending_enter_highprob", 1);

      // Observability: pending_enter by market_kind (esports only; others treated as other)
      {
        const kind = (m.league === "esports") ? String(m.market_kind || "other") : "other";
        if (kind === "match_series") bumpBucket("health", "pending_enter_match_series", 1);
        else if (kind === "map_specific") bumpBucket("health", "pending_enter_map_specific", 1);
        else bumpBucket("health", "pending_enter_other", 1);
      }

      if (!m.pending_since_ts) bumpBucket("health", "pending_enter_with_null_since", 1);
      if (Number(m.pending_deadline_ts) <= tNow) bumpBucket("health", "pending_enter_with_deadline_in_past", 1);
      enteredPendingThisTick.add(String(m.slug || ""));

      // Persist last_pending_enter snapshot (runtime)
      state.runtime.last_pending_enter = {
        ts: tNow,
        slug: String(m.slug || ""),
        conditionId: String(m.conditionId || ""),
        probAsk: Number(quote.probAsk),
        probBid: Number(quote.probBid),
        spread: Number(quote.spread),
        entryDepth: Number(metrics.entry_depth_usd_ask || 0),
        exitDepth: Number(metrics.exit_depth_usd_bid || 0),
        pending_deadline_ts: Number(m.pending_deadline_ts)
      };

      setReject(m, "pending_entered");
      changed = true;
      createdPendingThisTick = true;

      // Local console alert (only when it happens)
      console.log(`[PENDING_ENTER] ts=${tNow} slug=${String(m.slug || "")} deadline_in_ms=${Math.max(0, Number(m.pending_deadline_ts) - tNow)}`);

      // Scheduling bugfix: avoid long ticks that cause immediate pending timeouts.
      // If this tick started without any pending, stop evaluating more watching markets so the next tick can confirm quickly.
      if (!startedWithPending) break;
      continue;
    }

    if (m.status === "pending_signal") {
      // at this point we already know pending is still within window (checked at top)
      m.status = "signaled";
      delete m.pending_since_ts;
      m.signals = m.signals || { signal_count: 0, last_signal_ts: null, reason: null };
      m.signals.signal_count = Number(m.signals.signal_count || 0) + 1;
      m.signals.last_signal_ts = tNow;
      m.signals.reason = "candidate_ready_confirmed";
      m.cooldown_until_ts = now + Number(cfg?.polling?.candidate_cooldown_seconds || 20) * 1000;
      bumpBucket("health", "signaled", 1);
      bumpBucket("health", "pending_promoted", 1);

      // Observability: signaled by market_kind (esports only; others treated as other)
      {
        const kind = (m.league === "esports") ? String(m.market_kind || "other") : "other";
        if (kind === "match_series") bumpBucket("health", "signaled_match_series", 1);
        else if (kind === "map_specific") bumpBucket("health", "signaled_map_specific", 1);
        else bumpBucket("health", "signaled_other", 1);
      }

      // signal_type classification (mutually exclusive, deterministic)
      const signal_type = (near_by === "spread") ? "microstructure" : ((near_by === "ask" || near_by === "both") ? "highprob" : "unknown");
      m.signal_type = signal_type;
      m.signal_ts = tNow;

      if (signal_type === "microstructure") bumpBucket("health", "signaled_microstructure", 1);
      if (signal_type === "highprob") bumpBucket("health", "signaled_highprob", 1);

      // Context cross-metric (tag-only)
      if (m.context?.decided_pass) {
        bumpBucket("health", "signaled_and_context_decided", 1);
        if (m.context?.sport === "cbb") bumpBucket("health", "signaled_and_context_cbb_decided", 1);
        if (m.context?.sport === "nba") bumpBucket("health", "signaled_and_context_nba_decided", 1);
      }

      // Esports gate dry-run (tag-only)
      // Definition matches future hard gate policy.
      let would_gate_apply = false;
      let would_gate_block = false;
      let would_gate_reason = "not_applicable";
      if (m.league === "esports" && String(m.market_kind || "") === "match_series") {
        const d = m.esports_ctx?.derived || null;
        const fmt = String(d?.series_format || "unknown");
        const thr = Number(cfg?.esports?.series_guard_threshold_high ?? 0.94);
        const ask = Number(quote.probAsk);

        if ((fmt === "bo3" || fmt === "bo5") && Number.isFinite(ask) && ask >= thr) {
          would_gate_apply = true;
          const gs = String(d?.guard_status || "unknown");
          const gr = String(d?.guard_reason || "no_derived");
          would_gate_block = (gs !== "allowed");
          would_gate_reason = would_gate_block ? gr : "allowed";

          bumpBucket("health", "esports_gate_would_apply", 1);
          if (would_gate_block) bumpBucket("health", "esports_gate_would_block", 1);
          else bumpBucket("health", "esports_gate_would_allow", 1);
          bumpBucket("health", `esports_gate_would_reason:${would_gate_reason}`, 1);
        }
      }

      // TP math dry-run (tag-only)
      // We compute it at candidate stage for rolling metrics, and also attach to the signal snapshot.
      const tp_bid = Number(cfg?.tp?.bid_target ?? 0.998);
      const tp_minProfit = Number(cfg?.tp?.min_profit_per_share ?? 0.002);
      const tp_fees = Number(cfg?.tp?.fees_roundtrip ?? 0);
      const spreadNow = Number(quote.spread);
      const entryAsk = Number(quote.probAsk);
      const maxEntryDynamic = (Number.isFinite(tp_bid) && Number.isFinite(spreadNow)) ? (tp_bid - spreadNow) : null;
      const tpMathMargin = (maxEntryDynamic != null && Number.isFinite(entryAsk)) ? (maxEntryDynamic - entryAsk - tp_fees) : null;
      const tpMathAllowed = (tpMathMargin != null && Number.isFinite(tp_minProfit)) ? (tpMathMargin >= tp_minProfit) : false;
      const tpMathReason = (tpMathMargin == null) ? "no_data" : (tpMathAllowed ? "ok" : "below_min_profit");

      bumpBucket("health", "tp_math_eval_candidates", 1);
      if (tpMathAllowed) bumpBucket("health", "tp_math_allowed_candidates", 1);
      else bumpBucket("health", "tp_math_rejected_candidates", 1);
      bumpBucket("health", `tp_math_rejected_candidates_reason:${tpMathReason}`, 1);

      // margin bucket (optional but useful)
      {
        let b = "no_data";
        if (tpMathMargin != null) {
          const x = Number(tpMathMargin);
          if (x < -0.01) b = "lt_-0.01";
          else if (x < 0) b = "-0.01_0";
          else if (x < tp_minProfit) b = `0_${tp_minProfit}`;
          else if (x < 0.01) b = `${tp_minProfit}_0.01`;
          else b = "gt_0.01";
        }
        bumpBucket("health", `tp_math_margin_bucket:${b}`, 1);
      }

      // ring buffer of last signals (runtime)
      state.runtime.last_signals = Array.isArray(state.runtime.last_signals) ? state.runtime.last_signals : [];
      // context snapshot at signal time (freshness-aware)
      const maxCtxAge = Number(cfg?.context?.cbb?.max_ctx_age_ms || 120000);
      let ctxSnapshot = null;
      if (m.context && m.context.provider === "espn" && (m.context.sport === "cbb" || m.context.sport === "nba")) {
        const fetchTs = Number(m.context.fetch_ts || 0) || null;
        const ageMs = fetchTs ? Math.max(0, tNow - fetchTs) : null;
        const fresh = (ageMs != null && ageMs <= maxCtxAge);
        ctxSnapshot = {
          provider: "espn",
          sport: String(m.context.sport),
          fetch_ts: fetchTs,
          ctx_age_ms: ageMs,
          fresh,
          decided_pass: fresh ? !!m.context.decided_pass : null,
          margin: fresh ? (m.context.margin ?? null) : null,
          minutes_left: fresh ? (m.context.minutes_left ?? null) : null,
          match_kind: m.context.match?.kind || null,
          // Win probability entry gate (from context_entry computed earlier)
          entry_gate: m.context_entry ? {
            yes_outcome_name: m.context_entry.yes_outcome_name ?? null,
            margin_for_yes: m.context_entry.margin_for_yes ?? null,
            win_prob: m.context_entry.win_prob ?? null,
            entry_allowed: m.context_entry.entry_allowed ?? null,
            entry_blocked_reason: m.context_entry.entry_blocked_reason ?? null,
            // EV edge: win_prob - ask. Positive = our model says worth more than price.
            // Used for post-hoc analysis, not for gating in v1.
            ev_edge: (m.context_entry.win_prob != null && Number.isFinite(Number(quote?.probAsk)))
              ? Number((m.context_entry.win_prob - Number(quote.probAsk)).toFixed(4))
              : null,
          } : null,
        };
      }

      // esports snapshot at signal time (tag-only)
      let esportsSnapshot = null;
      if (m.league === "esports" && m.esports_ctx && m.esports_ctx.event) {
        const d = m.esports_ctx.derived || {};
        esportsSnapshot = {
          v: 1,
          live: (m.esports_ctx.event.live === true || m.esports_ctx.event.live === false) ? !!m.esports_ctx.event.live : null,
          score_raw: m.esports_ctx.event.score_raw ?? null,
          period_raw: m.esports_ctx.event.period_raw ?? null,
          series_format: d.series_format ?? "unknown",
          maps_a: d.maps_a ?? null,
          maps_b: d.maps_b ?? null,
          leader_name: d.leader_name ?? null,
          required_wins: d.required_wins ?? null,
          yes_outcome_name: d.yes_outcome_name ?? null,
          guard_status: d.guard_status ?? "unknown",
          guard_reason: d.guard_reason ?? "unknown"
        };
      }

      state.runtime.last_signals.push({
        ts: tNow,
        slug: String(m.slug || ""),
        conditionId: String(m.conditionId || ""),
        league: String(m.league || ""),
        market_kind: (m.league === "esports") ? String(m.market_kind || "other") : null,
        signal_type,
        probAsk: Number(quote.probAsk),
        spread: Number(quote.spread),
        entryDepth: Number(metrics.entry_depth_usd_ask || 0),
        exitDepth: Number(metrics.exit_depth_usd_bid || 0),
        near_by,
        base_range_pass: (Number(quote.probAsk) + Number(cfg?.filters?.EPS || 1e-6)) >= Number(cfg?.filters?.min_prob) && (Number(quote.probAsk) - Number(cfg?.filters?.EPS || 1e-6)) <= Number(cfg?.filters?.max_entry_price),
        ctx: ctxSnapshot,
        esports: esportsSnapshot,
        would_gate_apply,
        would_gate_block,
        would_gate_reason,

        tp_bid_target: tp_bid,
        tp_min_profit_per_share: tp_minProfit,
        tp_fees_roundtrip: tp_fees,
        tp_max_entry_dynamic: maxEntryDynamic,
        tp_math_margin: tpMathMargin,
        tp_math_allowed: tpMathAllowed,
        tp_math_reason: tpMathReason
      });
      if (state.runtime.last_signals.length > 20) state.runtime.last_signals = state.runtime.last_signals.slice(-20);

      setReject(m, "signaled");
      changed = true;
    }
  }

  // --- Esports opportunity classification (tag-only, every eval tick) ---
  // Scans ALL esports in watchlist regardless of eval universe.
  // Produces rolling buckets + persisted snapshot for status display.
  {
    const tNow = Date.now();
    const esAll = Object.values(state.watchlist || {}).filter(m =>
      m && m.league === "esports" && (m.status === "watching" || m.status === "pending_signal" || m.status === "signaled")
    );

    let total = 0;
    let twoSided = 0;
    let oneSidedMissingAsk = 0;
    let oneSidedMissingBid = 0;
    let spreadAboveMax = 0;
    let priceOutOfRange = 0;
    let noQuote = 0;
    let tradeable = 0;

    const maxSpreadCfg = Number(cfg?.filters?.max_spread ?? 0.02);
    const minProbCfg = Number(cfg?.filters?.min_prob ?? 0.94);
    const maxEntryCfg = Number(cfg?.filters?.max_entry_price ?? 0.97);
    const EPS = Number(cfg?.filters?.EPS || 1e-6);

    const topMissingAsk = [];   // top 3 with highest bid where ask is null
    const topWideSpread = [];   // top 3 with largest spread

    for (const m of esAll) {
      total++;
      const lp = m.last_price;
      const ask = lp?.yes_best_ask;
      const bid = lp?.yes_best_bid;

      if (ask == null && bid == null) {
        noQuote++;
        continue;
      }

      if (ask == null) {
        oneSidedMissingAsk++;
        topMissingAsk.push({ slug: String(m.slug || ""), bid: Number(bid), kind: String(m.market_kind || "-") });
        continue;
      }

      if (bid == null) {
        oneSidedMissingBid++;
        continue;
      }

      // Two-sided from here
      twoSided++;
      const spread = Number(ask) - Number(bid);

      if (spread - EPS > maxSpreadCfg) {
        spreadAboveMax++;
        topWideSpread.push({ slug: String(m.slug || ""), ask: Number(ask), bid: Number(bid), spread, kind: String(m.market_kind || "-") });
        continue;
      }

      if ((Number(ask) + EPS) < minProbCfg || (Number(ask) - EPS) > maxEntryCfg) {
        priceOutOfRange++;
        continue;
      }

      tradeable++;
    }

    // Sort top offenders
    topMissingAsk.sort((a, b) => b.bid - a.bid);
    topWideSpread.sort((a, b) => b.spread - a.spread);

    // Rolling buckets
    bumpBucket("health", "esports_opp_total", total);
    bumpBucket("health", "esports_opp_two_sided", twoSided);
    bumpBucket("health", "esports_opp_one_sided_missing_ask", oneSidedMissingAsk);
    bumpBucket("health", "esports_opp_one_sided_missing_bid", oneSidedMissingBid);
    bumpBucket("health", "esports_opp_spread_above_max", spreadAboveMax);
    bumpBucket("health", "esports_opp_price_out_of_range", priceOutOfRange);
    bumpBucket("health", "esports_opp_no_quote", noQuote);
    bumpBucket("health", "esports_opp_tradeable", tradeable);

    // Persisted snapshot (latest tick, not rolling — for status.mjs instant read)
    state.runtime.esports_opportunity = {
      ts: tNow,
      total,
      two_sided: twoSided,
      one_sided_missing_ask: oneSidedMissingAsk,
      one_sided_missing_bid: oneSidedMissingBid,
      spread_above_max: spreadAboveMax,
      price_out_of_range: priceOutOfRange,
      no_quote: noQuote,
      tradeable,
      top_missing_ask: topMissingAsk.slice(0, 3),
      top_wide_spread: topWideSpread.slice(0, 3)
    };
  }

  // --- CBB + NBA opportunity classification (same pattern as esports) ---
  for (const league of ["cbb", "nba"]) {
    const tNow = Date.now();
    const lgAll = Object.values(state.watchlist || {}).filter(m =>
      m && m.league === league && (m.status === "watching" || m.status === "pending_signal" || m.status === "signaled")
    );

    let total = 0;
    let twoSided = 0;
    let oneSidedMissingAsk = 0;
    let oneSidedMissingBid = 0;
    let spreadAboveMax = 0;
    let priceOutOfRange = 0;
    let noQuote = 0;
    let tradeable = 0;

    const maxSpreadCfg = Number(cfg?.filters?.max_spread ?? 0.02);
    const minProbCfg = Number(cfg?.filters?.min_prob ?? 0.94);
    const maxEntryCfg = Number(cfg?.filters?.max_entry_price ?? 0.97);
    const EPS = Number(cfg?.filters?.EPS || 1e-6);

    const topMissingAsk = [];
    const topWideSpread = [];

    for (const m of lgAll) {
      total++;
      const lp = m.last_price;
      const ask = lp?.yes_best_ask;
      const bid = lp?.yes_best_bid;

      if (ask == null && bid == null) { noQuote++; continue; }
      if (ask == null) {
        oneSidedMissingAsk++;
        topMissingAsk.push({ slug: String(m.slug || ""), bid: Number(bid) });
        continue;
      }
      if (bid == null) { oneSidedMissingBid++; continue; }

      twoSided++;
      const spread = Number(ask) - Number(bid);

      if (spread - EPS > maxSpreadCfg) {
        spreadAboveMax++;
        topWideSpread.push({ slug: String(m.slug || ""), ask: Number(ask), bid: Number(bid), spread });
        continue;
      }
      if ((Number(ask) + EPS) < minProbCfg || (Number(ask) - EPS) > maxEntryCfg) {
        priceOutOfRange++;
        continue;
      }
      tradeable++;
    }

    topMissingAsk.sort((a, b) => b.bid - a.bid);
    topWideSpread.sort((a, b) => b.spread - a.spread);

    bumpBucket("health", `${league}_opp_total`, total);
    bumpBucket("health", `${league}_opp_two_sided`, twoSided);
    bumpBucket("health", `${league}_opp_one_sided_missing_ask`, oneSidedMissingAsk);
    bumpBucket("health", `${league}_opp_one_sided_missing_bid`, oneSidedMissingBid);
    bumpBucket("health", `${league}_opp_spread_above_max`, spreadAboveMax);
    bumpBucket("health", `${league}_opp_price_out_of_range`, priceOutOfRange);
    bumpBucket("health", `${league}_opp_no_quote`, noQuote);
    bumpBucket("health", `${league}_opp_tradeable`, tradeable);

    state.runtime[`${league}_opportunity`] = {
      ts: tNow,
      total,
      two_sided: twoSided,
      one_sided_missing_ask: oneSidedMissingAsk,
      one_sided_missing_bid: oneSidedMissingBid,
      spread_above_max: spreadAboveMax,
      price_out_of_range: priceOutOfRange,
      no_quote: noQuote,
      tradeable,
      top_missing_ask: topMissingAsk.slice(0, 3),
      top_wide_spread: topWideSpread.slice(0, 3)
    };
  }

  // --- Daily event utilization tracking ---
  {
    const deState = loadDailyEvents();
    const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const wl = state?.watchlist || {};

    for (const m of Object.values(wl)) {
      const league = m?.league;
      const eventId = m?.event_id || m?.event_slug;
      if (!league || !eventId) continue;
      if (!["cbb", "nba", "esports"].includes(league)) continue;

      // Determine what this market achieved in its current state
      const lp = m.last_price || {};
      const hasQuote = (lp.yes_best_ask != null && lp.yes_best_bid != null);
      const hasTwoSided = hasQuote && lp.spread != null;
      const isSignaled = (m.status === "signaled");

      // Determine reject reason (granular)
      let rejectReason = null;
      if (!hasQuote) {
        // Split "no_quote" into specific causes
        const tokenIds = m?.tokens?.clobTokenIds;
        const hasTokens = Array.isArray(tokenIds) && tokenIds.length === 2;
        const lr = m.last_reject?.reason;

        if (!hasTokens) {
          rejectReason = "no_token_resolved";
        } else if (lr === "http_fallback_failed") {
          rejectReason = "book_fetch_failed";
        } else if (lr === "gamma_metadata_missing") {
          rejectReason = "gamma_metadata_missing";
        } else if (lp.yes_best_ask == null && lp.yes_best_bid != null) {
          rejectReason = "one_sided_missing_ask";
        } else if (lp.yes_best_bid == null && lp.yes_best_ask != null) {
          rejectReason = "one_sided_missing_bid";
        } else if (lp.updated_ts) {
          // Had a price update but both sides are null → book was empty
          rejectReason = "book_empty";
        } else {
          // Never got a price at all — likely never evaluated (stale or not polled)
          rejectReason = "stale_no_eval";
        }
      } else {
        // Has two-sided quote — check pipeline reject
        const lr = m.last_reject;
        if (lr?.reason && lr.reason !== "pending_entered" && lr.reason !== "signaled") {
          rejectReason = lr.reason;
        }
      }

      // Was it tradeable? (passed base + spread + depth at some point)
      // We use a heuristic: if status is pending_signal or signaled, it was tradeable
      const wasTradeable = (m.status === "pending_signal" || m.status === "signaled");

      // Context entry gate
      const ce = m.context_entry;
      const ctxEvaluated = !!(ce && ce.win_prob != null);
      const ctxAllowed = !!(ce && ce.entry_allowed);

      recordMarketTick(deState, todayKey, {
        league,
        event_id: String(eventId),
        slug: m.slug,
        had_quote: hasQuote,
        had_two_sided: hasTwoSided,
        had_tradeable: wasTradeable,
        had_signal: isSignaled,
        reject_reason: rejectReason,
        context_entry_evaluated: ctxEvaluated,
        context_entry_allowed: ctxAllowed,
        yes_best_bid: lp.yes_best_bid ?? null,
        entry_threshold: Number(cfg?.strategy?.min_prob || 0.93),
      });
    }

    saveDailyEvents(deState);
  }

  return { changed };
}
