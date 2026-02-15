// Stage 2 depth pure functions (EPS)

export function gte(x, t, EPS) { return (x + EPS) >= t; }
export function lte(x, t, EPS) { return (x - EPS) <= t; }

export function compute_depth_metrics(book, cfg) {
  const EPS = Number(cfg?.filters?.EPS || 1e-6);
  const minExit = Number(cfg?.filters?.min_exit_depth_usd_bid || 2000);
  const minEntry = Number(cfg?.filters?.min_entry_depth_usd_ask || 1000);
  const floor = Number(cfg?.filters?.exit_depth_floor_price || 0.70);
  const maxEntryPx = Number(cfg?.filters?.max_entry_price || 0.97);
  const maxLevels = Number(cfg?.filters?.max_levels_considered || 50);

  // exit depth
  let exitUsd = 0;
  let bidLevelsUsed = 0;
  for (const lv of (book?.bids || []).slice(0, maxLevels)) {
    const price = Number(lv.price);
    const size = Number(lv.size);
    if (!lte(price, 0, EPS) && !lte(size, 0, EPS)) {
      if (!gte(price, floor, EPS)) break;
      exitUsd += price * size;
      bidLevelsUsed++;
      if (gte(exitUsd, minExit, EPS)) break;
    }
  }

  // entry depth
  let entryUsd = 0;
  let askLevelsUsed = 0;
  for (const lv of (book?.asks || []).slice(0, maxLevels)) {
    const price = Number(lv.price);
    const size = Number(lv.size);
    if (!lte(price, 0, EPS) && !lte(size, 0, EPS)) {
      if (!lte(price, maxEntryPx, EPS)) break;
      entryUsd += price * size;
      askLevelsUsed++;
      if (gte(entryUsd, minEntry, EPS)) break;
    }
  }

  return { exit_depth_usd_bid: exitUsd, entry_depth_usd_ask: entryUsd, bid_levels_used: bidLevelsUsed, ask_levels_used: askLevelsUsed };
}

export function is_depth_sufficient(metrics, cfg) {
  const EPS = Number(cfg?.filters?.EPS || 1e-6);
  const minExit = Number(cfg?.filters?.min_exit_depth_usd_bid || 2000);
  const minEntry = Number(cfg?.filters?.min_entry_depth_usd_ask || 1000);

  if (!gte(Number(metrics?.exit_depth_usd_bid || 0), minExit, EPS)) return { pass: false, reason: "depth_bid_below_min" };
  if (!gte(Number(metrics?.entry_depth_usd_ask || 0), minEntry, EPS)) return { pass: false, reason: "depth_ask_below_min" };
  return { pass: true, reason: null };
}
