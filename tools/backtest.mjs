#!/usr/bin/env node
/**
 * backtest.mjs — Polymarket Watchlist Bot Backtester
 *
 * Simulates different parameter sets against historical trade data.
 * Uses signals.jsonl (open/close pairs) + price_ticks.jsonl when available.
 *
 * Usage:
 *   node tools/backtest.mjs                    # run with defaults
 *   node tools/backtest.mjs --json             # output JSON
 *   node tools/backtest.mjs --verbose          # show per-trade detail
 *
 * What it does:
 * 1. Loads all closed trades from signals.jsonl
 * 2. Joins with open signals to get entry_price, spread, league
 * 3. For each parameter set, simulates:
 *    - Would this trade pass the entry filter? (min_prob, max_entry_price, max_spread)
 *    - Would the SL have triggered differently? (using exit_price / price ticks)
 * 4. Computes PnL, win rate, expectancy for each scenario
 */

import { readFileSync, existsSync } from "node:fs";

// --- Load data ---

function loadJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function inferLeague(slug) {
  const prefix = String(slug || "").split("-")[0];
  if (prefix === "cs2" || prefix === "dota2" || prefix === "lol") return "esports";
  if (prefix === "cbb") return "cbb";
  if (prefix === "nba") return "nba";
  if (prefix === "soccer") return "soccer";
  return "other";
}

// --- Build trade dataset ---

function buildTrades(signals, ticks) {
  const opens = new Map();
  const closes = new Map();

  for (const s of signals) {
    if (s.type === "signal_open") opens.set(s.signal_id, s);
    if (s.type === "signal_close" && s.pnl_usd != null) closes.set(s.signal_id, s);
  }

  // Build tick history per signal_id
  const ticksBySignal = new Map();
  for (const t of ticks) {
    if (!t.signal_id) continue;
    if (!ticksBySignal.has(t.signal_id)) ticksBySignal.set(t.signal_id, []);
    ticksBySignal.get(t.signal_id).push(t);
  }

  const trades = [];
  for (const [id, close] of closes) {
    const open = opens.get(id);
    const entry_price = open?.entry_price ?? close?.entry_price ?? null;
    const spread = open?.spread ?? null;
    const league = open?.league || close?.league || inferLeague(close.slug);
    const notional = open?.paper_notional_usd ?? 10;
    const shares = entry_price > 0 ? notional / entry_price : 0;

    // Price path: from ticks or from close data
    const priceTicks = ticksBySignal.get(id) || [];
    const tickBids = priceTicks.map(t => t.bid).filter(x => x != null);
    const tickAsks = priceTicks.map(t => t.ask).filter(x => x != null && x > 0);

    // Best available min/max prices
    let min_bid = tickBids.length ? Math.min(...tickBids) : null;
    let max_bid = tickBids.length ? Math.max(...tickBids) : null;
    let min_ask = tickAsks.length ? Math.min(...tickAsks) : null;

    // If we have exit_price or sl_trigger_price, use as additional data point
    if (close.exit_price != null) {
      if (min_bid == null || close.exit_price < min_bid) min_bid = close.exit_price;
    }
    if (close.sl_trigger_price != null) {
      if (min_bid == null || close.sl_trigger_price < min_bid) min_bid = close.sl_trigger_price;
    }

    trades.push({
      signal_id: id,
      slug: close.slug,
      league,
      entry_price,
      spread,
      notional,
      shares,
      close_reason: close.close_reason,
      exit_price: close.exit_price ?? close.sl_trigger_price ?? null,
      actual_pnl: close.pnl_usd,
      actual_win: close.win,
      min_bid,
      max_bid,
      min_ask,
      tick_count: priceTicks.length,
    });
  }

  return trades;
}

// --- Simulate a parameter set ---

