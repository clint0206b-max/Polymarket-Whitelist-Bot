/**
 * balance_cache.mjs — Caches USDC balance and computes portfolio metrics
 * for dynamic position sizing.
 *
 * Sizing modes:
 * - "fixed": fixed USD amount per trade
 * - "percent_of_total": legacy — % of (cash + positions at bid). Procyclical.
 * - "percent_of_equity": recommended — % of (cash + deployed cost basis).
 *   Uses exposure cap, max trade USD cap, and base drop detection.
 *   base = getCashUsd() + deployed (stable within a loop: buy reduces cash,
 *   increases deployed, net zero on base).
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

  // Base drop detection (ring buffer)
  const _baseHistory = []; // [{ts, base}]
  const BASE_HISTORY_MAX = 60; // ~20 min of history at ~2s/loop (but base only recorded per sizing call)

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
     * Returns null if never fetched or stale.
     */
    getCashUsd() {
      if (_lastCashUsd == null) return null;
      const age = Date.now() - _lastFetchTs;
      if (age > maxAgeMs) return null; // too stale
      return Math.max(0, _lastCashUsd - _cashSpentThisLoop);
    },

    /**
     * Get raw cached cash (without spend adjustment). For legacy total balance calc.
     */
    getRawCashUsd() {
      if (_lastCashUsd == null) return null;
      const age = Date.now() - _lastFetchTs;
      if (age > maxAgeMs) return null;
      return _lastCashUsd;
    },

    /**
     * Record cash spent on a buy this loop.
     * Call BEFORE execution to reserve, call with negative to unreserve on failure.
     */
    recordSpend(usd) {
      _cashSpentThisLoop += Number(usd) || 0;
    },

    // --- Legacy: mark-to-market total balance (kept for backward compat) ---
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

    // --- Base drop detection ---

    /**
     * Record base value for drop detection. Called after sizing calc.
     */
    recordBase(base) {
      const now = Date.now();
      _baseHistory.push({ ts: now, base });
      while (_baseHistory.length > BASE_HISTORY_MAX) _baseHistory.shift();
    },

    /**
     * Check for base drop within window.
     * @param {number} windowMs - time window (default 10 min)
     * @param {number} threshold - drop fraction to trigger (default 0.15 = 15%)
     * @returns {{ drop: boolean, dropPct: number, peakBase: number, currentBase: number } | null}
     */
    checkBaseDrop(windowMs = 10 * 60 * 1000, threshold = 0.15) {
      if (_baseHistory.length < 2) return null;
      const now = Date.now();
      const current = _baseHistory[_baseHistory.length - 1];
      let peak = current.base;
      for (let i = _baseHistory.length - 2; i >= 0; i--) {
        if (now - _baseHistory[i].ts > windowMs) break;
        if (_baseHistory[i].base > peak) peak = _baseHistory[i].base;
      }
      const dropPct = peak > 0 ? (peak - current.base) / peak : 0;
      return {
        drop: dropPct >= threshold,
        dropPct: Math.round(dropPct * 10000) / 10000,
        peakBase: Math.round(peak * 100) / 100,
        currentBase: Math.round(current.base * 100) / 100,
      };
    },

    // --- Sizing ---

    /**
     * Calculate trade size based on sizing config.
     *
     * Modes:
     * - "fixed": static USD per trade
     * - "percent_of_total": legacy mark-to-market sizing
     * - "percent_of_equity": cash + deployed cost basis, with exposure cap
     *
     * @param {object} sizingCfg
     * @param {Array} openTrades - trades with { spentUsd, filledShares, slug, ... }
     * @param {Map} pricesBySlug - Map<slug, { yes_best_bid }> (only used by legacy mode)
     * @returns {object} sizing result
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

      if (mode === "percent_of_equity") {
        const percent = Number(sizingCfg?.percent ?? 10);
        const maxExposurePct = Number(sizingCfg?.max_exposure_pct ?? 60);
        const maxTradeUsd = Number(sizingCfg?.max_trade_usd ?? Infinity);
        const fb = Number(sizingCfg?.fallback_fixed_usd ?? 10);

        const cashAvailable = this.getCashUsd();
        if (cashAvailable == null) {
          return {
            budgetUsd: fb, method: "fallback_no_cash",
            base: null, deployed: null, cashAvailable: null, detail: "balance_unknown",
          };
        }

        // Deployed = sum of spentUsd from open trades (cost basis, no mark-to-market)
        const deployed = openTrades.reduce((sum, t) => sum + (Number(t.spentUsd) || 0), 0);

        // Base = cash (adjusted for intra-loop spend) + deployed cost basis
        // Using getCashUsd() ensures base is stable within a loop:
        // a buy reduces cash (via recordSpend) AND increases deployed → net zero on base.
        const base = cashAvailable + deployed;

        if (base <= 0) {
          return {
            budgetUsd: 0, method: "no_equity",
            base: 0, deployed: r2(deployed), cashAvailable: r2(cashAvailable), detail: "zero_base",
          };
        }

        const targetSize = base * (percent / 100);
        const maxDeployed = base * (maxExposurePct / 100);
        const available = Math.max(0, maxDeployed - deployed);

        const budgetUsd = Math.max(0, Math.min(targetSize, available, maxTradeUsd, cashAvailable));

        // Determine binding constraint
        let detail = "normal";
        if (budgetUsd <= 0) {
          detail = available <= 0 ? "exposure_cap" : "no_cash";
        } else if (eq(budgetUsd, available) && available < targetSize) {
          detail = "exposure_limited";
        } else if (Number.isFinite(maxTradeUsd) && eq(budgetUsd, maxTradeUsd) && maxTradeUsd < targetSize) {
          detail = "max_trade_limited";
        } else if (eq(budgetUsd, cashAvailable) && cashAvailable < targetSize) {
          detail = "cash_limited";
        }

        return {
          budgetUsd: r2(budgetUsd),
          method: "percent_of_equity",
          base: r2(base),
          deployed: r2(deployed),
          maxDeployed: r2(maxDeployed),
          available: r2(available),
          cashAvailable: r2(cashAvailable),
          percent,
          maxExposurePct,
          maxTradeUsd: Number.isFinite(maxTradeUsd) ? maxTradeUsd : null,
          detail,
        };
      }

      // Unknown mode — fallback
      return { budgetUsd: 10, method: "unknown_mode_fallback", totalBalance: null, cashAvailable: null, detail: `unknown mode: ${mode}` };
    },

    /** Expose for testing */
    get _state() {
      return { lastCashUsd: _lastCashUsd, lastFetchTs: _lastFetchTs, cashSpentThisLoop: _cashSpentThisLoop, maxAgeMs, fallbackUsd };
    },

    /** Expose base history for testing */
    get _baseHistoryForTest() {
      return [..._baseHistory];
    },
  };
}

// --- Helpers ---

/** Round to 2 decimal places */
function r2(n) {
  return Math.round(n * 100) / 100;
}

/** Equality within 1 cent */
function eq(a, b) {
  return Math.abs(a - b) < 0.01;
}
