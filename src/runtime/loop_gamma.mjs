import { fetchLiveEvents } from "../gamma/gamma_client.mjs";
import { parseEventsToMarkets } from "../gamma/gamma_parser.mjs";
import { upsertMarket } from "../strategy/watchlist_upsert.mjs";
import { markExpired } from "../strategy/ttl_cleanup.mjs";
import { evictIfNeeded } from "../strategy/eviction.mjs";

function normalizeTokenPair(raw, health) {
  // Backfill: normalize existing string JSON in state (no network)
  if (Array.isArray(raw)) {
    const arr = raw.map(String);
    if (arr.length !== 2) {
      health.gamma_token_count_unexpected_count = (health.gamma_token_count_unexpected_count || 0) + 1;
      return [];
    }
    return arr;
  }
  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw);
      if (!Array.isArray(j)) {
        health.gamma_token_count_unexpected_count = (health.gamma_token_count_unexpected_count || 0) + 1;
        return [];
      }
      const arr = j.map(String);
      if (arr.length !== 2) {
        health.gamma_token_count_unexpected_count = (health.gamma_token_count_unexpected_count || 0) + 1;
        return [];
      }
      return arr;
    } catch {
      health.gamma_token_parse_fail_count = (health.gamma_token_parse_fail_count || 0) + 1;
      return [];
    }
  }
  if (raw == null) {
    health.gamma_token_count_unexpected_count = (health.gamma_token_count_unexpected_count || 0) + 1;
    return [];
  }
  health.gamma_token_count_unexpected_count = (health.gamma_token_count_unexpected_count || 0) + 1;
  return [];
}