function simulate(trades, params) {
  const {
    label,
    min_prob = 0.93,
    max_entry_price = 0.97,
    max_spread = 0.04,
    sl_bid = 0.85,
    sl_ask = 0.90,
    sl_bid_esports = null,  // null = use sl_bid
    sl_ask_esports = null,  // null = use sl_ask
  } = params;

  const slBidE = sl_bid_esports ?? sl_bid;
  const slAskE = sl_ask_esports ?? sl_ask;

  const results = [];
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let filtered = 0;
  let totalWinPnl = 0;
  let totalLossPnl = 0;

  for (const t of trades) {
    // --- Entry filter ---
    if (t.entry_price != null) {
      if (t.entry_price < min_prob || t.entry_price > max_entry_price) {
        filtered++;
        continue;
      }
    }
    if (t.spread != null && max_spread != null) {
      if (t.spread > max_spread + 1e-6) {
        filtered++;
        continue;
      }
    }

    // --- SL simulation ---
    const isEsports = (t.league === "esports");
    const slBid = isEsports ? slBidE : sl_bid;
    const slAskT = isEsports ? slAskE : sl_ask;

    let simPnl = t.actual_pnl;
    let simWin = t.actual_win;
    let simReason = t.close_reason;

    if (t.close_reason === "stop_loss") {
      // The actual SL triggered at exit_price. Would our new SL have triggered?
      // If exit_price <= our SL bid, it would have triggered at our threshold or the actual exit
      // (whichever is higher = less loss)
      const actualExit = t.exit_price ?? 0;
      if (actualExit > slBid) {
        // Our SL is lower than actual exit — the old SL triggered but ours wouldn't have
        // The trade might have won. We don't know for sure without full price path.
        // Conservative: use min_bid if available
        if (t.min_bid != null && t.min_bid <= slBid) {
          // Price went below our SL too — just triggered later/at different price
          const exitAtSl = Math.max(slBid, t.min_bid); // best case: exit at our SL level
          simPnl = t.shares * (exitAtSl - t.entry_price);
          simWin = false;
          simReason = "stop_loss_sim";
        } else {
          // Price never went below our SL — this trade might have won!
          // We assume it resolved as a win (conservative: exit at 0.999)
          simPnl = t.shares * (0.999 - t.entry_price);
          simWin = true;
          simReason = "saved_by_lower_sl";
        }
      } else {
        // Our SL would have triggered too, but possibly at a better price
        // Exit at our SL threshold (we sell at slBid, not the actual lower exit)
        const exitAtSl = Math.max(slBid, actualExit);
        simPnl = t.shares * (exitAtSl - t.entry_price);
        simWin = false;
        simReason = "stop_loss_sim";
      }
    } else if (t.close_reason === "resolved" && t.actual_win) {
      // Winning trade — but would our SL have killed it?
      if (t.min_bid != null && t.min_bid <= slBid) {
        // Price dipped below our SL during the trade — false stop
        simPnl = t.shares * (slBid - t.entry_price);
        simWin = false;
        simReason = "false_stop";
      }
      // else: price never went below SL, trade resolves as normal
    }

    if (simWin) {
      wins++;
      totalWinPnl += simPnl;
    } else {
      losses++;
      totalLossPnl += simPnl;
    }
    totalPnl += simPnl;

    results.push({
      slug: t.slug,
      league: t.league,
      entry: t.entry_price,
      sim_pnl: +simPnl.toFixed(4),
      sim_win: simWin,
      sim_reason: simReason,
      actual_pnl: t.actual_pnl,
      actual_reason: t.close_reason,
    });
  }

  const totalTrades = wins + losses;
  return {
    label,
    params: { min_prob, max_entry_price, max_spread, sl_bid, sl_ask, sl_bid_esports: slBidE, sl_ask_esports: slAskE },
    summary: {
      trades: totalTrades,
      filtered,
      wins,
      losses,
      win_rate: totalTrades > 0 ? +(wins / totalTrades * 100).toFixed(1) : 0,
      total_pnl: +totalPnl.toFixed(2),
      avg_win: wins > 0 ? +(totalWinPnl / wins).toFixed(4) : 0,
      avg_loss: losses > 0 ? +(totalLossPnl / losses).toFixed(4) : 0,
      expectancy: totalTrades > 0 ? +(totalPnl / totalTrades).toFixed(4) : 0,
      profit_factor: totalLossPnl < 0 ? +(-totalWinPnl / totalLossPnl).toFixed(2) : Infinity,
    },
    trades: results,
  };
}

// --- Parameter scenarios ---

