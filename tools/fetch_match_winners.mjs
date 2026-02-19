#!/usr/bin/env node
/**
 * fetch_match_winners.mjs — Download match winner markets only.
 * 
 * Phase 1: Download metadata (no price history) — fast, 100/request
 * Phase 2: Filter match winners by slug pattern
 * Phase 3: Fetch price history only for match winners — 30 concurrent
 * 
 * Supports resume: skips slugs already in output file.
 * Output: state/journal/historical_match_winners.jsonl
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";

const OUTPUT = "state/journal/historical_match_winners.jsonl";
const GAMMA_BASE = "https://gamma-api.polymarket.com/markets";
const CLOB_PRICES = "https://clob.polymarket.com/prices-history";
const BATCH_SIZE = 100;
const CONCURRENCY = 30;
const DELAY_MS = 30; // between metadata pages

// Per-prefix caps (estimated to yield ~10k+ match winners)
const PREFIXES = [
  { prefix: "cs2-",   cap: 25_000 },   // ~20% MW = ~5,000
  { prefix: "dota2-", cap: 60_000 },   // ~7% MW  = ~4,200
  { prefix: "lol-",   cap: 60_000 },   // ~4% MW  = ~2,400
  { prefix: "val-",   cap: 10_000 },   // ~50% MW = ~5,000
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const wait = Math.min(8000, 1000 * (i + 1));
        console.log(`  [429] waiting ${wait}ms...`);
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

function isMatchWinner(slug) {
  const excludes = ['spread','total','handicap','kill-over','kill-under',
                    'first-blood','first-tower','first-baron','first-dragon',
                    'first-rift','most-kill','set-total','match-total',
                    'first-set','map-handicap'];
  for (const ex of excludes) {
    if (slug.includes(ex)) return false;
  }
  return true;
}

function inferLeague(slug) {
  const prefix = slug.split("-")[0];
  if (["cs2","dota2","lol","val","sc2","hok","r6siege","codmw"].includes(prefix)) return "esports";
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
  try {
    const data = await fetchJson(`${CLOB_PRICES}?market=${tokenId}&interval=max&fidelity=1`);
    return data?.history || [];
  } catch { return []; }
}

async function main() {
  const startTime = Date.now();
  mkdirSync("state/journal", { recursive: true });
  const existingSlugs = loadExistingSlugs();
  console.log(`[START] ${existingSlugs.size} already in file\n`);

  // ===== PHASE 1: Metadata only (no price history) =====
  console.log("[PHASE 1] Downloading metadata...");
  let allMetadata = [];

  for (const { prefix, cap } of PREFIXES) {
    let offset = 0;
    let count = 0;
    while (offset < cap) {
      const url = `${GAMMA_BASE}?closed=true&limit=${BATCH_SIZE}&offset=${offset}&slug_contains=${prefix}&order=createdAt&ascending=false`;
      let batch;
      try { batch = await fetchJson(url); } catch (e) {
        console.log(`  [ERROR] ${prefix} offset=${offset}: ${e.message}`);
        break;
      }
      if (!batch || !batch.length) break;
      allMetadata.push(...batch);
      count += batch.length;
      offset += BATCH_SIZE;
      if (offset % 2000 === 0) {
        console.log(`  [${prefix}] ${count} fetched (offset=${offset})`);
      }
      await sleep(DELAY_MS);
    }
    console.log(`  ${prefix}: ${count} total`);
  }

  console.log(`\n[PHASE 1] ${allMetadata.length} raw markets downloaded`);

  // ===== PHASE 2: Filter match winners =====
  console.log("\n[PHASE 2] Filtering match winners...");
  
  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const m of allMetadata) {
    const key = m.conditionId || m.slug;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(m);
  }
  
  const matchWinners = unique.filter(m => isMatchWinner(m.slug));
  const resolved = matchWinners.filter(m => {
    const outcome = parseOutcome(m);
    return outcome === "YES" || outcome === "NO";
  });

  console.log(`  Unique: ${unique.length}`);
  console.log(`  Match winners: ${matchWinners.length}`);
  console.log(`  Resolved (YES/NO): ${resolved.length}`);
  
  // Count by game
  const byCat = {};
  for (const m of resolved) {
    const game = m.slug.split("-")[0];
    byCat[game] = (byCat[game] || 0) + 1;
  }
  for (const [g, c] of Object.entries(byCat).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${g}: ${c}`);
  }

  // ===== PHASE 3: Price history for match winners only =====
  const toFetch = resolved.filter(m => !existingSlugs.has(m.slug));
  console.log(`\n[PHASE 3] Fetching price history for ${toFetch.length} markets (skipping ${resolved.length - toFetch.length} existing)...`);
  
  const stats = { downloaded: 0, errors: 0 };
  
  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    
    const tasks = batch.map(async (m) => {
      const [yesToken] = parseTokens(m);
      const priceHistory = await fetchPriceHistory(yesToken);
      const outcome = parseOutcome(m);
      const game = m.slug.split("-")[0];

      const entry = {
        slug: m.slug,
        game,
        league: inferLeague(m.slug),
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
      } catch { stats.errors++; }
    });

    await Promise.all(tasks);
    await sleep(DELAY_MS);

    if ((stats.downloaded + stats.errors) % 500 === 0 || i + CONCURRENCY >= toFetch.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = stats.downloaded > 0 ? (stats.downloaded / (elapsed / 60)).toFixed(0) : 0;
      console.log(`  [PROGRESS] ${stats.downloaded}/${toFetch.length} | ${stats.errors} errors | ${elapsed}s | ${rate}/min`);
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n[DONE]`);
  console.log(`  Downloaded: ${stats.downloaded}`);
  console.log(`  Skipped: ${existingSlugs.size}`);
  console.log(`  Errors: ${stats.errors}`);
  console.log(`  Total in file: ${existingSlugs.size + stats.downloaded}`);
  console.log(`  Time: ${totalElapsed}s`);
  console.log(`  Output: ${OUTPUT}`);
}

main().catch(e => { console.error("[FATAL]", e); process.exit(1); });
