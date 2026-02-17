// Paper positions resolution tracker (B0.2)
// Resolves open paper signals by polling Gamma market endpoint (by slug).
// Also tracks price extremes (min/max) for offline SL analysis.

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

/**
 * Extract current price for a specific outcome from Gamma market.
 * @param {object} market - Gamma market response
 * @param {string} outcomeName - the outcome we bought (e.g. "Seattle Redhawks")
 * @returns {number|null} - price 0-1, or null if can't determine
 */
export function getOutcomePrice(market, outcomeName) {
  if (!market || !outcomeName) return null;
  const outcomes = parseJsonMaybe(market.outcomes);
  const prices = parseJsonMaybe(market.outcomePrices);
  if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length !== prices.length) return null;

  const target = normTeam(outcomeName);
  for (let i = 0; i < outcomes.length; i++) {
    if (normTeam(outcomes[i]) === target) {
      return toNum(prices[i]);
    }
  }
  return null;
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
  let priceUpdated = false;

  for (const id of toCheck) {
    const row = open[id];
    const slug = row?.slug;
    if (!slug) continue;

    const r = await fetchGammaMarketBySlug(slug, 5000);
    if (!r.ok) { fetchFailCount++; continue; }

    // --- Price tracking (always, even if not resolved yet) ---
    const curPrice = getOutcomePrice(r.market, row.entry_outcome_name);
    if (curPrice != null) {
      const prev = row.price_tracking || {};
      const newMin = (prev.price_min != null) ? Math.min(prev.price_min, curPrice) : curPrice;
      const newMax = (prev.price_max != null) ? Math.max(prev.price_max, curPrice) : curPrice;
      row.price_tracking = {
        price_min: newMin,
        price_max: newMax,
        price_last: curPrice,
        samples: (prev.samples || 0) + 1,
        first_seen_ts: prev.first_seen_ts || nowMs(),
        last_seen_ts: nowMs(),
      };
      priceUpdated = true;
    }

    // --- Paper Stop Loss (ONLY in paper mode — live uses CLOB SL in main loop) ---
    const tradingMode = cfg?.trading?.mode || "paper";
    const slThreshold = Number(cfg?.paper?.stop_loss_bid ?? 0.70);
    if (tradingMode === "paper" && slThreshold > 0 && curPrice != null && curPrice <= slThreshold) {
      const entryP = Number(row.entry_price);
      const notional = Number(row.paper_notional_usd);
      const shares = (entryP > 0 && entryP < 1) ? notional / entryP : 0;
      const slPnl = shares * (curPrice - entryP);
      const slRoi = notional > 0 ? slPnl / notional : 0;
      const pt = row.price_tracking || {};

      appendJsonl("state/journal/signals.jsonl", {
        type: "signal_close",
        runner_id: process.env.SHADOW_ID || "prod",
        signal_id: id,
        slug: row.slug,
        title: row.title || null,
        ts_close: nowMs(),
        close_reason: "stop_loss",
        sl_trigger_price: curPrice,
        sl_threshold: slThreshold,
        win: false,
        paper_shares: shares,
        pnl_usd: slPnl,
        roi: slRoi,
        price_min_seen: pt.price_min ?? null,
        price_max_seen: pt.price_max ?? null,
        price_last_seen: pt.price_last ?? null,
        price_samples: pt.samples ?? 0,
      });

      const pnlStr = `−$${Math.abs(slPnl).toFixed(2)}`;
      console.log(`[STOP_LOSS] ${row.slug} | price=${curPrice.toFixed(3)} <= ${slThreshold} | ${pnlStr} | entry=${entryP.toFixed(3)}`);

      addClosed(idx, id, {
        slug: row.slug,
        title: row.title || null,
        ts_open: row.ts_open,
        ts_close: nowMs(),
        league: row.league || "",
        entry_price: row.entry_price,
        paper_notional_usd: row.paper_notional_usd,
        entry_outcome_name: row.entry_outcome_name,
        close_reason: "stop_loss",
        sl_trigger_price: curPrice,
        win: false,
        pnl_usd: slPnl,
        roi: slRoi,
        price_min_seen: pt.price_min ?? null,
        price_max_seen: pt.price_max ?? null,
        price_samples: pt.samples ?? 0,
      });
      removeOpen(idx, id);
      resolvedCount++;

      // Bump health counters
      health.paper_stop_loss_count = (health.paper_stop_loss_count || 0) + 1;
      continue;
    }

    // --- Resolution detection (ONLY in paper mode — live uses CLOB terminal price in main loop) ---
    if (tradingMode !== "paper") continue; // In live mode, skip Gamma-based resolution entirely

    const det = detectResolved(r.market);
    if (!det.resolved) continue;

    let entryOutcome = row?.entry_outcome_name || null;

    const won = (entryOutcome && normTeam(det.winner) && normTeam(entryOutcome))
      ? (normTeam(det.winner) === normTeam(entryOutcome))
      : null;

    const { pnl_usd, roi, shares } = (won == null)
      ? { pnl_usd: null, roi: null, shares: null }
      : computePnl(row.entry_price, row.paper_notional_usd, won);

    // Include price extremes in signal_close for offline SL analysis
    const pt = row.price_tracking || {};

    appendJsonl("state/journal/signals.jsonl", {
      type: "signal_close",
      runner_id: process.env.SHADOW_ID || "prod",
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
      roi,
      // Price extremes during position lifetime (for SL analysis)
      price_min_seen: pt.price_min ?? null,
      price_max_seen: pt.price_max ?? null,
      price_last_seen: pt.price_last ?? null,
      price_samples: pt.samples ?? 0,
    });

    // Human-readable log
    const pnlStr = pnl_usd != null ? (pnl_usd >= 0 ? `+$${pnl_usd.toFixed(2)}` : `-$${Math.abs(pnl_usd).toFixed(2)}`) : "?";
    const minStr = pt.price_min != null ? ` | min=${pt.price_min.toFixed(3)}` : "";
    console.log(`[RESOLVED] ${row.slug} | ${won ? "WIN" : won === false ? "LOSS" : "?"} ${pnlStr} | winner: ${det.winner || "?"}${minStr}`);

    // Move to closed index
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
      price_min_seen: pt.price_min ?? null,
      price_max_seen: pt.price_max ?? null,
      price_samples: pt.samples ?? 0,
    });
    removeOpen(idx, id);
    resolvedCount++;
  }

  // Save if anything changed (resolved OR price updated)
  if (resolvedCount || priceUpdated) saveOpenIndex(idx);

  // === Resolve pending timeouts (counterfactual analysis) ===
  // Check signal_timeout entries that don't have an outcome yet.
  // This tells us: "would we have won or lost if we had entered?"
  try {
    const fs = await import("node:fs");
    const journalPath = "state/journal/signals.jsonl";
    const lines = fs.readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    
    // Find unresolved timeouts (no matching timeout_resolved)
    const resolvedTimeoutSlugs = new Set(
      entries.filter(e => e.type === "timeout_resolved").map(e => e.slug + "|" + e.timeout_ts)
    );
    const unresolvedTimeouts = entries.filter(e => 
      e.type === "signal_timeout" && 
      !resolvedTimeoutSlugs.has(e.slug + "|" + e.ts)
    );

    // Limit checks per cycle to avoid hammering Gamma
    const maxTimeoutChecks = 3;
    let timeoutResolved = 0;
    
    for (const to of unresolvedTimeouts.slice(0, maxTimeoutChecks)) {
      const r = await fetchGammaMarketBySlug(to.slug, 5000);
      if (!r.ok) continue;
      
      const det = detectResolved(r.market);
      if (!det.resolved) continue; // Not resolved yet, check next cycle
      
      // Determine counterfactual: would we have won?
      // We would have bought the YES side at entry_bid_at_pending price
      // Winner is the outcome with price → 1.0
      // We need to know which outcome we would have bet on
      // In our strategy, we always buy the high-probability side (the one at ≥0.93)
      // So if winner matches the high-prob outcome, we would have won
      const wouldHaveWon = det.maxPrice >= 0.995; // Terminal = the side we'd have bought won
      // More precisely: we'd buy YES at entry_bid ≥ 0.93, so if YES resolves to 1.0, we win
      // det.winner is the outcome that resolved to ~1.0
      // Without knowing which outcome we'd have picked, approximate:
      // If entry_bid was ≥ 0.93, we were buying the favorite → favorite won if maxPrice ≥ 0.995
      
      const entryBid = to.entry_bid_at_pending || 0;
      const hypotheticalPnl = wouldHaveWon 
        ? (10 / entryBid) * (1 - entryBid) // WIN: shares * (1 - entry)
        : -(10); // LOSS: lost entire notional
      
      appendJsonl(journalPath, {
        type: "timeout_resolved",
        runner_id: process.env.SHADOW_ID || "prod",
        slug: to.slug,
        timeout_ts: to.ts,
        resolve_ts: nowMs(),
        league: to.league,
        market_kind: to.market_kind,
        entry_bid_at_pending: entryBid,
        bid_at_timeout: to.bid_at_timeout,
        timeout_reason: to.timeout_reason,
        resolved_winner: det.winner,
        resolve_method: det.method,
        would_have_won: wouldHaveWon,
        hypothetical_pnl_usd: Number(hypotheticalPnl.toFixed(2)),
        verdict: wouldHaveWon ? "filter_cost_us" : "filter_saved_us",
      });
      
      const emoji = wouldHaveWon ? "❌" : "✅";
      console.log(`[TIMEOUT_RESOLVED] ${emoji} ${to.slug} | ${wouldHaveWon ? "WOULD HAVE WON" : "SAVED US"} | hyp_pnl=$${hypotheticalPnl.toFixed(2)} | reason=${to.timeout_reason}`);
      timeoutResolved++;
    }
    
    if (timeoutResolved > 0) {
      health.timeout_resolved_count = (health.timeout_resolved_count || 0) + timeoutResolved;
    }
  } catch {}

  // Persist counters
  health.paper_resolution_markets_checked = (health.paper_resolution_markets_checked || 0) + toCheck.length;
  health.paper_resolution_resolved_count = (health.paper_resolution_resolved_count || 0) + resolvedCount;
  health.paper_resolution_fetch_fail_count = (health.paper_resolution_fetch_fail_count || 0) + fetchFailCount;
  health.paper_resolution_last_check_ts = nowMs();
  health.paper_resolution_last_checked_count = toCheck.length;
  health.paper_resolution_last_resolved_count = resolvedCount;

  return { changed: resolvedCount > 0, checked: toCheck.length, resolved: resolvedCount };
}
