// Phase 2: /book parse + normalize (per spec)

function toNumStrict(x) {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string") {
    const t = x.trim();
    if (!t) return null;
    // no comma decimals
    if (t.includes(",")) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseLevels(rawLevels, side) {
  const levels = Array.isArray(rawLevels) ? rawLevels : [];
  const parsed = [];
  let total = levels.length;
  let valid = 0;

  for (const lv of levels) {
    const p = toNumStrict(lv?.price);
    const s = toNumStrict(lv?.size);
    if (p == null || s == null) continue;
    if (!(p > 0 && p <= 1)) continue;
    if (!(s > 0)) continue;
    valid++;
    parsed.push({ price: p, size: s });
  }

  return { parsed, total, valid };
}

export function parseAndNormalizeBook(rawBook, cfg, health) {
  const maxLevels = Number(cfg?.filters?.max_levels_considered || 50);

  const bidsR = parseLevels(rawBook?.bids, "bids");
  const asksR = parseLevels(rawBook?.asks, "asks");

  // Heavily filtered guardrail (health only)
  const bump = (k) => { if (!health) return; health[k] = (health[k] || 0) + 1; };

  const discardRatio = (t, v) => (t > 0 ? (1 - (v / t)) : 0);
  if (bidsR.total > 0 && discardRatio(bidsR.total, bidsR.valid) >= 0.80) bump("book_parse_heavily_filtered_count");
  if (asksR.total > 0 && discardRatio(asksR.total, asksR.valid) >= 0.80) bump("book_parse_heavily_filtered_count");

  // Sort
  bidsR.parsed.sort((a, b) => b.price - a.price);
  asksR.parsed.sort((a, b) => a.price - b.price);

  // Truncate after parse+filter+sort
  const bids = bidsR.parsed.slice(0, maxLevels);
  const asks = asksR.parsed.slice(0, maxLevels);

  // One-sided books are allowed at parse level (v1): usable if EITHER side has levels.
  if (!bids.length && !asks.length) {
    bump("book_empty_count");
    return { ok: false, reason: "book_not_usable", book: null };
  }

  const bestBid = bids.length ? bids[0].price : null;
  const bestAsk = asks.length ? asks[0].price : null;

  // If both sides exist, enforce normal spread sanity. If one side missing, skip this check.
  if (bestBid != null && bestAsk != null) {
    if (!(bestBid > 0 && bestAsk > 0 && bestBid <= bestAsk && bestAsk <= 1)) {
      bump("book_empty_count");
      return { ok: false, reason: "book_not_usable", book: null };
    }
  }

  // If only one side exists, still enforce basic bounds.
  if (bestBid != null && !(bestBid > 0 && bestBid <= 1)) {
    bump("book_empty_count");
    return { ok: false, reason: "book_not_usable", book: null };
  }
  if (bestAsk != null && !(bestAsk > 0 && bestAsk <= 1)) {
    bump("book_empty_count");
    return { ok: false, reason: "book_not_usable", book: null };
  }

  return { ok: true, book: { bids, asks, bestBid, bestAsk }, reason: null };
}
