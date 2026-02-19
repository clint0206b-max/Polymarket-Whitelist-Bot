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
const POLYGON_RPC = "https://1rpc.io/matic";
const SIGNATURE_TYPE = 2; // POLY_GNOSIS_SAFE
const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];

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
export async function executeBuy(client, tokenId, shares) {
  const amount = roundDown(shares, 2);
  if (!(amount >= 0.01)) return { ok: false, error: "amount_too_small", amount };

  const res = await client.createAndPostMarketOrder(
    { tokenID: tokenId, amount, side: "BUY" },
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

// Singleton provider — reuses connection, avoids repeated detectNetwork() calls
let _polygonProvider = null;
function getPolygonProvider() {
  if (!_polygonProvider) {
    _polygonProvider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
  }
  return _polygonProvider;
}

/**
 * Get on-chain USDC balance for an address on Polygon.
 * Reads directly from the USDC contract — no cache, no delay.
 * Falls back to null if RPC is unreachable (caller should use CLOB balance).
 * @param {string} address - wallet/proxy address
 * @returns {number|null} USDC balance (human-readable, 6 decimals) or null on failure
 */
export async function getOnChainUSDCBalance(address) {
  try {
    const provider = getPolygonProvider();
    const usdc = new ethers.Contract(USDC_POLYGON, USDC_ABI, provider);
    const raw = await Promise.race([
      usdc.balanceOf(address),
      new Promise((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 5000)),
    ]);
    return Number(raw) / 1e6;
  } catch (e) {
    console.warn(`[ONCHAIN_BALANCE] failed: ${e.message}`);
    // Reset provider on network errors so next call retries fresh
    if (e.code === "NETWORK_ERROR") _polygonProvider = null;
    return null;
  }
}

/**
 * Get all open positions for the funder address.
 */
export async function getPositions(funder) {
  const url = `https://data-api.polymarket.com/positions?user=${funder}&limit=200&sizeThreshold=0.5`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`positions fetch failed: ${resp.status}`);
  return resp.json();
}

/**
 * Fetch real fill price from CLOB trades API by orderID.
 * Returns weighted average price or null if unavailable.
 * Retries with backoff since trades may not be indexed immediately after fill.
 * Non-blocking: caller should treat null as "keep provisional, try later".
 *
 * IMPORTANT: client.getTrades() may return ALL recent trades for the user,
 * ignoring the orderID parameter. We must filter by taker_order_id or
 * maker_orders[].order_id to isolate fills for this specific order.
 */
export async function fetchRealFillPrice(client, orderID, { maxRetries = 2, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const trades = await client.getTrades({ orderID });
      if (!trades || trades.length === 0) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
          continue;
        }
        return null;
      }

      // Filter trades that belong to this specific order.
      // Our order can appear as taker_order_id (most common for market orders)
      // or inside maker_orders[].order_id (if we were the maker side).
      const matched = trades.filter(t => {
        if (t.taker_order_id === orderID) return true;
        if (Array.isArray(t.maker_orders)) {
          return t.maker_orders.some(m => m.order_id === orderID);
        }
        return false;
      });

      const matchMethod = matched.length > 0
        ? (matched[0].taker_order_id === orderID ? "taker" : "maker")
        : "none";

      console.log(`[FILL_PRICE] getTrades returned ${trades.length} trades, ${matched.length} matched orderID (via ${matchMethod})`);

      if (matched.length === 0) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
          continue;
        }
        console.warn(`[FILL_PRICE] orderID=${orderID} not found in ${trades.length} trades after ${maxRetries + 1} attempts`);
        return null;
      }

      let totalValue = 0;
      let totalSize = 0;
      for (const t of matched) {
        const price = Number(t.price);
        const size = Number(t.size);
        if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
          totalValue += price * size;
          totalSize += size;
        }
      }
      return totalSize > 0 ? totalValue / totalSize : null;
    } catch {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
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

export function parseFillResult(res, final, requestedAmount, side) {
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

  // If final is null/undefined or status is unknown, we can't confirm a fill.
  // NEVER assume fill — fail closed to prevent phantom positions.
  if (!final || !st || st === "UNKNOWN") {
    return {
      ok: false,
      error: "order_status_unknown",
      orderID,
      status: st || "UNKNOWN",
      requestedAmount,
      filledShares: 0,
      side,
    };
  }

  const filledShares = matchedShares ?? requestedAmount;

  // NOTE: matchedPrice is the ORDER limit price (floor for sells, max for buys),
  // NOT the actual fill price. Mark as provisional so callers know to reconcile.
  const priceProvisional = matchedPrice != null;

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
    priceProvisional,
    raw: { res, final },
  };
}
