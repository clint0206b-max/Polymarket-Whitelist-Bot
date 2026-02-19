/**
 * trade_bridge.mjs — Bridge between paper signals and real execution.
 * 
 * Responsibilities:
 * - Idempotent execution (no double buys/sells per signal_id)
 * - Partial fill tracking and reconciliation
 * - SL sell with escalating floor
 * - Position reconciliation against CLOB
 * - Safety guards (max exposure, max positions, max trades/day, allowlist)
 * 
 * Trading modes:
 * - "paper"       → signals only, no execution (default)
 * - "shadow_live" → builds real orders, checks balance/book, logs what WOULD execute, but doesn't send
 * - "live"        → executes real trades
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appendJsonl } from "../core/journal.mjs";
import { resolvePath } from "../core/state_store.js";
import { notifyTelegram } from "../notify/telegram.mjs";
import {
  initClient, executeBuy, executeSell,
  getBalance, getConditionalBalance, getOnChainUSDCBalance, getPositions,
  fetchRealFillPrice,
} from "./order_executor.mjs";
import { createBalanceCache } from "./balance_cache.mjs";

// Resolves to state/execution_state.json (prod) or state-{SHADOW_ID}/execution_state.json (shadow)
const EXECUTION_STATE_PATH = resolvePath("state", "execution_state.json");

// --- Execution State (idempotency) ---

function loadExecutionState() {
  try {
    return JSON.parse(readFileSync(EXECUTION_STATE_PATH, "utf8"));
  } catch {
    return { trades: {}, daily: {}, last_reconcile_ts: 0 };
  }
}

function saveExecutionState(st) {
  mkdirSync(dirname(EXECUTION_STATE_PATH), { recursive: true });
  writeFileSync(EXECUTION_STATE_PATH, JSON.stringify(st, null, 2));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// --- Boot Guard ---

export function validateBootConfig(cfg) {
  const errors = [];
  const mode = cfg?.trading?.mode;
  if (!["paper", "shadow_live", "live"].includes(mode)) {
    errors.push(`trading.mode must be paper|shadow_live|live, got: ${mode}`);
  }

  if (mode === "live" || mode === "shadow_live") {
    const sl = Number(cfg?.paper?.stop_loss_bid);
    if (!(sl > 0 && sl < 1)) errors.push(`paper.stop_loss_bid must be 0<x<1, got: ${sl}`);
    
    const maxPos = Number(cfg?.trading?.max_position_usd);
    if (!(maxPos > 0 && maxPos <= 1000)) errors.push(`trading.max_position_usd must be 0<x<=1000, got: ${maxPos}`);
    
    const maxExposure = Number(cfg?.trading?.max_total_exposure_usd);
    if (!(maxExposure > 0)) errors.push(`trading.max_total_exposure_usd required, got: ${maxExposure}`);
    
    const maxConcurrent = Number(cfg?.trading?.max_concurrent_positions);
    if (!(maxConcurrent > 0 && maxConcurrent <= 100)) errors.push(`trading.max_concurrent_positions must be 1-100, got: ${maxConcurrent}`);
    
    const maxDaily = Number(cfg?.trading?.max_trades_per_day);
    if (!(maxDaily > 0)) errors.push(`trading.max_trades_per_day required, got: ${maxDaily}`);
    
    const credPath = cfg?.trading?.credentials_path;
    if (!credPath || !existsSync(credPath)) errors.push(`credentials file not found: ${credPath}`);
    
    const funder = cfg?.trading?.funder_address;
    if (!funder || !funder.startsWith("0x")) errors.push(`trading.funder_address required, got: ${funder}`);
  }

  return { valid: errors.length === 0, errors };
}

// --- Trade Bridge ---

export class TradeBridge {
  constructor(cfg, state) {
    this.cfg = cfg;
    this.state = state;
    this.mode = cfg?.trading?.mode || "paper";
    this.client = null;
    this.funder = cfg?.trading?.funder_address || "";
    this.execState = loadExecutionState();
    
    // Guards
    this.maxPositionUsd = Number(cfg?.trading?.max_position_usd || 10);
    this.maxTotalExposure = Number(cfg?.trading?.max_total_exposure_usd || 50);
    this.maxConcurrent = Number(cfg?.trading?.max_concurrent_positions || 5);
    this.maxDailyTrades = Number(cfg?.trading?.max_trades_per_day || 50);
    this.allowlist = cfg?.trading?.allowlist || null; // null = allow all
    this.slFloorSteps = [0, 0.01, 0.02, 0.03, 0.05]; // escalating discount from SL trigger price

    // Price tick logging: throttled per signal_id
    this._priceTickLastTs = new Map(); // signal_id → last log timestamp
    this._priceTickIntervalMs = 30_000; // log every 30s per position

    // Balance cache for dynamic sizing
    this.balanceCache = createBalanceCache({
      maxAgeMs: Number(cfg?.sizing?.balance_max_age_ms ?? 300000),
      fallbackUsd: Number(cfg?.sizing?.fallback_fixed_usd ?? 10),
      getBalanceFn: null, // set in init() when client is available
    });
    this._currentPricesBySlug = new Map(); // updated each loop for sizing
  }

  async init() {
    if (this.mode === "paper") {
      console.log("[TRADE_BRIDGE] mode=paper — no execution client needed");
      return;
    }

    const credPath = this.cfg?.trading?.credentials_path;
    if (!credPath) throw new Error("trading.credentials_path required for non-paper mode");

    const { client, wallet, funder } = initClient(credPath, this.funder);
    this.client = client;

    // Wire up balance cache with live fetch function
    this.balanceCache = createBalanceCache({
      maxAgeMs: Number(this.cfg?.sizing?.balance_max_age_ms ?? 300000),
      fallbackUsd: Number(this.cfg?.sizing?.fallback_fixed_usd ?? 10),
      getBalanceFn: () => getBalance(client),
    });
    
    // Log effective settings at boot — both balance sources are best-effort
    let balance = null;
    let onChainBal = null;
    try {
      [balance, onChainBal] = await Promise.all([
        getBalance(client).catch(() => null),
        getOnChainUSDCBalance(this.funder),
      ]);
    } catch (e) {
      console.warn(`[TRADE_BRIDGE] balance fetch error at boot: ${e.message}`);
    }
    this.execState.last_balance = onChainBal ?? balance;
    const clobStr = balance != null ? `$${balance.toFixed(2)}` : "unavailable";
    const onChainStr = onChainBal != null ? `$${onChainBal.toFixed(2)}` : "unavailable";
    console.log(`[TRADE_BRIDGE] mode=${this.mode} | funder=${this.funder} | clob=${clobStr} | onchain=${onChainStr}`);
    console.log(`[TRADE_BRIDGE] guards: max_pos=$${this.maxPositionUsd} max_exposure=$${this.maxTotalExposure} max_concurrent=${this.maxConcurrent} max_daily=${this.maxDailyTrades}`);
    const slBid = this.cfg?.paper?.stop_loss_bid;
    const slSpread = this.cfg?.paper?.stop_loss_spread_max;
    const slEmerg = this.cfg?.paper?.stop_loss_emergency_bid;
    const slBidE = this.cfg?.paper?.stop_loss_bid_esports;
    console.log(`[TRADE_BRIDGE] SL=${slBid || "none"} (spread≤${slSpread || 0.50}, emergency≤${slEmerg || 0.15})${slBidE ? ` | esports: SL=${slBidE}` : ""} | allowlist=${this.allowlist ? this.allowlist.length + " markets" : "all"}`);
    
    return { balance };
  }

  /**
   * Refresh balance cache. Call once per loop.
   */
  async refreshBalance() {
    if (this.mode === "paper") return;
    const result = await this.balanceCache.refresh();
    if (result.error) {
      console.warn(`[BALANCE_CACHE] refresh error: ${result.error} | using cached=$${result.cashUsd?.toFixed(2) ?? "null"}`);
    }
    return result;
  }

  /**
   * Update current prices map for sizing calculations. Call once per loop.
   */
  updatePricesForSizing(pricesBySlug) {
    this._currentPricesBySlug = pricesBySlug || new Map();
  }

  /**
   * Get open trades (filled, not closed).
   */
  _getOpenTrades() {
    return Object.values(this.execState.trades).filter(t => t.status === "filled" && !t.closed);
  }

  // --- Entry (signal_open → buy) ---

  async handleSignalOpen(signal) {
    if (this.mode === "paper") return null;

    const tradeId = `buy:${signal.signal_id}`;
    
    // (paused mechanism removed — bot should never stop trading automatically)

    // Idempotency check
    if (this.execState.trades[tradeId]) {
      console.log(`[TRADE_BRIDGE] SKIP duplicate buy: ${tradeId} (status=${this.execState.trades[tradeId].status})`);
      return this.execState.trades[tradeId];
    }

    // Allowlist check
    if (this.allowlist && !this.allowlist.includes(signal.slug)) {
      console.log(`[TRADE_BRIDGE] BLOCKED by allowlist: ${signal.slug}`);
      return { blocked: true, reason: "allowlist" };
    }

    // Daily trade limit
    const day = todayKey();
    const dailyCount = this.execState.daily[day] || 0;
    if (dailyCount >= this.maxDailyTrades) {
      console.log(`[TRADE_BRIDGE] BLOCKED daily limit: ${dailyCount}/${this.maxDailyTrades}`);
      return { blocked: true, reason: "daily_limit" };
    }

    // Concurrent positions limit
    const openTrades = Object.values(this.execState.trades).filter(t => t.status === "filled" && !t.closed);
    if (openTrades.length >= this.maxConcurrent) {
      console.log(`[TRADE_BRIDGE] BLOCKED concurrent limit: ${openTrades.length}/${this.maxConcurrent}`);
      return { blocked: true, reason: "concurrent_limit" };
    }

    // Total exposure limit
    const totalExposure = openTrades.reduce((sum, t) => sum + (t.spentUsd || 0), 0);
    if (totalExposure + this.maxPositionUsd > this.maxTotalExposure) {
      console.log(`[TRADE_BRIDGE] BLOCKED exposure limit: $${totalExposure.toFixed(2)} + $${this.maxPositionUsd} > $${this.maxTotalExposure}`);
      return { blocked: true, reason: "exposure_limit" };
    }

    // Calculate shares to buy — dynamic sizing
    const entryPrice = Number(signal.entry_price);
    const sizing = this.balanceCache.calculateTradeSize(
      this.cfg?.sizing,
      openTrades,
      this._currentPricesBySlug,
    );
    const budget = sizing.budgetUsd;

    if (budget <= 0) {
      console.log(`[TRADE_BRIDGE] BLOCKED no budget: method=${sizing.method} detail=${sizing.detail}`);
      return { blocked: true, reason: "no_budget", sizing };
    }

    console.log(`[SIZING] ${signal.slug} | budget=$${budget.toFixed(2)} | method=${sizing.method} | total=$${sizing.totalBalance ?? "?"} | cash=$${sizing.cashAvailable ?? "?"} | positions=$${sizing.positionsValue ?? "?"} | ${sizing.detail || ""}`);

    const estimatedShares = Math.floor((budget / entryPrice) * 100) / 100;
    const tokenId = signal.yes_token || signal.tokenId;

    if (!tokenId) {
      console.log(`[TRADE_BRIDGE] BLOCKED no tokenId for ${signal.slug}`);
      return { blocked: true, reason: "no_token_id" };
    }

    // Mark as queued (idempotency)
    this.execState.trades[tradeId] = {
      status: "queued",
      signal_id: signal.signal_id,
      slug: signal.slug,
      side: "BUY",
      tokenId,
      requestedUsd: budget,
      estimatedShares,
      entryPrice,
      budget,
      ts_queued: Date.now(),
    };
    saveExecutionState(this.execState);

    if (this.mode === "shadow_live") {
      // Check balance and book, log what would happen, but don't execute
      let balance = null;
      try { balance = await getBalance(this.client); } catch (e) { balance = `err: ${e.message}`; }
      
      const result = {
        status: "shadow",
        signal_id: signal.signal_id,
        slug: signal.slug,
        would_spend_usd: budget,
        estimated_shares: estimatedShares,
        balance_usd: balance,
        tokenId,
      };
      
      console.log(`[SHADOW_BUY] ${signal.slug} | $${budget.toFixed(2)} (~${estimatedShares} shares) @ ${entryPrice} | balance=$${typeof balance === 'number' ? balance.toFixed(2) : balance}`);
      
      appendJsonl("state/journal/executions.jsonl", {
        type: "shadow_buy",
        trade_id: tradeId,
        mode: this.mode,
        ts: Date.now(),
        ...result,
      });

      this.execState.trades[tradeId] = { ...this.execState.trades[tradeId], status: "shadow", balance };
      saveExecutionState(this.execState);
      return result;
    }

    // === LIVE EXECUTION ===
    console.log(`[LIVE_BUY] ${signal.slug} | $${budget.toFixed(2)} (~${estimatedShares} shares) @ ${entryPrice} | tokenId=${tokenId.slice(0, 10)}...`);
    
    try {
      this.execState.trades[tradeId].status = "sent";
      saveExecutionState(this.execState);

      const result = await executeBuy(this.client, tokenId, budget);
      
      if (result.ok) {
        this.execState.trades[tradeId] = {
          ...this.execState.trades[tradeId],
          status: "filled",
          filledShares: result.filledShares,
          avgFillPrice: result.avgFillPrice,
          spentUsd: result.spentUsd,
          isPartial: result.isPartial,
          orderID: result.orderID,
          ts_filled: Date.now(),
          closed: false,
        };
        this.execState.daily[day] = (this.execState.daily[day] || 0) + 1;
        saveExecutionState(this.execState);

        // Record spend for intra-loop cash tracking
        this.balanceCache.recordSpend(result.spentUsd || budget);

        const slippage = result.avgFillPrice ? ((result.avgFillPrice - entryPrice) / entryPrice * 100).toFixed(2) : "?";
        console.log(`[FILLED_BUY] ${signal.slug} | ${result.filledShares} shares @ $${result.avgFillPrice?.toFixed(4) || "?"} | slippage=${slippage}% | partial=${result.isPartial}`);

        notifyTelegram(`🟢 BUY ${signal.slug}\n$${(result.spentUsd || budget).toFixed(2)} @ ${entryPrice} | ${result.filledShares} shares`).catch(() => {});

        appendJsonl("state/journal/executions.jsonl", {
          type: "trade_executed",
          trade_id: tradeId,
          mode: this.mode,
          side: "BUY",
          ts: Date.now(),
          signal_id: signal.signal_id,
          slug: signal.slug,
          tokenId,
          orderID: result.orderID,
          requestedUsd: budget,
          estimatedShares,
          filledShares: result.filledShares,
          avgFillPrice: result.avgFillPrice,
          spentUsd: result.spentUsd,
          entryPrice,
          isPartial: result.isPartial,
          slippage_pct: slippage,
        });

        // Post-execution quick reconcile: verify position exists
        try {
          const condBal = await getConditionalBalance(this.client, tokenId);
          if (condBal < result.filledShares * 0.5) {
            console.warn(`[POST_FILL_CHECK] ${signal.slug} | conditional balance ${condBal} << filled ${result.filledShares} — possible fill issue`);
          }
        } catch {}

        return result;
      } else {
        this.execState.trades[tradeId].status = "failed";
        this.execState.trades[tradeId].error = result.error;
        saveExecutionState(this.execState);

        console.error(`[FAILED_BUY] ${signal.slug} | ${result.error}`);
        appendJsonl("state/journal/executions.jsonl", {
          type: "trade_failed",
          trade_id: tradeId,
          mode: this.mode,
          side: "BUY",
          ts: Date.now(),
          signal_id: signal.signal_id,
          slug: signal.slug,
          tokenId,
          error: result.error,
          requestedShares: shares,
          entryPrice,
        });

        return result;
      }
    } catch (e) {
      this.execState.trades[tradeId].status = "error";
      this.execState.trades[tradeId].error = e.message;
      saveExecutionState(this.execState);
      console.error(`[ERROR_BUY] ${signal.slug} | ${e.message}`);
      throw e;
    }
  }

  // --- Exit (signal_close → sell or redeem) ---

  async handleSignalClose(signal) {
    if (this.mode === "paper") return null;

    const sellTradeId = `sell:${signal.signal_id}`;
    
    // Idempotency check — allow retry for failed_all_attempts
    const existingSell = this.execState.trades[sellTradeId];
    if (existingSell) {
      if (existingSell.status === "failed_all_attempts") {
        console.log(`[TRADE_BRIDGE] RETRY failed sell: ${sellTradeId}`);
        delete this.execState.trades[sellTradeId];
      } else {
        console.log(`[TRADE_BRIDGE] SKIP duplicate sell: ${sellTradeId}`);
        return existingSell;
      }
    }

    // Find the buy trade for this signal
    const buyTradeId = `buy:${signal.signal_id}`;
    const buyTrade = this.execState.trades[buyTradeId];
    if (!buyTrade || buyTrade.status !== "filled") {
      console.log(`[TRADE_BRIDGE] No filled buy for ${signal.signal_id}, skipping sell`);
      return null;
    }

    const tokenId = buyTrade.tokenId;
    const shares = buyTrade.filledShares || buyTrade.requestedShares;
    const isStopLoss = signal.close_reason === "stop_loss" || signal.close_reason === "context_sl";
    const isResolved = signal.close_reason === "resolved";

    if (this.mode === "shadow_live") {
      let condBal = null;
      try { condBal = await getConditionalBalance(this.client, tokenId); } catch {}

      const result = {
        status: "shadow",
        signal_id: signal.signal_id,
        slug: signal.slug,
        would_sell_shares: shares,
        close_reason: signal.close_reason,
        conditional_balance: condBal,
      };
      console.log(`[SHADOW_SELL] ${signal.slug} | ${shares} shares | reason=${signal.close_reason} | cond_bal=${condBal}`);
      
      appendJsonl("state/journal/executions.jsonl", {
        type: "shadow_sell",
        trade_id: sellTradeId,
        mode: this.mode,
        ts: Date.now(),
        ...result,
      });
      return result;
    }

    // === LIVE SELL ===
    
    // If resolved at 1.00, might be redeemable — but we still try to sell first since
    // terminal price (0.995+) means there are bids. Redemption is backup.
    
    // For SL: use escalating floor to guarantee exit
    if (isStopLoss) {
      return this._executeSLSell(signal, buyTrade, sellTradeId);
    }

    // For resolution: sell at market (resolved markets have bids at 0.99+)
    return this._executeMarketSell(signal, buyTrade, sellTradeId, 0.95); // floor at 0.95 for resolved
  }

  async _executeSLSell(signal, buyTrade, sellTradeId) {
    const tokenId = buyTrade.tokenId;
    const shares = buyTrade.filledShares || buyTrade.requestedShares;
    const triggerPrice = signal.sl_trigger_price || 0.70;
    
    this.execState.trades[sellTradeId] = {
      status: "queued",
      signal_id: signal.signal_id,
      slug: signal.slug,
      side: "SELL",
      tokenId,
      shares,
      close_reason: "stop_loss",
      ts_queued: Date.now(),
    };
    saveExecutionState(this.execState);

    // Escalating floor: try at trigger price, then lower (absolute min: SL - 0.10)
    const absoluteMinFloor = Math.max(0.01, triggerPrice - 0.10);
    for (let i = 0; i < this.slFloorSteps.length; i++) {
      const floor = Math.max(absoluteMinFloor, triggerPrice - this.slFloorSteps[i]);
      const remainingShares = shares - (this.execState.trades[sellTradeId]?.filledShares || 0);
      if (remainingShares < 0.01) break; // all sold
      
      console.log(`[SL_SELL] ${signal.slug} | attempt ${i + 1}/${this.slFloorSteps.length} | floor=${floor.toFixed(3)} | remaining=${remainingShares.toFixed(2)}/${shares}`);
      
      try {
        this.execState.trades[sellTradeId].status = "sent";
        saveExecutionState(this.execState);

        // Get actual conditional balance to avoid selling more than we have
        let actualShares = remainingShares;
        try {
          const condBal = await getConditionalBalance(this.client, tokenId);
          if (condBal < remainingShares * 0.99) {
            console.warn(`[SL_SELL] conditional balance ${condBal} < expected ${remainingShares}, using balance`);
            actualShares = Math.min(remainingShares, condBal);
          }
        } catch {}

        const result = await executeSell(this.client, tokenId, actualShares, floor);
        
        if (result.ok && result.filledShares > 0) {
          const totalFilledSoFar = (this.execState.trades[sellTradeId].filledShares || 0) + result.filledShares;
          const totalReceivedSoFar = (this.execState.trades[sellTradeId].receivedUsd || 0) + (result.spentUsd || 0);
          const allFilled = totalFilledSoFar >= shares * 0.99; // 1% tolerance for rounding

          this.execState.trades[sellTradeId] = {
            ...this.execState.trades[sellTradeId],
            status: allFilled ? "filled" : "partial",
            filledShares: totalFilledSoFar,
            avgFillPrice: totalReceivedSoFar / totalFilledSoFar,
            receivedUsd: totalReceivedSoFar,
            isPartial: !allFilled,
            orderID: result.orderID,
            floor_used: floor,
            attempt: i + 1,
            ts_filled: Date.now(),
          };
          if (allFilled) buyTrade.closed = true;
          saveExecutionState(this.execState);

          const pnl = totalReceivedSoFar - (buyTrade.spentUsd || 0);
          console.log(`[FILLED_SL_SELL] ${signal.slug} | ${result.filledShares} shares @ $${result.avgFillPrice?.toFixed(4)} | total=${totalFilledSoFar}/${shares} | PnL=$${pnl.toFixed(2)} | attempt=${i + 1}${allFilled ? "" : " PARTIAL"}`);

          if (allFilled) {
            notifyTelegram(`🔴 SELL ${signal.slug}\n-$${Math.abs(pnl).toFixed(2)} | stop_loss`).catch(() => {});
          }

          appendJsonl("state/journal/executions.jsonl", {
            type: "trade_executed",
            trade_id: sellTradeId,
            mode: this.mode,
            side: "SELL",
            close_reason: "stop_loss",
            ts: Date.now(),
            signal_id: signal.signal_id,
            slug: signal.slug,
            tokenId,
            orderID: result.orderID,
            requestedShares: shares,
            filledShares: result.filledShares,
            totalFilledShares: totalFilledSoFar,
            avgFillPrice: result.avgFillPrice,
            receivedUsd: result.spentUsd,
            pnl_usd: pnl,
            floor_used: floor,
            absoluteMinFloor,
            attempt: i + 1,
            total_attempts: this.slFloorSteps.length,
            isPartial: !allFilled,
          });

          if (allFilled) return result;

          // Partial fill — continue escalating to sell remainder
          console.log(`[SL_SELL] ${signal.slug} | partial fill ${totalFilledSoFar}/${shares}, continuing escalation for remainder...`);
          continue;
        }
        
        // No fill at this floor, try lower
        console.log(`[SL_SELL] ${signal.slug} | no fill at floor=${floor.toFixed(3)}, escalating...`);
        
      } catch (e) {
        console.error(`[SL_SELL] ${signal.slug} | error at floor=${floor.toFixed(3)}: ${e.message}`);
      }
    }

    // Last resort: market sell with floor=0.01 (sell at ANY price rather than hold a crashing position)
    {
      const remainingShares = shares - (this.execState.trades[sellTradeId]?.filledShares || 0);
      if (remainingShares >= 0.01) {
        console.warn(`[SL_SELL_LAST_RESORT] ${signal.slug} | floor=0.01 | remaining=${remainingShares.toFixed(2)} — selling at any price`);
        try {
          let actualShares = remainingShares;
          try {
            const condBal = await getConditionalBalance(this.client, tokenId);
            if (condBal < remainingShares * 0.99) {
              actualShares = Math.min(remainingShares, condBal);
            }
          } catch {}

          const result = await executeSell(this.client, tokenId, actualShares, 0.01);
          if (result.ok && result.filledShares > 0) {
            const totalFilledSoFar = (this.execState.trades[sellTradeId].filledShares || 0) + result.filledShares;
            const totalReceivedSoFar = (this.execState.trades[sellTradeId].receivedUsd || 0) + (result.spentUsd || 0);
            const allFilled = totalFilledSoFar >= shares * 0.99;

            this.execState.trades[sellTradeId] = {
              ...this.execState.trades[sellTradeId],
              status: allFilled ? "filled" : "partial",
              filledShares: totalFilledSoFar,
              avgFillPrice: totalReceivedSoFar / totalFilledSoFar,
              receivedUsd: totalReceivedSoFar,
              isPartial: !allFilled,
              orderID: result.orderID,
              floor_used: 0.01,
              attempt: this.slFloorSteps.length + 1,
              ts_filled: Date.now(),
              last_resort: true,
            };
            if (allFilled) buyTrade.closed = true;
            saveExecutionState(this.execState);

            const pnl = totalReceivedSoFar - (buyTrade.spentUsd || 0);
            console.log(`[FILLED_SL_LAST_RESORT] ${signal.slug} | ${result.filledShares} shares @ $${result.avgFillPrice?.toFixed(4)} | PnL=$${pnl.toFixed(2)}`);
            notifyTelegram(`🆘 LAST RESORT SELL ${signal.slug}\n-$${Math.abs(pnl).toFixed(2)} | floor=0.01`).catch(() => {});

            appendJsonl("state/journal/executions.jsonl", {
              type: "trade_executed",
              trade_id: sellTradeId,
              mode: this.mode,
              side: "SELL",
              close_reason: "stop_loss_last_resort",
              ts: Date.now(),
              signal_id: signal.signal_id,
              slug: signal.slug,
              tokenId,
              orderID: result.orderID,
              filledShares: result.filledShares,
              totalFilledShares: totalFilledSoFar,
              avgFillPrice: result.avgFillPrice,
              receivedUsd: result.spentUsd,
              pnl_usd: pnl,
              floor_used: 0.01,
              attempt: this.slFloorSteps.length + 1,
              last_resort: true,
            });

            if (allFilled) return result;
          }
        } catch (e) {
          console.error(`[SL_SELL_LAST_RESORT] ${signal.slug} | error: ${e.message}`);
        }
      }
    }

    // All attempts including last resort failed
    this.execState.trades[sellTradeId].status = "failed_all_attempts";
    saveExecutionState(this.execState);
    console.error(`[SL_SELL_FAILED] ${signal.slug} | ALL ${this.slFloorSteps.length} attempts failed — position remains open`);
    
    appendJsonl("state/journal/executions.jsonl", {
      type: "sl_sell_failed",
      ts: Date.now(),
      signal_id: signal.signal_id,
      slug: signal.slug,
      attempts: this.slFloorSteps.length,
    });

    return { ok: false, error: "sl_all_attempts_failed" };
  }

  async _executeMarketSell(signal, buyTrade, sellTradeId, floor) {
    const tokenId = buyTrade.tokenId;
    const shares = buyTrade.filledShares || buyTrade.requestedShares;

    this.execState.trades[sellTradeId] = {
      status: "sent",
      signal_id: signal.signal_id,
      slug: signal.slug,
      side: "SELL",
      tokenId,
      shares,
      close_reason: signal.close_reason,
      ts_queued: Date.now(),
    };
    saveExecutionState(this.execState);

    try {
      // Reconcile actual shares
      let actualShares = shares;
      try {
        const condBal = await getConditionalBalance(this.client, tokenId);
        actualShares = Math.min(shares, condBal);
      } catch {}

      const result = await executeSell(this.client, tokenId, actualShares, floor);

      if (result.ok) {
        // Try to get real fill price (order price is provisional — it's the floor, not the fill)
        let realAvg = result.avgFillPrice;
        let priceProvisional = result.priceProvisional || false;
        if (priceProvisional && result.orderID) {
          try {
            const real = await fetchRealFillPrice(this.client, result.orderID, { maxRetries: 2, delayMs: 500 });
            if (real != null) {
              realAvg = real;
              priceProvisional = false;
              console.log(`[FILL_PRICE] ${signal.slug} | real avg=${real.toFixed(4)} (order limit was ${result.avgFillPrice?.toFixed(4)})`);
            }
          } catch (e) {
            console.warn(`[FILL_PRICE] ${signal.slug} | getTrades failed, keeping provisional: ${e.message}`);
          }
        }
        const receivedUsd = realAvg != null && result.filledShares > 0
          ? realAvg * result.filledShares : result.spentUsd;

        this.execState.trades[sellTradeId] = {
          ...this.execState.trades[sellTradeId],
          status: "filled",
          filledShares: result.filledShares,
          avgFillPrice: realAvg,
          receivedUsd,
          isPartial: result.isPartial,
          orderID: result.orderID,
          ts_filled: Date.now(),
          priceProvisional,
        };
        buyTrade.closed = true;
        saveExecutionState(this.execState);

        const pnl = (receivedUsd || 0) - (buyTrade.spentUsd || 0);
        console.log(`[FILLED_SELL] ${signal.slug} | ${result.filledShares} shares @ $${realAvg?.toFixed(4)}${priceProvisional ? " (provisional)" : ""} | PnL=$${pnl.toFixed(2)}`);

        const pnlEmoji = pnl >= 0 ? "🏆" : "🔴";
        const pnlSign = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        notifyTelegram(`${pnlEmoji} SELL ${signal.slug}\n${pnlSign} | ${signal.close_reason}`).catch(() => {});

        appendJsonl("state/journal/executions.jsonl", {
          type: "trade_executed",
          trade_id: sellTradeId,
          mode: this.mode,
          side: "SELL",
          close_reason: signal.close_reason,
          ts: Date.now(),
          signal_id: signal.signal_id,
          slug: signal.slug,
          tokenId,
          orderID: result.orderID,
          requestedShares: shares,
          filledShares: result.filledShares,
          avgFillPrice: realAvg,
          receivedUsd,
          pnl_usd: pnl,
          priceProvisional,
        });

        return { ...result, avgFillPrice: realAvg, spentUsd: receivedUsd, priceProvisional };
      } else {
        this.execState.trades[sellTradeId].status = "failed";
        this.execState.trades[sellTradeId].error = result.error;
        saveExecutionState(this.execState);
        console.error(`[FAILED_SELL] ${signal.slug} | ${result.error}`);
        return result;
      }
    } catch (e) {
      this.execState.trades[sellTradeId].status = "error";
      this.execState.trades[sellTradeId].error = e.message;
      saveExecutionState(this.execState);
      console.error(`[ERROR_SELL] ${signal.slug} | ${e.message}`);
      throw e;
    }
  }

  // --- Reconciliation ---

  async reconcilePositions() {
    if (this.mode === "paper" || !this.client) return;
    
    const now = Date.now();
    const interval = 2 * 60 * 1000; // every 2 min
    if (now - (this.execState.last_reconcile_ts || 0) < interval) return;

    try {
      const positions = await getPositions(this.funder);
      const [clobBalance, onChainBalance] = await Promise.all([
        getBalance(this.client),
        getOnChainUSDCBalance(this.funder),
      ]);
      const effectiveBalance = onChainBalance ?? clobBalance;
      
      const onChainStr = onChainBalance != null ? `$${onChainBalance.toFixed(2)}` : "unavailable";
      console.log(`[RECONCILE] ${positions.length} positions | clob=$${clobBalance.toFixed(2)} | onchain=${onChainStr}`);
      
      // Check for orphaned trades (filled but position gone)
      const openTrades = Object.entries(this.execState.trades)
        .filter(([_, t]) => t.status === "filled" && !t.closed);
      
      for (const [tradeId, trade] of openTrades) {
        const hasPosition = positions.some(p => p.asset === trade.tokenId && Number(p.size) > 0.01);
        if (!hasPosition) {
          console.warn(`[RECONCILE] trade ${tradeId} marked filled but no position found — marking orphan_pending`);
          trade.status = "orphan_pending";
          trade.orphan_detected_ts = now;
          trade.orphan_attempts = 0;
        }
      }

      // Reconcile orphan_pending: try to find real sell in CLOB trade history
      await this._reconcileOrphans(now);

      this.execState.last_reconcile_ts = now;
      this.execState.last_balance = effectiveBalance;
      this.execState.last_position_count = positions.length;
      saveExecutionState(this.execState);
      
    } catch (e) {
      console.error(`[RECONCILE] error: ${e.message}`);
    }
  }

  /**
   * Reconcile orphan_pending trades by looking up real sells in CLOB trade history.
   * If a matching sell is found → close with real data. 
   * After 24h without match → fall back to orphan_closed.
   */
  async _reconcileOrphans(now) {
    const orphans = Object.entries(this.execState.trades)
      .filter(([_, t]) => t.status === "orphan_pending");
    if (orphans.length === 0) return;

    let allTrades = null;
    try {
      allTrades = await this.client.getTrades();
    } catch (e) {
      console.error(`[ORPHAN_RECONCILE] getTrades failed: ${e.message}`);
      return;
    }
    if (!Array.isArray(allTrades)) return;

    const sells = allTrades.filter(t => t.side === "SELL" || t.side === "sell");
    let resolved = 0, expired = 0;

    for (const [tradeId, trade] of orphans) {
      const matchingSells = sells.filter(s => s.asset_id === trade.tokenId);
      
      if (matchingSells.length > 0) {
        // Find best match: most recent sell for this token
        const bestSell = matchingSells.sort((a, b) => Number(b.match_time || 0) - Number(a.match_time || 0))[0];
        const sellPrice = Number(bestSell.price) || 0;
        const sellSize = Number(bestSell.size) || 0;
        const sellTime = Number(bestSell.match_time) * 1000 || now;
        const entryPrice = trade.avgFillPrice || trade.entryPrice || 0;
        const shares = trade.shares || sellSize;
        const pnl = Number(((sellPrice - entryPrice) * shares).toFixed(4));

        trade.status = "closed";
        trade.closed = true;
        trade.close_reason = "manual_sell";
        trade.sellPrice = sellPrice;
        trade.sellSize = sellSize;
        trade.sellTimestamp = sellTime;
        trade.pnl = pnl;
        trade.orphan_resolved_ts = now;
        trade.clob_sell_id = bestSell.id;
        resolved++;
        
        const slug = tradeId.split("|")[1] || tradeId;
        const win = pnl >= 0;
        console.log(`[ORPHAN_RECONCILE] ${slug} → sell@${sellPrice} size=${sellSize} pnl=$${pnl.toFixed(2)}`);

        // Write signal_close to journal so dashboard picks it up
        appendJsonl("state/journal/signals.jsonl", {
          type: "signal_close",
          signal_id: trade.signal_id || tradeId,
          slug,
          ts_close: sellTime,
          close_reason: "manual_sell",
          resolved_price: sellPrice,
          win,
          pnl_usd: pnl,
          roi: (trade.spentUsd > 0) ? pnl / trade.spentUsd : 0,
          executed: true,
          orphan_reconciled: true,
        });

        // Write execution entry for the sell
        appendJsonl("state/journal/executions.jsonl", {
          type: "sell",
          trade_id: `sell:orphan:${trade.signal_id || tradeId}`,
          signal_id: trade.signal_id || tradeId,
          slug,
          side: "SELL",
          mode: trade.mode || "live",
          status: "filled",
          avgFillPrice: sellPrice,
          shares: sellSize,
          receivedUsd: sellSize * sellPrice,
          ts: sellTime,
          close_reason: "manual_sell",
          orphan_reconciled: true,
        });
      } else {
        trade.orphan_attempts = (trade.orphan_attempts || 0) + 1;
        const ageMs = now - (trade.orphan_detected_ts || now);
        if (ageMs > 24 * 60 * 60 * 1000) {
          trade.status = "orphan_closed";
          trade.closed = true;
          trade.orphan_resolved_ts = now;
          trade.close_reason = "orphan_timeout";
          expired++;
          const slug = tradeId.split("|")[1] || tradeId;
          console.warn(`[ORPHAN_RECONCILE] ${slug} → no sell found after 24h, marking orphan_closed`);
        }
      }
    }

    if (resolved > 0 || expired > 0) {
      console.log(`[ORPHAN_RECONCILE] resolved=${resolved} expired=${expired} remaining=${orphans.length - resolved - expired}`);
    }
  }

  // --- Status ---
  
  /**
   * Check open positions against CLOB bid prices for stop loss AND resolution.
   * Called from main loop with real-time WS/HTTP prices (every 2s).
   * This is the ONLY source of SL and resolution signals in live mode.
   * Gamma is NOT used for any trading decisions in live mode.
   *
   * @param {Map<string, {yes_best_bid: number}>} pricesBySlug - current CLOB prices keyed by slug
   * @returns {Array<object>} - signal_close objects for positions that hit SL or resolved
   */
  checkPositionsFromCLOB(pricesBySlug, contextBySlug = new Map()) {
    if (this.mode === "paper") return [];

    const slThresholdDefault = Number(this.cfg?.paper?.stop_loss_bid ?? 0.70);
    const slSpreadMaxDefault = Number(this.cfg?.paper?.stop_loss_spread_max ?? 0.50);
    const slEmergencyBidDefault = Number(this.cfg?.paper?.stop_loss_emergency_bid ?? 0.15);
    const slThresholdEsports = Number(this.cfg?.paper?.stop_loss_bid_esports || slThresholdDefault);
    const slSpreadMaxEsports = Number(this.cfg?.paper?.stop_loss_spread_max_esports || slSpreadMaxDefault);
    const slEmergencyBidEsports = Number(this.cfg?.paper?.stop_loss_emergency_bid_esports || slEmergencyBidDefault);
    const slThresholdDota2 = Number(this.cfg?.paper?.stop_loss_bid_dota2 || slThresholdEsports);
    const slSpreadMaxDota2 = Number(this.cfg?.paper?.stop_loss_spread_max_dota2 || slSpreadMaxEsports);
    const slEmergencyBidDota2 = Number(this.cfg?.paper?.stop_loss_emergency_bid_dota2 || slEmergencyBidEsports);
    const slThresholdCs2 = Number(this.cfg?.paper?.stop_loss_bid_cs2 || slThresholdEsports);
    const slSpreadMaxCs2 = Number(this.cfg?.paper?.stop_loss_spread_max_cs2 || slSpreadMaxEsports);
    const slEmergencyBidCs2 = Number(this.cfg?.paper?.stop_loss_emergency_bid_cs2 || slEmergencyBidEsports);
    const slThresholdLol = Number(this.cfg?.paper?.stop_loss_bid_lol || slThresholdEsports);
    const slSpreadMaxLol = Number(this.cfg?.paper?.stop_loss_spread_max_lol || slSpreadMaxEsports);
    const slEmergencyBidLol = Number(this.cfg?.paper?.stop_loss_emergency_bid_lol || slEmergencyBidEsports);
    const slThresholdVal = Number(this.cfg?.paper?.stop_loss_bid_val || slThresholdEsports);
    const slSpreadMaxVal = Number(this.cfg?.paper?.stop_loss_spread_max_val || slSpreadMaxEsports);
    const slEmergencyBidVal = Number(this.cfg?.paper?.stop_loss_emergency_bid_val || slEmergencyBidEsports);
    const slThresholdNba = Number(this.cfg?.paper?.stop_loss_bid_nba || slThresholdDefault);
    const slSpreadMaxNba = Number(this.cfg?.paper?.stop_loss_spread_max_nba || slSpreadMaxDefault);
    const slEmergencyBidNba = Number(this.cfg?.paper?.stop_loss_emergency_bid_nba || slEmergencyBidDefault);
    const slThresholdCbb = Number(this.cfg?.paper?.stop_loss_bid_cbb || slThresholdDefault);
    const slSpreadMaxCbb = Number(this.cfg?.paper?.stop_loss_spread_max_cbb || slSpreadMaxDefault);
    const slEmergencyBidCbb = Number(this.cfg?.paper?.stop_loss_emergency_bid_cbb || slEmergencyBidDefault);
    const slThresholdCwbb = Number(this.cfg?.paper?.stop_loss_bid_cwbb || slThresholdDefault);
    const slSpreadMaxCwbb = Number(this.cfg?.paper?.stop_loss_spread_max_cwbb || slSpreadMaxDefault);
    const slEmergencyBidCwbb = Number(this.cfg?.paper?.stop_loss_emergency_bid_cwbb || slEmergencyBidDefault);
    const resolveThreshold = 0.997; // bid > this = market resolved

    const openTrades = Object.entries(this.execState.trades)
      .filter(([_, t]) => t.status === "filled" && !t.closed && String(t.side).toUpperCase() === "BUY");

    const signals = [];
    for (const [tradeId, trade] of openTrades) {
      const price = pricesBySlug.get(trade.slug);
      if (!price || price.yes_best_bid == null) continue;

      // Skip if a sell is already pending/queued/filled for this signal (but allow retry for failed)
      const sellKey = `sell:${trade.signal_id}`;
      const existingSellTrade = this.execState.trades[sellKey];
      if (existingSellTrade && existingSellTrade.status !== "failed_all_attempts") continue;

      const bid = Number(price.yes_best_bid);
      const ask = Number(price.yes_best_ask ?? 0);
      const entryPrice = Number(trade.entryPrice || trade.avgFillPrice);
      const shares = Number(trade.filledShares || 0);

      // --- PRICE TICK LOGGING (throttled per position) ---
      const now = Date.now();
      const lastTick = this._priceTickLastTs?.get(trade.signal_id) || 0;
      if (now - lastTick >= (this._priceTickIntervalMs || 30_000)) {
        this._priceTickLastTs?.set(trade.signal_id, now);
        const unrealizedPnl = shares * (bid - entryPrice);
        try {
          appendJsonl("state/journal/price_ticks.jsonl", {
            type: "price_tick",
            ts: now,
            signal_id: trade.signal_id,
            slug: trade.slug,
            bid,
            ask: ask || null,
            spread: ask > 0 ? +(ask - bid).toFixed(4) : null,
            entry_price: entryPrice,
            shares,
            unrealized_pnl: +unrealizedPnl.toFixed(4),
          });
        } catch { /* non-critical */ }
      }

      // --- RESOLUTION: bid > 0.997 OR (ask >= 0.999 AND bid > 0.997) ---
      // Both paths require bid > 0.997 to avoid selling at suboptimal prices.
      const resolvedByBid = bid > resolveThreshold;
      const resolvedByAsk = ask >= 0.999 && bid > resolveThreshold;
      if (resolvedByBid || resolvedByAsk) {
        const pnl = shares * (bid - entryPrice);
        const trigger = resolvedByBid ? `bid=${bid.toFixed(3)}` : `ask=${ask.toFixed(3)},bid=${bid.toFixed(3)}`;
        console.log(`[RESOLVED_CLOB] ${trade.slug} | ${trigger} | entry=${entryPrice.toFixed(3)} | pnl=$${pnl.toFixed(2)}`);
        signals.push({
          type: "signal_close",
          signal_id: trade.signal_id,
          slug: trade.slug,
          ts_close: Date.now(),
          close_reason: "resolved",
          resolve_method: "clob_terminal_price",
          resolved_price: bid,
          win: true,
          pnl_usd: pnl,
          roi: (trade.spentUsd > 0) ? pnl / trade.spentUsd : 0,
        });
        this._priceTickLastTs?.delete(trade.signal_id);
        continue;
      }

      // --- STOP LOSS: bid <= threshold AND ask <= ask_threshold ---
      // Requires BOTH bid and ask to be low to avoid false triggers from wide spreads.
      // Per-league thresholds: esports slugs (cs2-, dota2-, lol-) use separate config.
      const slugPrefix = String(trade.slug || "").split("-")[0];
      const isDota2 = slugPrefix === "dota2";
      const isCs2 = slugPrefix === "cs2";
      const isLol = slugPrefix === "lol";
      const isVal = slugPrefix === "val";
      const isNba = slugPrefix === "nba";
      const isCbb = slugPrefix === "cbb";
      const isCwbb = slugPrefix === "cwbb";
      const isEsports = (slugPrefix === "cs2" || slugPrefix === "dota2" || slugPrefix === "lol" || slugPrefix === "val");
      const slThreshold = isDota2 ? slThresholdDota2 : isCs2 ? slThresholdCs2 : isLol ? slThresholdLol : isVal ? slThresholdVal : isNba ? slThresholdNba : isCbb ? slThresholdCbb : isCwbb ? slThresholdCwbb : isEsports ? slThresholdEsports : slThresholdDefault;
      const slSpreadMax = isDota2 ? slSpreadMaxDota2 : isCs2 ? slSpreadMaxCs2 : isLol ? slSpreadMaxLol : isVal ? slSpreadMaxVal : isNba ? slSpreadMaxNba : isCbb ? slSpreadMaxCbb : isCwbb ? slSpreadMaxCwbb : isEsports ? slSpreadMaxEsports : slSpreadMaxDefault;
      const slEmergencyBid = isDota2 ? slEmergencyBidDota2 : isCs2 ? slEmergencyBidCs2 : isLol ? slEmergencyBidLol : isVal ? slEmergencyBidVal : isNba ? slEmergencyBidNba : isCbb ? slEmergencyBidCbb : isCwbb ? slEmergencyBidCwbb : isEsports ? slEmergencyBidEsports : slEmergencyBidDefault;
      const bidTriggered = slThreshold > 0 && slThreshold < 1 && bid <= slThreshold;
      const spread = (ask > 0 && bid > 0) ? (ask - bid) : 999;
      const spreadOk = spread <= slSpreadMax;
      const emergencyTriggered = slEmergencyBid > 0 && bid <= slEmergencyBid;
      // SL fires when: (bid below threshold AND spread is reasonable) OR (emergency: bid extremely low regardless of spread)
      if (bidTriggered && (spreadOk || emergencyTriggered)) {
        const slReason = emergencyTriggered && !spreadOk ? "emergency" : "normal";
        const pnl = shares * (bid - entryPrice);
        console.log(`[SL_CLOB] ${trade.slug} | bid=${bid.toFixed(3)} <= SL=${slThreshold} | spread=${spread.toFixed(3)} <= ${slSpreadMax} | emergency=${emergencyTriggered} | reason=${slReason} | entry=${entryPrice.toFixed(3)} | est_pnl=$${pnl.toFixed(2)}`);
        signals.push({
          type: "signal_close",
          signal_id: trade.signal_id,
          slug: trade.slug,
          ts_close: Date.now(),
          close_reason: "stop_loss",
          sl_trigger_price: bid,
          sl_threshold: slThreshold,
          win: false,
          pnl_usd: pnl,
          roi: (trade.spentUsd > 0) ? pnl / trade.spentUsd : 0,
        });
        this._priceTickLastTs?.delete(trade.signal_id);
        continue;
      }

      // --- CONTEXT SL: margin below threshold → sell ---
      // Only for sports with ESPN context (CBB, CWBB, NBA).
      // If our team's lead drops below min_margin_hold, sell immediately.
      const contextSlSports = new Set(["cbb", "cwbb", "nba"]);
      if (contextSlSports.has(slugPrefix)) {
        const ctxData = contextBySlug.get(trade.slug);
        const minMarginHold = Number(this.cfg?.context?.min_margin_hold ?? 3);
        if (ctxData) {
          const ctx = ctxData.context || {};
          const ctxEntry = ctxData.context_entry || {};
          // Compute margin_for_yes from live scores + yes_outcome_name
          const marginForYes = TradeBridge._computeMarginForYes(ctx, ctxEntry);
          if (marginForYes != null && Number.isFinite(marginForYes) && marginForYes < minMarginHold) {
            // Only trigger context SL if market also agrees (bid below threshold)
            const contextSlMaxBid = Number(this.cfg?.context?.context_sl_max_bid ?? 0.93);
            if (bid >= contextSlMaxBid) {
              // Market still confident despite tight score — skip context SL
              continue;
            }
            const pnl = shares * (bid - entryPrice);
            console.log(`[CONTEXT_SL] ${trade.slug} | margin=${marginForYes} < ${minMarginHold} | bid=${bid.toFixed(3)} < ${contextSlMaxBid} | entry=${entryPrice.toFixed(3)} | est_pnl=$${pnl.toFixed(2)}`);
            signals.push({
              type: "signal_close",
              signal_id: trade.signal_id,
              slug: trade.slug,
              ts_close: Date.now(),
              close_reason: "context_sl",
              context_margin: marginForYes,
              context_min_margin_hold: minMarginHold,
              sl_trigger_price: bid,
              win: pnl >= 0,
              pnl_usd: pnl,
              roi: (trade.spentUsd > 0) ? pnl / trade.spentUsd : 0,
            });
            this._priceTickLastTs?.delete(trade.signal_id);
          }
        }
      }
    }
    return signals;
  }

  /**
   * Compute margin_for_yes from live ESPN context + entry snapshot.
   * Uses yes_outcome_name from context_entry to determine which team is ours,
   * then computes (our_score - their_score) from live context.teams.
   * Returns null if data is insufficient.
   */
  static _computeMarginForYes(ctx, ctxEntry) {
    if (!ctx || !ctxEntry) return null;
    const yesName = ctxEntry.yes_outcome_name;
    if (!yesName) return null;

    const teamA = ctx.teams?.a;
    const teamB = ctx.teams?.b;
    if (!teamA?.name || !teamB?.name || teamA.score == null || teamB.score == null) return null;

    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const yesNorm = norm(yesName);
    const aNorm = norm(teamA.name);
    const bNorm = norm(teamB.name);
    const aFullNorm = teamA.fullName ? norm(teamA.fullName) : null;
    const bFullNorm = teamB.fullName ? norm(teamB.fullName) : null;

    const match = (y, t) => y && t && (y === t || y.includes(t) || t.includes(y));
    const yesIsA = match(yesNorm, aNorm) || match(yesNorm, aFullNorm);
    const yesIsB = match(yesNorm, bNorm) || match(yesNorm, bFullNorm);

    if (yesIsA && !yesIsB) return Number(teamA.score) - Number(teamB.score);
    if (yesIsB && !yesIsA) return Number(teamB.score) - Number(teamA.score);
    return null; // ambiguous
  }

  getStatus() {
    const openTrades = Object.values(this.execState.trades).filter(t => t.status === "filled" && !t.closed);
    const totalExposure = openTrades.reduce((sum, t) => sum + (t.spentUsd || 0), 0);
    const day = todayKey();
    
    return {
      mode: this.mode,
      paused: false,
      open_positions: openTrades.length,
      total_exposure_usd: totalExposure,
      daily_trades: this.execState.daily[day] || 0,
      last_balance: this.execState.last_balance ?? null,
      last_reconcile_ts: this.execState.last_reconcile_ts || null,
    };
  }
}
