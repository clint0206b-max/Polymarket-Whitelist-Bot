#!/usr/bin/env node
/**
 * fetch_prices_from_metadata.mjs — Download CLOB price history for markets
 * already saved in a metadata JSONL file. Outputs enriched JSONL with priceHistory.
 *
 * Usage: node tools/fetch_prices_from_metadata.mjs <input.jsonl> <output.jsonl>
 *   e.g. node tools/fetch_prices_from_metadata.mjs state/journal/by_sport/dota2.jsonl state/journal/by_sport/dota2_with_prices.jsonl
 *
 * Features:
 *   - Resume: skips slugs already in output file
 *   - Concurrency: 30 parallel CLOB requests
 *   - Rate limit handling with exponential backoff
 *   - Progress logging every 100 markets
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";

const CLOB_PRICES = "https://clob.polymarket.com/prices-history";
const CONCURRENCY = 30;
const DELAY_BETWEEN_BATCHES_MS = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const wait = Math.min(5000, 1000 * (i + 1));
        console.log(`  [RATE_LIMIT] 429, waiting ${wait}ms...`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

async function fetchPriceHistory(tokenId) {
  if (!tokenId) return [];
  const url = `${CLOB_PRICES}?market=${tokenId}&interval=max&fidelity=1`;
  try {
    const data = await fetchJson(url);
    return data?.history || [];
  } catch { return []; }
}

function parseTokens(market) {
  const tokens = market.clobTokenIds;
  if (!tokens) return [null, null];
  try {
    const arr = typeof tokens === "string" ? JSON.parse(tokens) : tokens;
    return [arr[0] || null, arr[1] || null];
  } catch { return [null, null]; }
}

function parseOutcome(market) {
  const prices = market.outcomePrices;
  if (!prices) return null;
  try {
    const arr = typeof prices === "string" ? JSON.parse(prices) : prices;
    const p0 = parseFloat(arr[0]);
    if (p0 > 0.95) return "YES";
    if (p0 < 0.05) return "NO";
    return "UNKNOWN";
  } catch { return null; }
}

function loadExistingSlugs(outputPath) {
  const slugs = new Set();
  if (!existsSync(outputPath)) return slugs;
  const lines = readFileSync(outputPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try { const d = JSON.parse(line); if (d.slug) slugs.add(d.slug); } catch {}
  }
  return slugs;
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];

  if (!inputPath || !outputPath) {
    console.error("Usage: node tools/fetch_prices_from_metadata.mjs <input.jsonl> <output.jsonl>");
    process.exit(1);
  }

  // Load input markets
  const lines = readFileSync(inputPath, "utf8").split("\n").filter(Boolean);
  const markets = [];
  for (const line of lines) {
    try { markets.push(JSON.parse(line)); } catch {}
  }
  console.log(`Loaded ${markets.length} markets from ${inputPath}`);

  // Resume support
  const existing = loadExistingSlugs(outputPath);
  const todo = markets.filter(m => !existing.has(m.slug));
  console.log(`Already done: ${existing.size}, remaining: ${todo.length}`);

  if (!todo.length) { console.log("Nothing to do!"); return; }

  const startTime = Date.now();
  let processed = 0;
  let withHistory = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);

    const results = await Promise.all(batch.map(async (m) => {
      const [yesToken] = parseTokens(m);
      const priceHistory = await fetchPriceHistory(yesToken);
      const outcome = parseOutcome(m);
      const slug = m.slug;
      const prefix = String(slug || "").split("-")[0];

      return {
        slug,
        game: prefix,
        conditionId: m.conditionId,
        tokenId: yesToken,
        question: m.question || null,
        outcomes: m.outcomes,
        outcome,
        outcomePrices: m.outcomePrices,
        createdAt: m.createdAt,
        endDate: m.endDate || null,
        volume: m.volume || null,
        priceHistory,
      };
    }));

    // Write batch
    const outLines = results.map(r => JSON.stringify(r)).join("\n") + "\n";
    appendFileSync(outputPath, outLines);

    processed += batch.length;
    withHistory += results.filter(r => r.priceHistory.length > 0).length;

    if (processed % 100 === 0 || processed === todo.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (processed / elapsed * 60).toFixed(0);
      const pct = ((processed / todo.length) * 100).toFixed(1);
      console.log(`[${processed}/${todo.length}] ${pct}% | ${rate}/min | ${withHistory} with history | ${elapsed.toFixed(0)}s`);
    }

    if (i + CONCURRENCY < todo.length) await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone! ${processed} markets in ${totalSec}s | ${withHistory} with price history`);
}

main().catch(e => { console.error(e); process.exit(1); });
