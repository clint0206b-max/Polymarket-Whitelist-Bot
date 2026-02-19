#!/usr/bin/env node
/**
 * fetch_all_metadata.mjs — Download ALL closed market metadata.
 * No slug filter (Gamma API ignores it anyway).
 * Saves incrementally. Resumes from last offset.
 * 
 * Usage: node tools/fetch_all_metadata.mjs [cap]
 * Example: node tools/fetch_all_metadata.mjs 500000
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CAP = parseInt(process.argv[2] || "500000", 10);
const OUTPUT = "state/journal/metadata_all.jsonl";
const OFFSET_FILE = OUTPUT + ".offset";
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

function loadState() {
  let lastOffset = 0;
  let lineCount = 0;
  if (existsSync(OFFSET_FILE)) {
    try { lastOffset = parseInt(readFileSync(OFFSET_FILE, "utf8").trim(), 10) || 0; } catch {}
  }
  if (existsSync(OUTPUT)) {
    // Count lines without loading all slugs into memory (file is huge)
    const buf = readFileSync(OUTPUT);
    for (let i = 0; i < buf.length; i++) { if (buf[i] === 10) lineCount++; }
  }
  return { lastOffset, lineCount };
}

async function main() {
  const startTime = Date.now();
  mkdirSync("state/journal", { recursive: true });
  const { lastOffset, lineCount } = loadState();
  
  console.log(`[START] cap=${CAP} output=${OUTPUT}`);
  console.log(`[RESUME] ${lineCount} lines in file, starting at offset=${lastOffset}\n`);

  let offset = lastOffset;
  let newCount = 0;
  let emptyPages = 0;

  while (offset < CAP) {
    const url = `${GAMMA_BASE}?closed=true&limit=${BATCH_SIZE}&offset=${offset}&order=createdAt&ascending=false`;
    let batch;
    try { batch = await fetchJson(url); } catch (e) {
      console.log(`[ERROR] offset=${offset}: ${e.message}`);
      // Save progress and retry next run
      writeFileSync(OFFSET_FILE, String(offset));
      break;
    }
    
    if (!batch || !batch.length) {
      emptyPages++;
      if (emptyPages >= 3) {
        console.log(`[END] No more results at offset=${offset}`);
        break;
      }
      offset += BATCH_SIZE;
      continue;
    }
    emptyPages = 0;

    for (const m of batch) {
      appendFileSync(OUTPUT, JSON.stringify(m) + "\n");
      newCount++;
    }

    offset += BATCH_SIZE;
    
    if (offset % 10000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (newCount / (elapsed / 60)).toFixed(0);
      writeFileSync(OFFSET_FILE, String(offset));
      console.log(`[${offset}] +${newCount} new | ${elapsed}s | ${rate}/min`);
    }
    await sleep(DELAY_MS);
  }

  writeFileSync(OFFSET_FILE, String(offset));
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n[DONE] +${newCount} new | total in file: ${lineCount + newCount} | offset: ${offset} | ${elapsed}s`);
}

main().catch(e => { console.error("[FATAL]", e); process.exit(1); });
