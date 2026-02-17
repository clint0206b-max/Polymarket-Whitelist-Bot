/**
 * position_reconciler.mjs — Reconcile execution_state against Polymarket Data API.
 * 
 * OBSERVATION MODE ONLY — logs discrepancies but does NOT auto-fix.
 * Manual review required before enabling auto-fix.
 */

import { appendJsonl } from "../core/journal.mjs";

const DATA_API = "https://data-api.polymarket.com";

/**
 * Fetch real positions from Polymarket Data API.
 * Returns array of { slug, outcome, asset, size, avgPrice }
 */
async function fetchRealPositions(funder, { timeoutMs = 10000, sizeThreshold = 0.01 } = {}) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${DATA_API}/positions?user=${funder}&limit=200&sizeThreshold=${sizeThreshold}`;
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return { ok: false, reason: `http_${r.status}`, positions: [] };
    const data = await r.json();
    return {
      ok: true,
      positions: (Array.isArray(data) ? data : []).map(p => ({
        slug: p.slug,
        outcome: p.outcome,
        asset: p.asset,
        size: Number(p.size),
        avgPrice: Number(p.avgPrice),
        conditionId: p.conditionId || null,
      })),
    };
  } catch (e) {
    return { ok: false, reason: e?.name === "AbortError" ? "timeout" : e?.message, positions: [] };
  } finally {
    clearTimeout(to);
  }
}

/**
 * Run reconciliation check.
 * @param {object} execState - current execution_state
 * @param {string} funder - wallet address
 * @returns {object} - { ok, checked, orphans, ghosts, mismatches }
 */
export async function reconcilePositions(execState, funder) {
  const result = { ok: false, checked: false, orphans: [], ghosts: [], mismatches: [], ts: Date.now() };

  const realData = await fetchRealPositions(funder);
  if (!realData.ok) {
    console.warn(`[RECONCILE_API] Failed to fetch positions: ${realData.reason}`);
    return result;
  }

  result.ok = true;
  result.checked = true;

  // Build map of tracked open positions from execution_state
  const trackedOpen = new Map();
  for (const [tid, t] of Object.entries(execState.trades || {})) {
    if (t.status === "filled" && !t.closed && String(t.side).toUpperCase() === "BUY") {
      trackedOpen.set(t.tokenId, { tradeId: tid, ...t });
    }
  }

  // Build map of real positions
  const realMap = new Map();
  for (const p of realData.positions) {
    if (p.size > 0.01) {
      realMap.set(p.asset, p);
    }
  }

  // Orphans: on-chain but NOT tracked
  for (const [asset, pos] of realMap) {
    if (!trackedOpen.has(asset)) {
      result.orphans.push({
        type: "orphan",
        slug: pos.slug,
        asset: asset.slice(0, 20) + "...",
        size: pos.size,
        avgPrice: pos.avgPrice,
        outcome: pos.outcome,
      });
    }
  }

  // Ghosts: tracked but NOT on-chain
  for (const [tokenId, trade] of trackedOpen) {
    if (!realMap.has(tokenId)) {
      result.ghosts.push({
        type: "ghost",
        slug: trade.slug,
        tradeId: trade.tradeId,
        tokenId: tokenId.slice(0, 20) + "...",
        expectedShares: trade.filledShares,
      });
    }
  }

  // Size mismatches: both exist but shares differ
  for (const [tokenId, trade] of trackedOpen) {
    const real = realMap.get(tokenId);
    if (real) {
      const diff = Math.abs(real.size - (trade.filledShares || 0));
      if (diff > 0.1) { // tolerance
        result.mismatches.push({
          type: "size_mismatch",
          slug: trade.slug,
          tracked_shares: trade.filledShares,
          real_shares: real.size,
          diff,
        });
      }
    }
  }

  // Log results
  const total = result.orphans.length + result.ghosts.length + result.mismatches.length;
  if (total > 0) {
    console.warn(`[RECONCILE_API] DISCREPANCIES FOUND: ${result.orphans.length} orphans, ${result.ghosts.length} ghosts, ${result.mismatches.length} mismatches`);
    for (const o of result.orphans) console.warn(`  [ORPHAN] ${o.slug} | ${o.size} shares @ ${o.avgPrice}`);
    for (const g of result.ghosts) console.warn(`  [GHOST] ${g.slug} | expected ${g.expectedShares} shares — not on-chain`);
    for (const m of result.mismatches) console.warn(`  [MISMATCH] ${m.slug} | tracked=${m.tracked_shares} real=${m.real_shares} diff=${m.diff.toFixed(2)}`);

    appendJsonl("state/journal/executions.jsonl", {
      type: "reconciliation_discrepancy",
      ts: Date.now(),
      orphans: result.orphans,
      ghosts: result.ghosts,
      mismatches: result.mismatches,
    });
  } else {
    console.log(`[RECONCILE_API] OK — ${trackedOpen.size} tracked, ${realMap.size} on-chain, 0 discrepancies`);
  }

  return result;
}
