#!/usr/bin/env node
/**
 * fetch_historical.mjs — Download historical Polymarket markets
 * with full price history for backtesting.
 *
 * Uses slug_contains to search by game prefix (cs2-, dota2-, lol-, cbb-, nba-).
 * Parallel price history fetching (10 concurrent).
 * Supports resume: skips already-downloaded slugs.
 *
 * Output: state/journal/historical_markets.jsonl
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";

const OUTPUT = "state/journal/historical_markets.jsonl";
const GAMMA_BASE = "https://gamma-api.polymarket.com/markets";
const CLOB_PRICES = "https://clob.polymarket.com/prices-history";
const BATCH_SIZE = 100;
const CONCURRENCY = 30;
const DELAY_BETWEEN_BATCHES_MS = 50;
const MAX_PER_PREFIX = 10_000; // cap metadata fetch per prefix
const PREFIXES = ["cs2-", "dota2-", "lol-", "cbb-", "nba-"];

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

function inferLeague(slug) {
  const prefix = String(slug || "").split("-")[0];
  if (prefix === "cs2" || prefix === "dota2" || prefix === "lol" || prefix === "val") return "esports";
  if (prefix === "cbb") return "cbb";
  if (prefix === "nba") return "nba";
  return prefix;
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

function parseTokens(market) {
  const tokens = market.clobTokenIds;
  if (!tokens) return [null, null];
  try {
    const arr = typeof tokens === "string" ? JSON.parse(tokens) : tokens;
    return [arr[0] || null, arr[1] || null];
  } catch { return [null, null]; }
}

function loadExistingSlugs() {
  const slugs = new Set();
  if (!existsSync(OUTPUT)) return slugs;
  const lines = readFileSync(OUTPUT, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try { const d = JSON.parse(line); if (d.slug) slugs.add(d.slug); } catch {}
  }
  return slugs;
}

async function fetchPriceHistory(tokenId) {
  if (!tokenId) return [];
  const url = `${CLOB_PRICES}?market=${tokenId}&interval=max&fidelity=1`;
  try {
    const data = await fetchJson(url);
    return data?.history || [];
  } catch { return []; }
}

// Fetch all market metadata for a slug prefix
async function fetchMarketsForPrefix(prefix) {
  const markets = [];
  let offset = 0;
  while (true) {
    const url = `${GAMMA_BASE}?closed=true&limit=${BATCH_SIZE}&offset=${offset}&slug_contains=${prefix}&order=createdAt&ascending=false`;
    let batch;
    try {
      batch = await fetchJson(url);
    } catch (e) {
      console.log(`  [ERROR] ${prefix} offset=${offset}: ${e.message}`);
      break;
    }
    if (!batch || !batch.length) break;
    markets.push(...batch);
    if (offset % 500 === 0) {
      console.log(`  [${prefix}] offset=${offset} → ${markets.length} total`);
    }
    offset += BATCH_SIZE;
    await sleep(DELAY_BETWEEN_BATCHES_MS);
    if (offset >= MAX_PER_PREFIX) {
      console.log(`  [${prefix}] hit cap at ${MAX_PER_PREFIX}`);
      break;
    }
  }
  return markets;
}

// Process a batch of markets in parallel (fetch price history + write)
async function processBatch(batch, existingSlugs, stats) {
  const tasks = batch.map(async (m) => {
    if (existingSlugs.has(m.slug)) { stats.skipped++; return; }

    const [yesToken] = parseTokens(m);
    const priceHistory = await fetchPriceHistory(yesToken);
    const outcome = parseOutcome(m);
    const league = inferLeague(m.slug);

    const entry = {
      slug: m.slug,
      league,
      conditionId: m.conditionId,
      tokenId: yesToken,
      question: m.question || null,
      outcome,
      outcomePrices: m.outcomePrices,
      createdAt: m.createdAt,
      endDate: m.endDate || null,
      volume: m.volume || null,
      priceHistory,
    };

    try {
      appendFileSync(OUTPUT, JSON.stringify(entry) + "\n");
      stats.downloaded++;
    } catch (e) {
      stats.errors++;
    }
  });

  await Promise.all(tasks);
}

async function main() {
  const startTime = Date.now();
  console.log("[FETCH] Starting full historical download...");
  console.log(`[FETCH] Prefixes: ${PREFIXES.join(", ")}`);
  console.log(`[FETCH] Concurrency: ${CONCURRENCY}\n`);

  mkdirSync("state/journal", { recursive: true });
  const existingSlugs = loadExistingSlugs();
  console.log(`[FETCH] ${existingSlugs.size} markets already in file (will skip)\n`);

  // Phase 1: Fetch all market metadata
  console.log("[PHASE 1] Fetching market metadata...");
  let allMarkets = [];
  for (const prefix of PREFIXES) {
    const markets = await fetchMarketsForPrefix(prefix);
    console.log(`  ${prefix}: ${markets.length} markets`);
    allMarkets.push(...markets);
  }

  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const m of allMarkets) {
    const key = m.conditionId || m.slug;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(m);
  }
  console.log(`\n[PHASE 1] ${allMarkets.length} raw → ${unique.length} unique markets`);

  const toFetch = unique.filter(m => !existingSlugs.has(m.slug));
  console.log(`[PHASE 1] ${toFetch.length} new (skipping ${unique.length - toFetch.length} existing)\n`);

  // Phase 2: Fetch price histories in parallel batches
  console.log("[PHASE 2] Fetching price histories...");
  const stats = { downloaded: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    await processBatch(batch, existingSlugs, stats);
    await sleep(DELAY_BETWEEN_BATCHES_MS);

    if ((stats.downloaded + stats.errors) % 500 === 0 || i + CONCURRENCY >= toFetch.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = stats.downloaded > 0 ? (stats.downloaded / (elapsed / 60)).toFixed(0) : 0;
      console.log(`  [PROGRESS] ${stats.downloaded}/${toFetch.length} downloaded | ${stats.errors} errors | ${elapsed}s elapsed | ${rate}/min`);
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n[FETCH] Done!`);
  console.log(`  Downloaded: ${stats.downloaded}`);
  console.log(`  Skipped (existing): ${existingSlugs.size}`);
  console.log(`  Errors: ${stats.errors}`);
  console.log(`  Total in file: ${existingSlugs.size + stats.downloaded}`);
  console.log(`  Time: ${totalElapsed}s`);
  console.log(`  Output: ${OUTPUT}`);
}

main().catch(e => { console.error("[FATAL]", e); process.exit(1); });
