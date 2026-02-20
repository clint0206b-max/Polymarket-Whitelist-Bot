/**
 * ws_price_logger.mjs — Logs real-time WS price ticks for all subscribed markets.
 *
 * Hooks into CLOBWebSocketClient._updatePrice for sub-second resolution.
 * Throttled to max 1 write per token per THROTTLE_MS to avoid disk explosion.
 *
 * Output: state/journal/ws_ticks/YYYY-MM-DD.jsonl
 * Schema: {ts, token_id, slug, league, bid, ask}
 *
 * ~6MB/day estimated at 5s throttle with ~200 active tokens.
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DIR = "state/journal/ws_ticks";
const THROTTLE_MS = 5_000;      // max 1 log per token per 5s
const RETENTION_DAYS = 30;

export class WSPriceLogger {
  constructor() {
    this._tokenMeta = new Map();   // tokenId → { slug, league }
    this._lastWrite = new Map();   // tokenId → timestamp of last write
    this._lastCleanup = 0;
    this._currentFile = null;
    this._currentDate = null;
    this._dirReady = false;
    this._writes = 0;
    this._throttled = 0;
  }

  /**
   * Register a token → slug/league mapping.
   * Call this when subscribing tokens in the loop.
   */
  register(tokenId, slug, league) {
    this._tokenMeta.set(String(tokenId), { slug: slug || null, league: league || null });
  }

  /**
   * Called from WS client on every price update.
   * Decides whether to log based on throttle.
   */
  onPriceUpdate(tokenId, bid, ask) {
    const id = String(tokenId);
    const now = Date.now();

    // Throttle: skip if last write was < THROTTLE_MS ago
    const lastTs = this._lastWrite.get(id) || 0;
    if (now - lastTs < THROTTLE_MS) {
      this._throttled++;
      return;
    }

    const meta = this._tokenMeta.get(id);
    const entry = {
      ts: now,
      token_id: id,
      slug: meta?.slug || null,
      league: meta?.league || null,
      bid: bid != null ? +bid.toFixed(4) : null,
      ask: ask != null ? +ask.toFixed(4) : null,
    };

    try {
      this._ensureDir();
      appendFileSync(this._getFile(), JSON.stringify(entry) + "\n");
      this._lastWrite.set(id, now);
      this._writes++;
    } catch { /* non-critical — don't crash the WS handler */ }

    // Periodic cleanup (once per hour)
    if (now - this._lastCleanup > 3_600_000) {
      this._lastCleanup = now;
      this._cleanup();
    }
  }

  _ensureDir() {
    if (!this._dirReady) {
      mkdirSync(DIR, { recursive: true });
      this._dirReady = true;
    }
  }

  _getFile() {
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (dateStr !== this._currentDate) {
      this._currentDate = dateStr;
      this._currentFile = join(DIR, `${dateStr}.jsonl`);
    }
    return this._currentFile;
  }

  _cleanup() {
    try {
      const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
      const files = readdirSync(DIR).filter(f => f.endsWith(".jsonl"));
      for (const f of files) {
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
   * Stats for health endpoint / debugging.
   */
  getStats() {
    return {
      registered_tokens: this._tokenMeta.size,
      active_tokens: this._lastWrite.size,
      total_writes: this._writes,
      total_throttled: this._throttled,
      throttle_ms: THROTTLE_MS,
    };
  }
}
