/**
 * balance_cache.mjs — Caches USDC balance and computes total portfolio value
 * for dynamic position sizing (percent of total balance).
 */

/**
 * Create a balance cache instance.
 * @param {object} opts
 * @param {Function} opts.getBalanceFn - async () => number (cash USDC)
 * @param {number} [opts.maxAgeMs=300000] - max age before fallback (5 min)
 * @param {number} [opts.fallbackUsd=10] - fallback if no cached value
 */
export function createBalanceCache(opts = {}) {
  const maxAgeMs = Number(opts.maxAgeMs) || 300000;
  const fallbackUsd = Number(opts.fallbackUsd) || 10;
  const getBalanceFn = opts.getBalanceFn || null;

  let _lastCashUsd = null;
  let _lastFetchTs = 0;
  let _cashSpentThisLoop = 0;

  return {
    /**
     * Refresh cash balance from API. Call once per loop.
     * Returns { cashUsd, fromCache, error }
     */
    async refresh() {
      _cashSpentThisLoop = 0; // reset per-loop spend tracker
      if (!getBalanceFn) return { cashUsd: _lastCashUsd, fromCache: true, error: "no_fetch_fn" };
      try {
        const cash = await getBalanceFn();
        if (Number.isFinite(cash) && cash >= 0) {
          _lastCashUsd = cash;
          _lastFetchTs = Date.now();
          return { cashUsd: cash, fromCache: false, error: null };
        }
        return { cashUsd: _lastCashUsd, fromCache: true, error: "invalid_value" };
      } catch (e) {
        return { cashUsd: _lastCashUsd, fromCache: true, error: e.message };
      }
    },

    /**
     * Get current cash (last fetched value, adjusted for intra-loop spend).
     * Returns null if never fetched and stale.
     */
    getCashUsd() {
      if (_lastCashUsd == null) return null;
      const age = Date.now() - _lastFetchTs;
      if (age > maxAgeMs) return null; // too stale
      return Math.max(0, _lastCashUsd - _cashSpentThisLoop);
    },

    /**
     * Get raw cached cash (without spend adjustment). For total balance calc.
     */
    getRawCashUsd() {
      if (_lastCashUsd == null) return null;
      const age = Date.now() - _lastFetchTs;
      if (age > maxAgeMs) return null;
      return _lastCashUsd;
    },

    /**
     * Record cash spent on a buy this loop.
     */
    recordSpend(usd) {
      _cashSpentThisLoop += Number(usd) || 0;
    },

    /**
     * Compute total portfolio balance.
     * @param {Array} openTrades - trades with { filledShares, slug, closed }
     * @param {Map} pricesBySlug - Map<slug, { yes_best_bid }>
     * @returns {{ totalBalance, cashUsd, positionsValue, breakdown }}
     */
    computeTotalBalance(openTrades, pricesBySlug) {
      const cashUsd = this.getRawCashUsd();
      let positionsValue = 0;
      const breakdown = [];

      for (const t of openTrades) {
        const prices = pricesBySlug?.get(t.slug);
        const bid = prices?.yes_best_bid;
        const shares = Number(t.filledShares || 0);
        let value = 0;
        if (Number.isFinite(bid) && bid > 0 && shares > 0) {
          value = shares * bid;
        } else if (shares > 0) {
          // No current bid — use entry price as conservative estimate
          value = shares * Number(t.entryPrice || t.avgFillPrice || 0);
        }
        positionsValue += value;
        breakdown.push({ slug: t.slug, shares, bid: bid ?? null, value });
      }

      const totalBalance = (cashUsd ?? 0) + positionsValue;
      return { totalBalance, cashUsd, positionsValue, breakdown };
    },

    /**
     * Calculate trade size based on sizing config.
     * @param {object} sizingCfg - { mode, percent, fixed_usd, fallback_fixed_usd }
     * @param {Array} openTrades
     * @param {Map} pricesBySlug
     * @returns {{ budgetUsd, method, totalBalance, cashAvailable, detail }}
     */
    calculateTradeSize(sizingCfg, openTrades, pricesBySlug) {
      const mode = sizingCfg?.mode || "fixed";

      if (mode === "fixed") {
        const fixed = Number(sizingCfg?.fixed_usd ?? 10);
        return { budgetUsd: fixed, method: "fixed", totalBalance: null, cashAvailable: null, detail: null };
      }

      if (mode === "percent_of_total") {
        const percent = Number(sizingCfg?.percent ?? 10);
        const fb = Number(sizingCfg?.fallback_fixed_usd ?? 10);
        const { totalBalance, cashUsd, positionsValue } = this.computeTotalBalance(openTrades, pricesBySlug);
        const cashAvailable = this.getCashUsd();

        // If we can't determine cash at all, use fallback
        if (cashAvailable == null) {
          return { budgetUsd: fb, method: "fallback_no_cash", totalBalance: null, cashAvailable: null, detail: "balance_unknown" };
        }

        const targetSize = totalBalance * (percent / 100);

        // If cash < target, use all remaining cash
        const budgetUsd = Math.min(targetSize, cashAvailable);

        // If no cash left, can't trade
        if (budgetUsd <= 0) {
          return { budgetUsd: 0, method: "no_cash", totalBalance, cashAvailable, detail: "zero_cash" };
        }

        return {
          budgetUsd: Math.round(budgetUsd * 100) / 100, // round to cents
          method: "percent_of_total",
          totalBalance: Math.round(totalBalance * 100) / 100,
          cashAvailable: Math.round(cashAvailable * 100) / 100,
          positionsValue: Math.round(positionsValue * 100) / 100,
          percent,
          detail: cashAvailable < targetSize ? "used_remaining_cash" : "normal",
        };
      }

      // Unknown mode — fallback
      return { budgetUsd: 10, method: "unknown_mode_fallback", totalBalance: null, cashAvailable: null, detail: `unknown mode: ${mode}` };
    },

    /** Expose for testing */
    get _state() {
      return { lastCashUsd: _lastCashUsd, lastFetchTs: _lastFetchTs, cashSpentThisLoop: _cashSpentThisLoop, maxAgeMs, fallbackUsd };
    },
  };
}
