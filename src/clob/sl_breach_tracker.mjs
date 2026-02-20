// sl_breach_tracker.mjs
// Micro-B: measures latency between WS detecting an SL breach and the loop acting on it.
// Does NOT trigger any action — only observes and records.
//
// Usage:
//   1. Loop calls .configure(positions) each cycle with current SL params per token
//   2. WS calls .onPriceUpdate(tokenId, bid, ask, wsHealthy) on each price update
//   3. Loop calls .onLoopSLDetected(tokenId) when it acts on SL
//   4. Health endpoint reads .getStats()

export class SLBreachTracker {
  constructor() {
    // tokenId → { slBid, spreadMax, emergencyBid, slug }
    this.positions = new Map();

    // tokenId → { breachTs, breachBid, breachSpread, wsHealthy }
    // Only one open episode per token (first breach starts it)
    this.episodes = new Map();

    // Aggregated stats
    this.stats = {
      episodes_opened: 0,
      episodes_acted: 0,    // loop detected and acted
      episodes_recovered: 0, // price went back above SL
      deltas_ms: [],         // acted deltas for percentile calc (capped at 200 entries)
    };

    // Cooldown: don't re-open episode for same token within 2s of close
    // tokenId → lastCloseTs
    this.cooldowns = new Map();
    this.cooldownMs = 2000;
  }

  /**
   * Called by the loop each cycle: register which tokens have positions and their SL params.
   * Pass null/empty to clear.
   */
  configure(positions) {
    // positions: Array<{ tokenId, slBid, spreadMax, emergencyBid, slug }>
    this.positions.clear();
    if (!positions) return;
    for (const p of positions) {
      if (p.tokenId && p.slBid > 0) {
        this.positions.set(String(p.tokenId), {
          slBid: p.slBid,
          askBuffer: p.askBuffer ?? 0.10,
          slug: p.slug || "unknown",
        });
      }
    }

    // Clean up episodes for tokens no longer in positions
    for (const token of this.episodes.keys()) {
      if (!this.positions.has(token)) {
        this.episodes.delete(token);
      }
    }
  }

  /**
   * Called by WS handleMessage on every price update for any token.
   * Lightweight: returns immediately if token has no position.
   */
  onPriceUpdate(tokenId, bid, ask, wsHealthy = true) {
    const id = String(tokenId);
    const pos = this.positions.get(id);
    if (!pos) return; // No position for this token

    const bidTriggered = bid <= pos.slBid;
    const askMax = pos.slBid + (pos.askBuffer ?? 0.10);
    const askConfirms = ask > 0 && ask <= askMax;
    const slBreached = bidTriggered && askConfirms;

    const existing = this.episodes.get(id);

    if (slBreached && !existing) {
      // Check cooldown
      const lastClose = this.cooldowns.get(id) || 0;
      if (Date.now() - lastClose < this.cooldownMs) return;

      // Open new episode
      this.episodes.set(id, {
        breachTs: Date.now(),
        breachBid: bid,
        breachAsk: ask,
        wsHealthy,
        slug: pos.slug,
      });
      this.stats.episodes_opened++;
    } else if (!slBreached && existing) {
      // Price recovered — close episode as recovered
      this.episodes.delete(id);
      this.stats.episodes_recovered++;
      this.cooldowns.set(id, Date.now());
    }
    // If slBreached && existing: episode already open, do nothing (first breach wins)
  }

  /**
   * Called by the loop when it detects SL and acts (generates signal_close).
   * Returns the delta_ms if there was an open episode, or null.
   */
  onLoopSLDetected(tokenId) {
    const id = String(tokenId);
    const episode = this.episodes.get(id);
    if (!episode) return null;

    const delta = Date.now() - episode.breachTs;
    this.episodes.delete(id);
    this.stats.episodes_acted++;
    this.cooldowns.set(id, Date.now());

    // Store delta for percentile calc (cap at 200)
    this.stats.deltas_ms.push(delta);
    if (this.stats.deltas_ms.length > 200) {
      this.stats.deltas_ms.shift();
    }

    // Log only if notable (>3s or WS was unhealthy)
    if (delta > 3000 || !episode.wsHealthy) {
      console.log(`[SL_BREACH] ${episode.slug} | delta=${delta}ms | ws_healthy=${episode.wsHealthy} | breach_bid=${episode.breachBid}`);
    }

    return delta;
  }

  /**
   * Stats for health endpoint.
   */
  getStats() {
    const deltas = this.stats.deltas_ms;
    const sorted = [...deltas].sort((a, b) => a - b);
    const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : null;
    const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : null;
    const max = sorted.length > 0 ? sorted[sorted.length - 1] : null;

    return {
      episodes_opened: this.stats.episodes_opened,
      episodes_acted: this.stats.episodes_acted,
      episodes_recovered: this.stats.episodes_recovered,
      active_episodes: this.episodes.size,
      delta_p50_ms: p50,
      delta_p95_ms: p95,
      delta_max_ms: max,
      sample_count: deltas.length,
    };
  }
}
