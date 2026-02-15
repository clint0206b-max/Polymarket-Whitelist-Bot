function isObj(x) { return x && typeof x === "object" && !Array.isArray(x); }
function nonEmpty(v) {
  if (v == null) return false;
  const t = String(v).trim();
  return t.length > 0;
}

function upsertNonDestructive(target, patch) {
  if (!isObj(target)) target = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (isObj(v)) {
      target[k] = upsertNonDestructive(target[k], v);
      continue;
    }
    if (!nonEmpty(v) && v !== false && v !== 0) continue;
    target[k] = v;
  }
  return target;
}

function isValidTokenPair(x) {
  return Array.isArray(x) && x.length === 2 && x.every(v => typeof v === "string" && v.trim().length > 0);
}

// --- Esports market classification (infra/observability only) ---
// Deterministic, slug-first. No fuzzy, no external APIs.
function classifyMarketKind(m) {
  const league = String(m?.league || "");
  if (league !== "esports") return null;

  const slug = String(m?.slug || "").toLowerCase();

  const isGameOrMap = /-(game|map)\d+\b/.test(slug);
  if (isGameOrMap) {
    // Treat game-level props as other (not winner market)
    const isProp = /-(game|map)\d+-(first-blood)\b/.test(slug);
    if (isProp) return "other";
    return "map_specific";
  }

  // Default for esports without game/map suffix: match/series winner
  return "match_series";
}

export function upsertMarket(state, market, now) {
  state.watchlist = state.watchlist || {};
  const wl = state.watchlist;

  const id = String(market?.conditionId || "");
  if (!id) return { changed: false, reason: "missing_conditionId" };

  const existed = !!wl[id];
  const existing = wl[id] || {};

  // Merge non-token metadata non-destructively
  const merged = upsertNonDestructive(existing, {
    conditionId: id,
    slug: market.slug,
    title: market.title,
    question: market.question,
    league: market.league,
    tag: market.tag,
    event_id: market.event_id,
    event_slug: market.event_slug,
    startDateIso: market.startDateIso,
    endDateIso: market.endDateIso
  });

  // Infra-only: persist minimal esports event metadata + outcomes under m.esports_ctx
  if (merged.league === "esports") {
    merged.esports_ctx = (merged.esports_ctx && typeof merged.esports_ctx === "object" && !Array.isArray(merged.esports_ctx)) ? merged.esports_ctx : { v: 1 };
    merged.esports_ctx.v = 1;

    merged.esports_ctx.event = (merged.esports_ctx.event && typeof merged.esports_ctx.event === "object" && !Array.isArray(merged.esports_ctx.event)) ? merged.esports_ctx.event : {};
    const ev = merged.esports_ctx.event;

    if (market.event_id != null) ev.id = String(market.event_id);
    if (market.event_slug != null) ev.slug = String(market.event_slug);
    if (market.event_live === true || market.event_live === false) ev.live = !!market.event_live;
    if (market.event_title != null) ev.title = String(market.event_title);
    if (market.event_score_raw != null) ev.score_raw = String(market.event_score_raw);
    if (market.event_period_raw != null) ev.period_raw = String(market.event_period_raw);
    ev.fetched_ts = now;

    // Outcomes order is required for deterministic yes_outcome_name
    merged.esports_ctx.market = (merged.esports_ctx.market && typeof merged.esports_ctx.market === "object" && !Array.isArray(merged.esports_ctx.market)) ? merged.esports_ctx.market : {};
    const mk = merged.esports_ctx.market;
    if (Array.isArray(market.outcomes) && market.outcomes.length === 2) mk.outcomes = market.outcomes.map(String);
    if (Array.isArray(market?.tokens?.clobTokenIds) && market.tokens.clobTokenIds.length === 2) mk.clobTokenIds = market.tokens.clobTokenIds.map(String);

    // derived block will be computed in eval loop once tokens are resolved (tag-only)
    merged.esports_ctx.derived = (merged.esports_ctx.derived && typeof merged.esports_ctx.derived === "object" && !Array.isArray(merged.esports_ctx.derived)) ? merged.esports_ctx.derived : {};
    merged.esports_ctx.derived.v = 1;
  }

  // Persist outcomes for ALL leagues (needed for resolution tracker win/loss)
  if (Array.isArray(market.outcomes) && market.outcomes.length === 2) {
    merged.outcomes = market.outcomes.map(String);
  }

  // Ensure tokens block exists and is normalized
  merged.tokens = isObj(merged.tokens) ? merged.tokens : {};
  if (!Array.isArray(merged.tokens.clobTokenIds)) merged.tokens.clobTokenIds = [];
  if (merged.tokens.yes_token_id === undefined) merged.tokens.yes_token_id = null;
  if (merged.tokens.no_token_id === undefined) merged.tokens.no_token_id = null;

  // Non-destructive token pair update:
  // only overwrite clobTokenIds if new is a valid pair AND old is missing/invalid.
  const newPair = market?.tokens?.clobTokenIds;
  if (isValidTokenPair(newPair)) {
    const oldPair = merged.tokens.clobTokenIds;
    if (!isValidTokenPair(oldPair)) {
      merged.tokens.clobTokenIds = newPair;
    }
  }

  // Preserve resolved_by/resolved_ts if already present (do not clear)
  if (merged.tokens.resolved_by === undefined) merged.tokens.resolved_by = null;
  if (merged.tokens.resolved_ts === undefined) merged.tokens.resolved_ts = null;

  // Infra-only: persist deterministic market_kind for esports
  if (merged.market_kind === undefined || merged.market_kind == null) {
    const k = classifyMarketKind(merged);
    if (k) merged.market_kind = k;
  }

  if (!merged.status) merged.status = "watching";
  if (!merged.first_seen_ts) merged.first_seen_ts = now;
  merged.last_seen_ts = Math.max(Number(merged.last_seen_ts || 0), now);

  wl[id] = merged;

  return { changed: !existed, existed };
}