function getScenarios() {
  return [
    {
      label: "ACTUAL (old: SL=0.70, entry≤0.98)",
      sl_bid: 0.70, sl_ask: 0, // no ask guard
      sl_bid_esports: 0.70, sl_ask_esports: 0,
      max_entry_price: 0.98,
    },
    {
      label: "CURRENT (SL=0.85/0.90, esports=0.75/0.80, entry≤0.97)",
      sl_bid: 0.85, sl_ask: 0.90,
      sl_bid_esports: 0.75, sl_ask_esports: 0.80,
      max_entry_price: 0.97,
    },
    {
      label: "Tight SL (0.88/0.92, esports=0.80/0.85)",
      sl_bid: 0.88, sl_ask: 0.92,
      sl_bid_esports: 0.80, sl_ask_esports: 0.85,
      max_entry_price: 0.97,
    },
    {
      label: "Wide SL (0.80/0.85, esports=0.70/0.75)",
      sl_bid: 0.80, sl_ask: 0.85,
      sl_bid_esports: 0.70, sl_ask_esports: 0.75,
      max_entry_price: 0.97,
    },
    {
      label: "Entry ≤0.95 only",
      sl_bid: 0.85, sl_ask: 0.90,
      sl_bid_esports: 0.75, sl_ask_esports: 0.80,
      max_entry_price: 0.95,
    },
    {
      label: "Entry 0.94-0.96",
      min_prob: 0.94,
      sl_bid: 0.85, sl_ask: 0.90,
      sl_bid_esports: 0.75, sl_ask_esports: 0.80,
      max_entry_price: 0.96,
    },
    {
      label: "No SL (hold to resolution)",
      sl_bid: 0.01, sl_ask: 0, // effectively no SL
      sl_bid_esports: 0.01, sl_ask_esports: 0,
      max_entry_price: 0.97,
    },
  ];
}

// --- Main ---

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const verbose = args.includes("--verbose");

  const signalsPath = "state/journal/signals.jsonl";
  const ticksPath = "state/journal/price_ticks.jsonl";

  console.log("[BACKTEST] Loading data...");
  const signals = loadJsonl(signalsPath);
  const ticks = loadJsonl(ticksPath);
  console.log(`[BACKTEST] ${signals.length} signal entries, ${ticks.length} price ticks`);

  const trades = buildTrades(signals, ticks);
  console.log(`[BACKTEST] ${trades.length} closed trades for simulation`);
  console.log(`[BACKTEST] ${trades.filter(t => t.tick_count > 0).length} trades with price tick history`);
  console.log();

  // Per-league breakdown
  const leagues = {};
  for (const t of trades) {
    leagues[t.league] = (leagues[t.league] || 0) + 1;
  }
  console.log(`[BACKTEST] By league: ${Object.entries(leagues).map(([k,v]) => `${k}=${v}`).join(", ")}`);
  console.log();

  const scenarios = getScenarios();
  const results = scenarios.map(s => simulate(trades, s));

  if (jsonMode) {
    console.log(JSON.stringify(results.map(r => ({ label: r.label, ...r.summary })), null, 2));
    return;
  }

  // Table output
  const header = "| Scenario | Trades | Wins | Losses | Win% | PnL | Avg Win | Avg Loss | Expect | PF |";
  const sep =    "|----------|--------|------|--------|------|-----|---------|----------|--------|----|";
  console.log(header);
  console.log(sep);
  for (const r of results) {
    const s = r.summary;
    const pf = s.profit_factor === Infinity ? "∞" : s.profit_factor.toFixed(1);
    console.log(`| ${r.label.padEnd(55)} | ${String(s.trades).padStart(3)} | ${String(s.wins).padStart(3)} | ${String(s.losses).padStart(3)} | ${String(s.win_rate).padStart(5)}% | $${s.total_pnl >= 0 ? "+" : ""}${s.total_pnl.toFixed(2).padStart(6)} | $${s.avg_win >= 0 ? "+" : ""}${s.avg_win.toFixed(3).padStart(5)} | $${s.avg_loss.toFixed(3).padStart(6)} | $${s.expectancy >= 0 ? "+" : ""}${s.expectancy.toFixed(3).padStart(5)} | ${pf.padStart(4)} |`);
  }
  console.log();

  // Verbose: show per-trade detail for current config
  if (verbose) {
    const current = results[1]; // CURRENT scenario
    console.log(`\n=== Per-trade detail: ${current.label} ===\n`);
    for (const t of current.trades) {
      const icon = t.sim_win ? "✅" : "❌";
      const changed = t.sim_reason !== t.actual_reason ? ` (was: ${t.actual_reason})` : "";
      console.log(`${icon} ${t.slug.padEnd(45)} | entry=${(t.entry||0).toFixed(3)} | pnl=$${t.sim_pnl >= 0 ? "+" : ""}${t.sim_pnl.toFixed(2).padStart(5)} | ${t.sim_reason}${changed}`);
    }
  }

  // Data quality note
  console.log("⚠️  Note: SL simulation accuracy depends on price tick history.");
  console.log(`   ${trades.filter(t => t.tick_count > 0).length}/${trades.length} trades have tick data. Results improve as more ticks accumulate.`);
  console.log(`   Trades without ticks use exit_price as the only known low point.`);
}

main();
