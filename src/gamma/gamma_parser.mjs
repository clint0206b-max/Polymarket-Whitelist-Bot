// Phase 1: Parse Gamma events -> market candidates (game bets)

function s(x) { return String(x || ""); }

export function isSpreadOrTotalSlug(slug) {
  const v = s(slug);
  return v.includes("-spread-") || v.includes("-total-") || v.includes("-over-") || v.includes("-under-") || v.includes("-o-") || v.includes("-u-");
}

export function isEsportsSlug(slug) {
  const v = s(slug);
  return /^(lol|cs2|cs|csgo|val|dota|dota2|rl|cod|r6|r6siege|ow|apex|pubg|sc2|halo|smash|sf|tekken|fifa|fc|hok)-/.test(v);
}

// Soccer slug prefixes by league (derived from Polymarket data)
const SOCCER_PREFIXES = [
  "epl-", "lal-", "sea-", "fl1-", "bun-",  // top 5 leagues
  "ucl-", "uel-",                            // UEFA
  "mex-", "arg-", "ere-", "por-",            // other leagues
  "bra-", "tur-", "sco-", "bel-", "aut-",   // extended
];

export function isSoccerSlug(slug) {
  const v = s(slug).toLowerCase();
  return SOCCER_PREFIXES.some(p => v.startsWith(p));
}

export function isSoccerBannedSlug(slug) {
  const v = s(slug).toLowerCase();
  if (!isSoccerSlug(v)) return false;
  // Ban: draw, total, spread, btts, over, under
  return v.includes("-draw") ||
         v.includes("-total-") ||
         v.includes("-spread-") ||
         v.includes("-btts") ||
         v.includes("-over-") ||
         v.includes("-under-");
}

function gammaVol24hUsd(m) {
  const v = m?.volume24hr ?? m?.volume24h ?? m?.volumeNum ?? m?.volume;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickMarketsForEvent(tag, e, cfg) {
  const mkts = Array.isArray(e?.markets) ? e.markets.slice() : [];
  const active = mkts.filter(m => m?.active && !m?.closed);
  active.sort((a, b) => gammaVol24hUsd(b) - gammaVol24hUsd(a));

  // NBA/CBB: choose main (or 1 top non-total)
  if (tag === "nba" || tag === "ncaa-basketball") {
    const main = active.find(m => s(m.slug) === s(e.slug));
    if (main && !isSpreadOrTotalSlug(main.slug)) return [main];
    return active.filter(m => !isSpreadOrTotalSlug(m.slug)).slice(0, 1);
  }

  // Soccer: only team-win markets (ban draw, total, spread, btts, over, under)
  if (tag === "soccer") {
    const teamWins = active.filter(m => isSoccerSlug(m.slug) && !isSoccerBannedSlug(m.slug));
    // Also include non-soccer-prefix markets that aren't banned (fallback)
    const nonPrefixed = active.filter(m => !isSoccerSlug(m.slug) && !isSpreadOrTotalSlug(m.slug));
    const all = [...teamWins, ...nonPrefixed];
    const maxMkts = Number(cfg?.gamma?.events_max_markets_per_event || 6);
    return all.slice(0, maxMkts);
  }

  // Esports: prefer game/map markets; include main if present
  const isEsportsEvent = active.some(m => isEsportsSlug(m.slug));
  if (isEsportsEvent) {
    const sub = active.filter(m => /-(game|map)\d+\b/i.test(s(m.slug)));
    const main = active.find(m => s(m.slug) === s(e.slug));
    const picked = sub.length ? sub.slice() : active.slice();
    if (main && !picked.some(p => s(p.slug) === s(main.slug))) picked.unshift(main);
    const maxMkts = Number(cfg?.gamma?.events_max_markets_per_event || 6);
    return picked.slice(0, Math.max(maxMkts, 4));
  }

  // Default: top markets by volume excluding spreads/totals
  const maxMkts = Number(cfg?.gamma?.events_max_markets_per_event || 6);
  return active.filter(m => !isSpreadOrTotalSlug(m.slug)).slice(0, maxMkts);
}

function leagueFromTag(tag) {
  if (tag === "nba") return "nba";
  if (tag === "ncaa-basketball") return "cbb";
  if (tag === "esports") return "esports";
  if (tag === "soccer") return "soccer";
  return tag;
}

function normalizeClobTokenIds(raw) {
  // Output must always be an array; if we can't derive a valid 2-length array, return [].
  // Also return counters.
  let parseFail = 0;
  let unexpected = 0;

  let arr = null;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) arr = j;
      else { unexpected++; arr = []; }
    } catch {
      parseFail++;
      arr = [];
    }
  } else if (raw == null) {
    unexpected++;
    arr = [];
  } else {
    unexpected++;
    arr = [];
  }

  // coerce to strings and validate len==2
  const cleaned = Array.isArray(arr) ? arr.map(String) : [];
  if (cleaned.length !== 2) {
    if (cleaned.length !== 0) unexpected++;
    return { clobTokenIds: [], parseFail, unexpected };
  }

  return { clobTokenIds: cleaned, parseFail, unexpected };
}

export function parseEventsToMarkets(rawByTag, cfg) {
  const out = [];
  const minVol = Number(cfg?.gamma?.min_vol24h_usd || 0);

  let gamma_token_parse_fail_count = 0;
  let gamma_token_count_unexpected_count = 0;

  for (const [tag, events] of Object.entries(rawByTag || {})) {
    for (const e of (events || [])) {
      const mkts = pickMarketsForEvent(tag, e, cfg);
      for (const m of mkts) {
        const conditionId = m?.conditionId != null ? String(m.conditionId) : null;
        if (!conditionId) continue;

        const vol = gammaVol24hUsd(m);
        if (vol < minVol) continue;

        const norm = normalizeClobTokenIds(m?.clobTokenIds);
        gamma_token_parse_fail_count += norm.parseFail;
        gamma_token_count_unexpected_count += norm.unexpected;

        out.push({
          conditionId,
          league: leagueFromTag(tag),
          tag,
          event_id: e?.id != null ? String(e.id) : null,
          event_slug: s(e?.slug) || null,
          // event-level esports metadata (tag-only / observability)
          event_live: (e?.live === true || e?.live === false) ? !!e.live : null,
          event_title: s(e?.title || e?.name) || null,
          event_score_raw: (e?.score != null) ? String(e.score) : null,
          event_period_raw: (e?.period != null) ? String(e.period) : null,
          slug: s(m?.slug) || null,
          title: s(e?.title || e?.name) || null,
          question: s(m?.question) || null,
          vol24h_usd: vol,
          // Dates (infra only): used to align context fetch windows.
          // Prefer market endDate; fallback to event endDate.
          endDateIso: (m?.endDateIso || m?.endDate || e?.endDate) ? String(m?.endDateIso || m?.endDate || e?.endDate) : null,
          startDateIso: (m?.startDateIso || m?.startDate || e?.startDate) ? String(m?.startDateIso || m?.startDate || e?.startDate) : null,
          // outcomes order (critical for deterministic "yes_outcome_name")
          // Gamma may return outcomes as a JSON string or as an array
          outcomes: (() => {
            let raw = m?.outcomes;
            if (typeof raw === "string") {
              try { raw = JSON.parse(raw); } catch { return null; }
            }
            return Array.isArray(raw) ? raw.map(String) : null;
          })(),
          tokens: {
            clobTokenIds: norm.clobTokenIds,
            yes_token_id: null,
            no_token_id: null
          }
        });
      }
    }
  }

  return {
    candidates: out,
    stats: { gamma_token_parse_fail_count, gamma_token_count_unexpected_count }
  };
}
