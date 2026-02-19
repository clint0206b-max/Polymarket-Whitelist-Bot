// Stage 1 pure functions (EPS)

export function gte(x, t, EPS) { return (x + EPS) >= t; }
export function lte(x, t, EPS) { return (x - EPS) <= t; }

/**
 * Resolve per-sport min/max entry price from config.
 * Chain: sport-specific → default.
 * @param {object} filters - cfg.filters
 * @param {string} slugPrefix - e.g. "dota2", "cs2"
 * @returns {{ minProb: number, maxEntry: number }}
 */
export function resolveEntryPriceLimits(filters, slugPrefix) {
  const sportMin = Number(filters?.[`min_entry_price_${slugPrefix}`]);
  const sportMax = Number(filters?.[`max_entry_price_${slugPrefix}`]);

  const minProb = (Number.isFinite(sportMin) && sportMin > 0) ? sportMin : Number(filters?.min_prob);
  const maxEntry = (Number.isFinite(sportMax) && sportMax > 0) ? sportMax : Number(filters?.max_entry_price);

  return { minProb, maxEntry };
}

export function is_base_signal_candidate(quote, cfg, slugPrefix) {
  const EPS = Number(cfg?.filters?.EPS || 1e-6);
  const { minProb, maxEntry } = resolveEntryPriceLimits(cfg?.filters, slugPrefix);
  const maxSpread = resolveMaxSpread(cfg?.filters, slugPrefix);

  const probAsk = Number(quote?.probAsk);
  const spread = Number(quote?.spread);

  if (!gte(probAsk, minProb, EPS) || !lte(probAsk, maxEntry, EPS)) {
    return { pass: false, reason: "price_out_of_range" };
  }
  if (!lte(spread, maxSpread, EPS)) {
    return { pass: false, reason: "spread_above_max" };
  }
  return { pass: true, reason: null };
}

/**
 * Resolve per-sport max spread from config.
 * Chain: sport-specific → default.
 */
export function resolveMaxSpread(filters, slugPrefix) {
  const sportSpread = Number(filters?.[`max_spread_${slugPrefix}`]);
  return (Number.isFinite(sportSpread) && sportSpread > 0) ? sportSpread : Number(filters?.max_spread);
}

export function is_near_signal_margin(quote, cfg) {
  const EPS = Number(cfg?.filters?.EPS || 1e-6);
  const nearProb = Number(cfg?.filters?.near_prob_min);
  const nearSpread = Number(cfg?.filters?.near_spread_max);

  const probAsk = Number(quote?.probAsk);
  const spread = Number(quote?.spread);

  return gte(probAsk, nearProb, EPS) || lte(spread, nearSpread, EPS);
}
