/**
 * order_executor.mjs — Low-level order execution via @polymarket/clob-client
 * Adapted from polymarket-bot-repo/lib/orders.mjs
 * 
 * This module ONLY deals with CLOB API calls. No business logic.
 */

import { ClobClient, AssetType, CONDITIONAL_TOKEN_DECIMALS } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const CLOB_URL = "https://clob.polymarket.com";
const POLYGON_RPC = "https://polygon-rpc.com";
const SIGNATURE_TYPE = 2; // POLY_GNOSIS_SAFE

/**
 * Initialize authenticated ClobClient from credentials file.
 * @param {string} credentialsPath
 * @param {string} funder - proxy wallet address
 * @returns {{ client: ClobClient, wallet: ethers.Wallet, funder: string }}
 */
export function initClient(credentialsPath, funder) {
  const creds = JSON.parse(readFileSync(credentialsPath, "utf8"));
  const wallet = new ethers.Wallet(creds.privateKey);
  
  const client = new ClobClient(
    CLOB_URL,
    137, // Polygon chainId
    wallet, // signer (ethers.Wallet)
    { key: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase },
    SIGNATURE_TYPE,
    funder
  );
  
  return { client, wallet, funder };
}

/**
 * Execute a BUY market order (Fill-And-Kill).
 * Returns fill details or error.
 */
export async function executeBuy(client, tokenId, shares, maxPrice = null) {
  const amount = roundDown(shares, 2);
  if (!(amount >= 0.01)) return { ok: false, error: "amount_too_small", amount };

  const orderParams = { tokenID: tokenId, amount, side: "BUY" };
  if (maxPrice != null && Number.isFinite(maxPrice) && maxPrice > 0 && maxPrice < 1) {
    orderParams.price = maxPrice;
  }

  const res = await client.createAndPostMarketOrder(
    orderParams,
    {},
    "FAK"
  );

  const orderID = res?.orderID;
  const final = orderID ? await waitForOrderFinal(client, orderID) : null;
  
  return parseFillResult(res, final, amount, "BUY");
}

/**
 * Execute a SELL market order (Fill-And-Kill) with optional floor price.
 * @param {number|null} minPrice - minimum acceptable sell price (null = market)
 */
export async function executeSell(client, tokenId, shares, minPrice = null) {
  const amount = roundDown(shares, 4);
  if (!(amount >= 0.01)) return { ok: false, error: "amount_too_small", amount };

  const orderParams = { tokenID: tokenId, amount, side: "SELL" };
  if (minPrice != null && Number.isFinite(minPrice) && minPrice > 0) {
    orderParams.price = minPrice;
  }

  const res = await client.createAndPostMarketOrder(orderParams, {}, "FAK");
  const orderID = res?.orderID;
  const final = orderID ? await waitForOrderFinal(client, orderID) : null;
  
  return parseFillResult(res, final, amount, "SELL");
}

/**
 * Get USDC balance available for trading.
 */
export async function getBalance(client) {
  const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return Number(bal.balance) / 1e6;
}

/**
 * Get conditional token balance for a specific token.
 */
export async function getConditionalBalance(client, tokenId) {
  const bal = await client.getBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: tokenId,
  });
  const raw = Number(bal.balance);
  const denom = 10 ** Number(CONDITIONAL_TOKEN_DECIMALS || 6);
  return raw / denom;
}

/**
 * Get all open positions for the funder address.
 */
/**
 * Fetch real VWAP fill price from associate_trades.
 * Returns { vwap, trades, source } or null if can't determine.
 * Non-blocking — caller should fire-and-forget or await with timeout.
 */
export async function getRealFillPrice(client, orderResult) {
  const tradeIds = orderResult?._associateTrades;
  if (!Array.isArray(tradeIds) || tradeIds.length === 0) return null;

  try {
    // Fetch each trade by ID (most orders have 1-3 fills)
    const trades = [];
    for (const tid of tradeIds.slice(0, 10)) { // cap at 10 fills
      try {
        const t = await client.getTrades({ id: tid }, true);
        if (Array.isArray(t) && t.length > 0) trades.push(...t);
      } catch {}
    }

    if (trades.length === 0) return null;

    let totalQty = 0, totalVal = 0;
    for (const t of trades) {
      const p = Number(t.price || 0);
      const s = Number(t.size || 0);
      if (p > 0 && s > 0) { totalVal += p * s; totalQty += s; }
    }

    if (totalQty <= 0) return null;
    return { vwap: totalVal / totalQty, totalQty, totalVal, trades: trades.length, source: "associate_trades" };
  } catch (e) {
    console.warn(`[FILL_PRICE] error fetching real fill: ${e.message}`);
    return null;
  }
}

export async function getPositions(funder) {
  const url = `https://data-api.polymarket.com/positions?user=${funder}&limit=200&sizeThreshold=0.5`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`positions fetch failed: ${resp.status}`);
  return resp.json();
}

// --- Internal helpers ---

function roundDown(n, decimals) {
  const f = 10 ** decimals;
  return Math.floor(n * f) / f;
}

async function waitForOrderFinal(client, orderID, { timeoutMs = 15000, intervalMs = 500 } = {}) {
  const start = Date.now();
  let last = null;
  while ((Date.now() - start) < timeoutMs) {
    try { last = await client.getOrder(orderID); } catch { last = null; }
    const st = String(last?.status || "").toUpperCase();
    if (["MATCHED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(st)) return last;
    if (st && !["LIVE", "OPEN", "PENDING", "DELAYED"].includes(st)) return last;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  // Timeout — cancel and return last known state
  try { await client.cancelOrder(orderID); } catch {}
  try { return await client.getOrder(orderID); } catch { return last; }
}

function parseFillResult(res, final, requestedAmount, side) {
  const orderID = res?.orderID || null;
  const st = String(final?.status || "").toUpperCase();
  
  const matchedShares = (final?.size_matched != null && Number(final.size_matched) > 0)
    ? Number(final.size_matched) : null;
  const matchedPrice = (final?.price != null && Number(final.price) > 0)
    ? Number(final.price) : null;

  // Rejected/cancelled with no fill
  if (final && ["CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(st) && (!matchedShares || matchedShares <= 0)) {
    return {
      ok: false,
      error: `order_${st.toLowerCase()}`,
      orderID,
      status: st,
      requestedAmount,
      filledShares: 0,
      side,
    };
  }

  const filledShares = matchedShares ?? requestedAmount;
  const spentUsd = (matchedShares != null && matchedPrice != null)
    ? (matchedShares * matchedPrice)
    : ((res?.makingAmount && Number(res.makingAmount) > 0)
      ? Number(res.makingAmount) : null);
  const avgFillPrice = (spentUsd != null && filledShares > 0) ? (spentUsd / filledShares) : null;
  const isPartial = (matchedShares != null && matchedShares < requestedAmount * 0.99);

  return {
    ok: true,
    orderID,
    status: st || "UNKNOWN",
    side,
    requestedAmount,
    filledShares,
    spentUsd,
    avgFillPrice,
    isPartial,
    _associateTrades: final?.associate_trades || [],
    raw: { res, final },
  };
}
