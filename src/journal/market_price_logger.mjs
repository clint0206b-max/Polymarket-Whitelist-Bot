/**
 * market_price_logger.mjs — Logs bid/ask prices for ALL watched markets.
 *
 * Smart logging:
 * - Only logs when price changes >= DELTA_THRESHOLD from last log
 * - Heartbeat: logs at least once every HEARTBEAT_MS even without change
 * - Daily file rotation: state/journal/market_prices/YYYY-MM-DD.jsonl
 * - Auto-cleanup: deletes files older than RETENTION_DAYS
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DIR = "state/journal/market_prices";
const DELTA_THRESHOLD = 0.02;    // min price change to trigger a log
const HEARTBEAT_MS = 5 * 60_000; // 5 min heartbeat
const RETENTION_DAYS = 14;

// In-memory state: last logged values per slug
const _lastLog = new Map(); // slug -> { bid, ask, ts }
let _lastCleanup = 0;

function todayFile() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return join(DIR, `${yyyy}-${mm}-${dd}.jsonl`);
}

function shouldLog(slug, bid, ask, now) {
  const prev = _lastLog.get(slug);
  if (!prev) return true;

  // Heartbeat: log if it's been > HEARTBEAT_MS
  if (now - prev.ts >= HEARTBEAT_MS) return true;

  // Delta: log if bid or ask changed enough
  if (Math.abs((bid || 0) - (prev.bid || 0)) >= DELTA_THRESHOLD) return true;
  if (Math.abs((ask || 0) - (prev.ask || 0)) >= DELTA_THRESHOLD) return true;

  return false;
}

/**
 * Log a market price tick. Call for every market on every eval cycle.
 * Internally decides whether to actually write based on delta/heartbeat.
 */
export function logMarketPrice(slug, bid, ask, league) {
  const now = Date.now();

  if (!shouldLog(slug, bid, ask, now)) return;

  try {
    mkdirSync(DIR, { recursive: true });

    const entry = {
      ts: now,
      slug,
      league: league || null,
      bid: bid != null ? +bid.toFixed(4) : null,
      ask: ask != null ? +ask.toFixed(4) : null,
      spread: (bid != null && ask != null) ? +(ask - bid).toFixed(4) : null,
    };

    appendFileSync(todayFile(), JSON.stringify(entry) + "\n");
    _lastLog.set(slug, { bid, ask, ts: now });
  } catch { /* non-critical — don't crash the loop */ }

  // Cleanup old files periodically (once per hour max)
  if (now - _lastCleanup > 3600_000) {
    _lastCleanup = now;
    cleanupOldFiles();
  }
}

/**
 * Remove a slug from tracking (e.g., market resolved/purged).
 */
export function removeSlug(slug) {
  _lastLog.delete(slug);
}

function cleanupOldFiles() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
    const files = readdirSync(DIR).filter(f => f.endsWith(".jsonl"));
    for (const f of files) {
      // Parse date from filename: YYYY-MM-DD.jsonl
      const match = f.match(/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
      if (!match) continue;
      const fileDate = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`).getTime();
      if (fileDate < cutoff) {
        unlinkSync(join(DIR, f));
      }
    }
  } catch { /* best effort */ }
}

/**
 * Get logger stats for health/debug.
 */
export function getStats() {
  return {
    tracked_slugs: _lastLog.size,
    delta_threshold: DELTA_THRESHOLD,
    heartbeat_ms: HEARTBEAT_MS,
    retention_days: RETENTION_DAYS,
  };
}
