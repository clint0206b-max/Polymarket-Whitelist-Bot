// Paper positions resolution tracker (B0.2)
// Resolves open paper signals by polling Gamma market endpoint (by slug).

import { appendJsonl, loadOpenIndex, saveOpenIndex, removeOpen } from "../core/journal.mjs";

function nowMs() { return Date.now(); }

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function parseJsonMaybe(x) {
  if (Array.isArray(x)) return x;
  if (typeof x === "string") {
    const t = x.trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch { return null; }
  }
  return null;
}

function normTeam(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchGammaMarketBySlug(slug, timeoutMs = 5000) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(String(slug || ""))}`;
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!r.ok) return { ok: false, reason: `http_${r.status}`, market: null };
    const j = await r.json();
    const m = Array.isArray(j) ? j[0] : null;
    if (!m) return { ok: false, reason: "not_found", market: null };
    return { ok: true, reason: null, market: m };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : (e?.message || String(e));
    return { ok: false, reason: msg, market: null };
  } finally {
    clearTimeout(to);
  }
}

function detectResolved(market) {
  // Conservative: require closed/!active AND outcomePrices near terminal.
  const closed = market?.closed === true;
  const active = market?.active === true;
  if (!closed && active) return { resolved: false };

  const outcomes = parseJsonMaybe(market?.outcomes);
  const prices = parseJsonMaybe(market?.outcomePrices);
  if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length !== prices.length) {
    return { resolved: false };
  }

  const nums = prices.map(toNum);
  if (nums.some(x => x == null)) return { resolved: false };

  let maxIdx = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i] > nums[maxIdx]) maxIdx = i;
  const max = nums[maxIdx];

  // terminal-ish
  if (!(max >= 0.99)) return { resolved: false };

  return { resolved: true, winner: String(outcomes[maxIdx]), maxPrice: max };
}

function computePnl(entryPrice, notionalUsd, won) {
  const p = Number(entryPrice);
  const n = Number(notionalUsd);
  if (!(p > 0 && p < 1) || !(n > 0)) return { pnl_usd: null, roi: null, shares: null };
  const shares = n / p;
  const pnl = won ? (shares * (1 - p)) : (-shares * p);
  const roi = pnl / n;
  return { pnl_usd: pnl, roi, shares };
}

export async function loopResolutionTracker(cfg) {
  const idx = loadOpenIndex();
  const open = idx.open || {};
  const ids = Object.keys(open);
  if (!ids.length) return { changed: false, checked: 0, resolved: 0 };

  const maxOpen = Number(cfg?.paper?.max_open_positions ?? 200);
  const toCheck = ids.slice(0, Math.max(0, maxOpen));

  let resolvedCount = 0;
  for (const id of toCheck) {
    const row = open[id];
    const slug = row?.slug;
    if (!slug) continue;

    const r = await fetchGammaMarketBySlug(slug, 5000);
    if (!r.ok) continue;

    const det = detectResolved(r.market);
    if (!det.resolved) continue;

    const entryOutcome = row?.entry_outcome_name;
    const won = normTeam(det.winner) && normTeam(entryOutcome) ? (normTeam(det.winner) === normTeam(entryOutcome)) : null;

    const { pnl_usd, roi, shares } = (won == null)
      ? { pnl_usd: null, roi: null, shares: null }
      : computePnl(row.entry_price, row.paper_notional_usd, won);

    appendJsonl("state/journal/signals.jsonl", {
      type: "signal_close",
      signal_id: id,
      ts_close: nowMs(),
      close_reason: "resolved",
      resolved_outcome_name: det.winner,
      resolved_price_max: det.maxPrice,
      win: won,
      paper_shares: shares,
      pnl_usd,
      roi
    });

    removeOpen(idx, id);
    resolvedCount++;
  }

  if (resolvedCount) saveOpenIndex(idx);
  return { changed: resolvedCount > 0, checked: toCheck.length, resolved: resolvedCount };
}
