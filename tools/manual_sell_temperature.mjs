#!/usr/bin/env node
/**
 * One-shot manual sell of all temperature positions.
 * Usage: node tools/manual_sell_temperature.mjs
 * 
 * Sells at current bid (floor = bid - 0.01 for slippage tolerance).
 * Does NOT modify bot state — the bot's reconcilePositions will detect
 * the sells via CLOB trade history and close positions automatically.
 */

import { readFileSync } from "node:fs";
import { initClient, executeSell, getConditionalBalance } from "../src/execution/order_executor.mjs";

const CREDENTIALS = process.env.POLY_CREDENTIALS || 
  new URL("../../.polymarket-credentials.json", import.meta.url).pathname;
const EXEC_STATE_PATH = new URL("../state/execution_state.json", import.meta.url).pathname;
const FUNDER = "0xddb60e6980B311997F75CDA0028080E46fACeBFA";

async function main() {
  const { client } = initClient(CREDENTIALS, FUNDER);
  const execState = JSON.parse(readFileSync(EXEC_STATE_PATH, "utf8"));

  // Find all open temperature buys
  const tempBuys = [];
  for (const [tid, t] of Object.entries(execState.trades || {})) {
    if (t.side !== "BUY" || t.status !== "filled" || t.closed) continue;
    if (!t.slug?.includes("temperature")) continue;
    tempBuys.push({ tradeId: tid, ...t });
  }

  console.log(`Found ${tempBuys.length} temperature positions to sell\n`);

  let totalReceived = 0;
  let totalSpent = 0;
  let sold = 0;
  let failed = 0;

  for (const buy of tempBuys) {
    const tokenId = buy.tokenId;
    const slug = buy.slug;

    // Get actual on-chain balance
    let shares;
    try {
      shares = await getConditionalBalance(client, tokenId);
      if (shares < 0.01) {
        console.log(`[SKIP] ${slug} | balance=${shares} (already empty)`);
        continue;
      }
    } catch (e) {
      console.log(`[SKIP] ${slug} | balance check failed: ${e.message}`);
      continue;
    }

    // Get current book to find best bid
    let bestBid = null;
    try {
      const book = await client.getOrderBook(tokenId);
      const bids = book?.bids || [];
      if (bids.length > 0) {
        bestBid = parseFloat(bids[0].price);
      }
    } catch (e) {
      console.log(`[WARN] ${slug} | book fetch failed: ${e.message}`);
    }

    if (!bestBid || bestBid < 0.01) {
      console.log(`[WARN] ${slug} | no bids in book, trying floor=0.01`);
      bestBid = 0.01;
    }

    // Sell with floor = bid - 0.02 (small slippage tolerance)
    const floor = Math.max(0.01, bestBid - 0.02);
    console.log(`[SELL] ${slug} | shares=${shares.toFixed(4)} | bestBid=${bestBid} | floor=${floor.toFixed(3)}`);

    try {
      const result = await executeSell(client, tokenId, shares, floor);
      if (result.ok) {
        const received = (result.avgFillPrice || floor) * (result.filledShares || shares);
        const spent = (buy.avgFillPrice || buy.entryPrice || 0.98) * (buy.filledShares || shares);
        totalReceived += received;
        totalSpent += spent;
        sold++;
        console.log(`  ✅ SOLD | filled=${result.filledShares?.toFixed(4)} @ ${result.avgFillPrice?.toFixed(4)} | received=$${received.toFixed(2)} | pnl=$${(received - spent).toFixed(2)}`);
      } else {
        failed++;
        console.log(`  ❌ FAILED | ${result.error || "unknown"}`);
        
        // If floor was too high, retry with lower floor
        if (result.error === "order_status_unknown" || result.error === "no_fill") {
          const retryFloor = Math.max(0.01, floor - 0.05);
          console.log(`  [RETRY] floor=${retryFloor.toFixed(3)}`);
          const retry = await executeSell(client, tokenId, shares, retryFloor);
          if (retry.ok) {
            const received = (retry.avgFillPrice || retryFloor) * (retry.filledShares || shares);
            const spent = (buy.avgFillPrice || 0.98) * (buy.filledShares || shares);
            totalReceived += received;
            totalSpent += spent;
            sold++;
            failed--;
            console.log(`  ✅ RETRY SOLD | filled=${retry.filledShares?.toFixed(4)} @ ${retry.avgFillPrice?.toFixed(4)} | received=$${received.toFixed(2)}`);
          } else {
            console.log(`  ❌ RETRY FAILED | ${retry.error || "unknown"}`);
          }
        }
      }
    } catch (e) {
      failed++;
      console.log(`  ❌ EXCEPTION | ${e.message}`);
    }

    // Small delay between sells
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Sold: ${sold}/${tempBuys.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total received: $${totalReceived.toFixed(2)}`);
  console.log(`Total spent: $${totalSpent.toFixed(2)}`);
  console.log(`Net PnL: $${(totalReceived - totalSpent).toFixed(2)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
