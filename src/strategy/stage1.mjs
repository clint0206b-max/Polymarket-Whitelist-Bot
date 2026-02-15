// Stage 1 pure functions (EPS)

export function gte(x, t, EPS) { return (x + EPS) >= t; }
export function lte(x, t, EPS) { return (x - EPS) <= t; }

export function is_base_signal_candidate(quote, cfg) {
  const EPS = Number(cfg?.filters?.EPS || 1e-6);
  const minProb = Number(cfg?.filters?.min_prob);
  const maxEntry = Number(cfg?.filters?.max_entry_price);
  const maxSpread = Number(cfg?.filters?.max_spread);

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

export function is_near_signal_margin(quote, cfg) {
  const EPS = Number(cfg?.filters?.EPS || 1e-6);
  const nearProb = Number(cfg?.filters?.near_prob_min);
  const nearSpread = Number(cfg?.filters?.near_spread_max);

  const probAsk = Number(quote?.probAsk);
  const spread = Number(quote?.spread);

  return gte(probAsk, nearProb, EPS) || lte(spread, nearSpread, EPS);
}