export async function loopGamma(state, cfg, now) {
  state.runtime = state.runtime || {};
  state.runtime.health = state.runtime.health || {};

  const health = state.runtime.health;
  // Ensure counters exist
  health.gamma_token_parse_fail_count = health.gamma_token_parse_fail_count || 0;
  health.gamma_token_count_unexpected_count = health.gamma_token_count_unexpected_count || 0;

  // Duration is unknown until we have at least one sample.
  if (health.gamma_fetch_duration_ms_last === undefined) health.gamma_fetch_duration_ms_last = null;

  // Tag-only gamma health state (observability). No behavior changes.
  // Keep a short history of fetch outcomes and compute a simple health label.
  health.gamma_fetch_history = Array.isArray(health.gamma_fetch_history) ? health.gamma_fetch_history : [];

  // Backfill optional: normalize existing state token fields that are still strings
  for (const m of Object.values(state.watchlist || {})) {
    // Backfill deterministic esports market_kind (infra/observability)
    if (m && m.league === "esports" && (m.market_kind === undefined || m.market_kind == null)) {
      const slug = String(m.slug || "").toLowerCase();
      if (/(?:^|-)\b(game|map)\d+\b/.test(slug)) {
        m.market_kind = /-(game|map)\d+-(first-blood)\b/.test(slug) ? "other" : "map_specific";
      } else {
        m.market_kind = "match_series";
      }
    }

    m.tokens = (m && typeof m.tokens === "object" && !Array.isArray(m.tokens)) ? m.tokens : {};
    const raw = m.tokens.clobTokenIds;
    const norm = normalizeTokenPair(raw, health);
    // Always keep as array
    m.tokens.clobTokenIds = norm;
    if (m.tokens.yes_token_id === undefined) m.tokens.yes_token_id = null;
    if (m.tokens.no_token_id === undefined) m.tokens.no_token_id = null;
    if (m.tokens.resolved_by === undefined) m.tokens.resolved_by = null;
    if (m.tokens.resolved_ts === undefined) m.tokens.resolved_ts = null;
  }

  const r = await fetchLiveEvents(cfg);
  state.runtime.last_gamma_fetch_ts = now;
  state.runtime.health.gamma_fetch_count = (state.runtime.health.gamma_fetch_count || 0) + 1;
  if (r && typeof r.duration_ms === "number") state.runtime.health.gamma_fetch_duration_ms_last = Math.max(0, Number(r.duration_ms));

  // Record fetch outcome history (tag-only)
  try {
    const err = String(r?.error || "");
    const timeout = err.toLowerCase().includes("timeout");
    health.gamma_fetch_history.push({ ts: now, ok: !!r?.ok, timeout, duration_ms: (typeof r?.duration_ms === "number") ? Number(r.duration_ms) : null });
    if (health.gamma_fetch_history.length > 50) health.gamma_fetch_history = health.gamma_fetch_history.slice(-50);

    // Compute health over last 10 minutes
    const winMs = 10 * 60 * 1000;
    const recent = health.gamma_fetch_history.filter(x => (now - Number(x.ts || 0)) <= winMs);
    const n = recent.length;
    const fails = recent.filter(x => x.ok === false).length;
    const timeouts = recent.filter(x => x.timeout === true).length;
    const failRate = n ? (fails / n) : 0;
    const timeoutRate = n ? (timeouts / n) : 0;

    let stateLabel = "ok";
    if (n >= 3 && (timeoutRate >= 0.5 || fails >= 3)) stateLabel = "bad";
    else if (n >= 3 && (timeoutRate > 0 || failRate > 0.2)) stateLabel = "degraded";

    health.gamma_health_state = stateLabel;
    health.gamma_health_window = { window_ms: winMs, n, fails, timeouts, failRate, timeoutRate };
  } catch {}

  if (!r.ok) {
    state.runtime.health.gamma_fetch_fail_count = (state.runtime.health.gamma_fetch_fail_count || 0) + 1;
    state.runtime.health.gamma_last_error = r.error;
    if (String(r.error || "").toLowerCase().includes("timeout")) {
      state.runtime.health.gamma_fetch_timeout_count = (state.runtime.health.gamma_fetch_timeout_count || 0) + 1;
    }
    return { changed: false, stats: { ok: false, error: r.error } };
  }

  const parsed = parseEventsToMarkets(r.data, cfg);
  const candidates = parsed.candidates;
  // accumulate parse stats
  health.gamma_token_parse_fail_count += parsed.stats.gamma_token_parse_fail_count;
  health.gamma_token_count_unexpected_count += parsed.stats.gamma_token_count_unexpected_count;

  // --- Universe hygiene filter (infra) ---
  // Keep only markets whose endDateIso is within a configured deltaDays window per league.
  const keepMissingDate = !!cfg?.gamma?.keep_missing_date;
  const minByLeague = (cfg?.gamma?.min_days_delta_keep_by_league && typeof cfg.gamma.min_days_delta_keep_by_league === "object") ? cfg.gamma.min_days_delta_keep_by_league : {};
  const maxByLeague = (cfg?.gamma?.max_days_delta_keep_by_league && typeof cfg.gamma.max_days_delta_keep_by_league === "object") ? cfg.gamma.max_days_delta_keep_by_league : {};

  const utcDayMs = 24 * 60 * 60 * 1000;
  const nowUtcDay = (() => {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  })();

  function deltaDaysFromIso(iso) {
    if (!iso) return null;
    const d = new Date(String(iso));
    if (!Number.isFinite(d.getTime())) return null;
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.round((day - nowUtcDay) / utcDayMs);
  }

  function getWin(league) {
    const lg = String(league || "");
    const min = Object.prototype.hasOwnProperty.call(minByLeague, lg) ? Number(minByLeague[lg]) : null;
    const max = Object.prototype.hasOwnProperty.call(maxByLeague, lg) ? Number(maxByLeague[lg]) : null;
    return { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
  }

  // Metrics (cumulative) — keep them flat on health for now.
  health.gamma_markets_seen_total = health.gamma_markets_seen_total || 0;
  health.gamma_markets_kept = health.gamma_markets_kept || 0;
  health.gamma_markets_skipped_missing_endDate = health.gamma_markets_skipped_missing_endDate || 0;
  health.gamma_markets_skipped_date_too_far = health.gamma_markets_skipped_date_too_far || 0;
  health.gamma_markets_seen_by_league = health.gamma_markets_seen_by_league || {};
  health.gamma_markets_kept_by_league = health.gamma_markets_kept_by_league || {};
  health.gamma_markets_skipped_date_too_far_by_league = health.gamma_markets_skipped_date_too_far_by_league || {};

  // Also clean up existing watchlist entries so state doesn't stay polluted with far-dated markets.
  // Mark them expired deterministically (infra), so eval/tag loops don't waste cycles.
  health.gamma_watchlist_expired_date_too_far = health.gamma_watchlist_expired_date_too_far || 0;
  for (const m of Object.values(state.watchlist || {})) {
    if (!m || m.status === "expired") continue;
    const league = String(m.league || "");
    const win = getWin(league);
    if (win.min == null && win.max == null) continue;

    const dd = deltaDaysFromIso(m?.endDateIso || m?.startDateIso || null);
    if (dd == null) {
      if (!keepMissingDate) continue;
      // if keepMissingDate=true, don't expire based on missing date
      continue;
    }

    if ((win.min != null && dd < win.min) || (win.max != null && dd > win.max)) {
      m.status = "expired";
      m.notes = m.notes || {};
      m.notes.reason_expired = "date_window";
      m.notes.date_window_delta_days = dd;
      health.gamma_watchlist_expired_date_too_far++;
    }
  }

  let inserted = 0;
  let seen = 0;
  for (const c of candidates) {
    const league = String(c?.league || "");
    health.gamma_markets_seen_total++;
    health.gamma_markets_seen_by_league[league] = (health.gamma_markets_seen_by_league[league] || 0) + 1;

    const endIso = c?.endDateIso || null;
    const dd = deltaDaysFromIso(endIso);
    if (dd == null) {
      if (!keepMissingDate) {
        health.gamma_markets_skipped_missing_endDate++;
        continue;
      }
    } else {
      const win = getWin(league);
      if (win.min != null && dd < win.min) {
        health.gamma_markets_skipped_date_too_far++;
        health.gamma_markets_skipped_date_too_far_by_league[league] = (health.gamma_markets_skipped_date_too_far_by_league[league] || 0) + 1;
        continue;
      }
      if (win.max != null && dd > win.max) {
        health.gamma_markets_skipped_date_too_far++;
        health.gamma_markets_skipped_date_too_far_by_league[league] = (health.gamma_markets_skipped_date_too_far_by_league[league] || 0) + 1;
        continue;
      }
    }

    health.gamma_markets_kept++;
    health.gamma_markets_kept_by_league[league] = (health.gamma_markets_kept_by_league[league] || 0) + 1;

    const res = upsertMarket(state, c, now);
    if (res.changed) inserted++;
    seen++;
  }

  const exp = markExpired(state, cfg, now);
  const ev = evictIfNeeded(state, cfg);

  state.runtime.health.gamma_candidates_last = seen;
  state.runtime.health.gamma_inserted_last = inserted;
  state.runtime.health.expired_marked_last = exp.marked;
  state.runtime.health.evicted_last = ev.evicted;

  return { changed: inserted > 0 || exp.marked > 0 || ev.evicted > 0, stats: { ok: true, seen, inserted, expired_marked: exp.marked, evicted: ev.evicted } };
}
