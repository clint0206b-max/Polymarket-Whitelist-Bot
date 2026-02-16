// Paper positions resolution tracker (B0.2)
// Resolves open paper signals by polling Gamma market endpoint (by slug).

import { appendJsonl, loadOpenIndex, saveOpenIndex, removeOpen, addClosed } from "../core/journal.mjs";

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

export function detectResolved(market) {
  const closed = market?.closed === true;
  const active = market?.active === true;

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

  // Official resolution: market closed by oracle
  if (closed && !active && max >= 0.99) {
    return { resolved: true, method: "official", winner: String(outcomes[maxIdx]), maxPrice: max };
  }

  // Terminal price resolution: prices at ≥0.995 even if Gamma hasn't flipped closed yet.
  // Safe for paper trading — real PnL is identical since we hold to resolution.
  if (max >= 0.995) {
    return { resolved: true, method: "terminal_price", winner: String(outcomes[maxIdx]), maxPrice: max };
  }

  return { resolved: false };
}

export function computePnl(entryPrice, notionalUsd, won) {
  const p = Number(entryPrice);
  const n = Number(notionalUsd);
  if (!(p > 0 && p < 1) || !(n > 0)) return { pnl_usd: null, roi: null, shares: null };
  const shares = n / p;
  const pnl = won ? (shares * (1 - p)) : (-shares * p);
  const roi = pnl / n;
  return { pnl_usd: pnl, roi, shares };
}

export async function loopResolutionTracker(cfg, state) {
  const idx = loadOpenIndex();
  const open = idx.open || {};
  const ids = Object.keys(open);

  // Observability counters (persisted on state if provided)
  const health = (state?.runtime?.health) || {};
  health.paper_resolution_poll_cycles = (health.paper_resolution_poll_cycles || 0) + 1;
  health.paper_resolution_open_count = ids.length;

  if (!ids.length) return { changed: false, checked: 0, resolved: 0 };

  const maxOpen = Number(cfg?.paper?.max_open_positions ?? 200);
  const toCheck = ids.slice(0, Math.max(0, maxOpen));

  let resolvedCount = 0;
  let fetchFailCount = 0;
  for (const id of toCheck) {
    const row = open[id];
    const slug = row?.slug;
    if (!slug) continue;

    const r = await fetchGammaMarketBySlug(slug, 5000);
    if (!r.ok) { fetchFailCount++; continue; }

    const det = detectResolved(r.market);
    if (!det.resolved) continue;

    let entryOutcome = row?.entry_outcome_name || null;

    // Fallback: if entry_outcome_name is null (legacy entries), derive from Gamma response
    // The "yes" side is whichever had the higher price at entry time. Since we always buy
    // the favored side, and for binary markets the "Yes"/"Team A" side is outcomes[0],
    // we can derive: if the market has 2 outcomes, the one that is NOT the winner
    // determines loss, and the one that IS the winner determines win.
    // But we need to know WHICH outcome we bet on. Without clobTokenIds mapping in the
    // open_index, we use a heuristic: the favored team at entry was likely the one
    // with the higher price, which at resolution is the winner (if we won) or the loser
    // (if we lost). Since we can't be sure, we mark won=null for legacy entries.
    //
    // For entries with entry_outcome_name set correctly, this is a clean comparison.
    const won = (entryOutcome && normTeam(det.winner) && normTeam(entryOutcome))
      ? (normTeam(det.winner) === normTeam(entryOutcome))
      : null;

    const { pnl_usd, roi, shares } = (won == null)
      ? { pnl_usd: null, roi: null, shares: null }
      : computePnl(row.entry_price, row.paper_notional_usd, won);

    appendJsonl("state/journal/signals.jsonl", {
      type: "signal_close",
      signal_id: id,
      slug: row.slug,
      title: row.title || null,
      ts_close: nowMs(),
      close_reason: "resolved",
      resolve_method: det.method || "unknown",
      resolved_outcome_name: det.winner,
      resolved_price_max: det.maxPrice,
      win: won,
      paper_shares: shares,
      pnl_usd,
      roi
    });

    // Human-readable log
    const pnlStr = pnl_usd != null ? (pnl_usd >= 0 ? `+$${pnl_usd.toFixed(2)}` : `-$${Math.abs(pnl_usd).toFixed(2)}`) : "?";
    console.log(`[RESOLVED] ${row.slug} | ${won ? "WIN" : won === false ? "LOSS" : "?"} ${pnlStr} | winner: ${det.winner || "?"}`);

    // Move to closed index before removing from open
    addClosed(idx, id, {
      slug: row.slug,
      title: row.title || null,
      ts_open: row.ts_open,
      ts_close: nowMs(),
      league: row.league || "",
      entry_price: row.entry_price,
      paper_notional_usd: row.paper_notional_usd,
      entry_outcome_name: entryOutcome,
      close_reason: "resolved",
      resolve_method: det.method || "unknown",
      resolved_outcome_name: det.winner,
      win: won,
      pnl_usd,
      roi,
    });
    removeOpen(idx, id);
    resolvedCount++;
  }

  if (resolvedCount) saveOpenIndex(idx);

  // Persist counters
  health.paper_resolution_markets_checked = (health.paper_resolution_markets_checked || 0) + toCheck.length;
  health.paper_resolution_resolved_count = (health.paper_resolution_resolved_count || 0) + resolvedCount;
  health.paper_resolution_fetch_fail_count = (health.paper_resolution_fetch_fail_count || 0) + fetchFailCount;
  health.paper_resolution_last_check_ts = nowMs();
  health.paper_resolution_last_checked_count = toCheck.length;
  health.paper_resolution_last_resolved_count = resolvedCount;

  return { changed: resolvedCount > 0, checked: toCheck.length, resolved: resolvedCount };
}
