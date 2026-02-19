#!/usr/bin/env node
/**
 * fetch_metadata.mjs — Download raw market metadata only (no price history).
 * Saves incrementally to JSONL. Supports resume.
 * 
 * Usage: node tools/fetch_metadata.mjs [prefix] [cap]
 * Example: node tools/fetch_metadata.mjs dota2- 100000
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";

const PREFIX = process.argv[2] || "dota2-";
const CAP = parseInt(process.argv[3] || "100000", 10);
const OUTPUT = `state/journal/metadata_${PREFIX.replace("-","")}.jsonl`;
const GAMMA_BASE = "https://gamma-api.polymarket.com/markets";
const BATCH_SIZE = 100;
const DELAY_MS = 30;

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

const OFFSET_FILE = OUTPUT + ".offset";

function loadExisting() {
  const slugs = new Set();
  if (!existsSync(OUTPUT)) return { slugs, count: 0, lastOffset: 0 };
  const lines = readFileSync(OUTPUT, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try { const d = JSON.parse(line); if (d.slug) slugs.add(d.slug); } catch {}
  }
  let lastOffset = 0;
  if (existsSync(OFFSET_FILE)) {
    try { lastOffset = parseInt(readFileSync(OFFSET_FILE, "utf8").trim(), 10) || 0; } catch {}
  }
  return { slugs, count: slugs.size, lastOffset };
}

async function main() {
  const startTime = Date.now();
  mkdirSync("state/journal", { recursive: true });
  const { slugs: existing, count: existingCount, lastOffset } = loadExisting();
  console.log(`[START] prefix=${PREFIX} cap=${CAP} output=${OUTPUT}`);
  console.log(`[RESUME] ${existingCount} already in file, lastOffset=${lastOffset}\n`);

  let offset = lastOffset;
  let total = 0;
  let newCount = 0;
  let dupes = 0;

  while (offset < CAP) {
    const url = `${GAMMA_BASE}?closed=true&limit=${BATCH_SIZE}&offset=${offset}&slug_contains=${PREFIX}&order=createdAt&ascending=false`;
    let batch;
    try { batch = await fetchJson(url); } catch (e) {
      console.log(`[ERROR] offset=${offset}: ${e.message}`);
      break;
    }
    if (!batch || !batch.length) {
      console.log(`[END] No more results at offset=${offset}`);
      break;
    }

    let batchNew = 0;
    for (const m of batch) {
      total++;
      if (existing.has(m.slug)) { dupes++; continue; }
      existing.add(m.slug);
      appendFileSync(OUTPUT, JSON.stringify(m) + "\n");
      newCount++;
      batchNew++;
    }

    offset += BATCH_SIZE;
    if (offset % 5000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`[${offset}] +${newCount} new | ${dupes} dupes | ${elapsed}s`);
      // Save offset for resume
      try { writeFileSync(OFFSET_FILE, String(offset)); } catch {}
    }
    await sleep(DELAY_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n[DONE]`);
  console.log(`  Fetched: ${total}`);
  console.log(`  New: ${newCount}`);
  console.log(`  Dupes: ${dupes}`);
  console.log(`  Total in file: ${existingCount + newCount}`);
  console.log(`  Time: ${elapsed}s`);
  console.log(`  Output: ${OUTPUT}`);
}

main().catch(e => { console.error("[FATAL]", e); process.exit(1); });
