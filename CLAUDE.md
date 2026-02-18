# CLAUDE.md — AI Coding Assistant Guide

**For: AI coding assistants working on polymarket-watchlist-v1**

This file contains everything you need to understand and modify the codebase safely. Read this BEFORE making any changes.

---

## Project Overview

**What it does:** High-frequency signal generation for Polymarket prediction markets. Discovers live sports/esports markets, evaluates them through a multi-stage pipeline with context-aware gates (ESPN scoreboards), and executes trades.

**Current status:** Running LIVE with real money ($128.75 balance, commit `540451f`)

**Key constraint:** This bot trades real money. **Every change must be tested extensively before deploy.**

---

## Project Structure

### Source Layout

```
src/
├── config/
│   ├── defaults.json          # Default config (never edit in prod)
│   └── local.json              # Prod overrides (edit with extreme care)
│
├── core/                       # Foundation modules (crash-safe, tested)
│   ├── config.js               # Config cascade (defaults → local → shadow → env)
│   ├── state_store.js          # Persistence (atomic+fsync+backup)
│   ├── journal.mjs             # Append-only JSONL (signals, positions)
│   ├── dirty_tracker.mjs       # Intelligent persistence (critical vs throttled)
│   ├── lockfile.js             # Single-runner lock
│   ├── time.js                 # Time utilities (nowMs, sleepMs)
│   └── invariants.js           # State consistency checks
│
├── gamma/                      # Gamma API discovery
│   ├── gamma_client.mjs        # Fetch events by tag (esports, nba, cbb, soccer)
│   └── gamma_parser.mjs        # Parse events→markets, detect leagues
│
├── clob/                       # CLOB API (price, depth, execution)
│   ├── book_http_client.mjs    # GET /book endpoint
│   ├── book_parser.mjs         # Parse and normalize book data
│   └── ws_client.mjs           # WebSocket price feed (auto-reconnect)
│
├── context/                    # External data feeds (ESPN scoreboards)
│   ├── espn_cbb_scoreboard.mjs # NCAA basketball
│   ├── espn_nba_scoreboard.mjs # NBA
│   └── espn_soccer_scoreboard.mjs # Soccer (multi-league)
│
├── strategy/                   # Signal pipeline logic (pure functions)
│   ├── stage1.mjs              # Base filters (price+spread+near)
│   ├── stage2.mjs              # Depth check
│   ├── win_prob_table.mjs      # Context entry gate (win probability)
│   ├── watchlist_upsert.mjs    # Market insertion/update
│   ├── ttl_cleanup.mjs         # Expire stale markets
│   └── eviction.mjs            # Watchlist size limit (FIFO)
│
├── runtime/                    # Main loops
│   ├── loop_gamma.mjs          # Gamma discovery (30s)
│   ├── loop_eval_http_only.mjs # Signal pipeline + price updates (2s)
│   ├── loop_resolution_tracker.mjs # Paper position resolution (60s)
│   ├── universe.mjs            # Universe selection (SINGLE SOURCE OF TRUTH)
│   ├── health_server.mjs       # HTTP monitoring (:3210)
│   ├── http_queue.mjs          # Concurrent HTTP queue
│   └── dashboard.html          # Visual dashboard
│
├── execution/                  # Trade execution layer
│   ├── trade_bridge.mjs        # Execution modes (paper/shadow_live/live)
│   └── order_executor.mjs      # CLOB client wrapper
│
├── metrics/                    # Observability
│   ├── daily_events.mjs        # Per-league funnel tracking
│   └── daily_snapshot.mjs      # Daily state snapshots
│
└── tools/                      # CLI utilities
    └── journal_stats.mjs       # Paper position analysis
```

### Key Entry Points

- **`run.mjs`**: Main entry point (loads config, acquires lock, starts loops)
- **`status.mjs`**: CLI dashboard (current state snapshot)
- **`src/runtime/loop_eval_http_only.mjs`**: Signal pipeline (most complex file, 2500 lines)
- **`src/runtime/loop_gamma.mjs`**: Gamma discovery loop
- **`src/core/config.js`**: Config loading (precedence chain)
- **`src/runtime/universe.mjs`**: Universe selection (centralized logic)

---

## Architecture: How Data Flows

### 1. Gamma Discovery Loop (30s)

```
fetchLiveEvents(tags) → parseEventsToMarkets() → upsertMarket() → watchlist
                                                              ↓
                                                      markExpired()
                                                              ↓
                                                      evictIfNeeded()
```

**Input:** Gamma API (`/events` by tag)
**Output:** Candidate markets in watchlist (status=watching)
**State mutation:** `state.watchlist[conditionId]` created/updated
**Filters:**
- min vol24h ($200)
- date window (endDateIso ±1 day from now, per-league configurable)
- ban: spreads, totals, draws, over/under

**Key files:**
- `src/gamma/gamma_client.mjs` — HTTP fetch
- `src/gamma/gamma_parser.mjs` — event→market transformation
- `src/strategy/watchlist_upsert.mjs` — insert/update logic
- `src/strategy/ttl_cleanup.mjs` — expire old markets
- `src/strategy/eviction.mjs` — FIFO eviction if watchlist >max

### 2. Price Update + Signal Pipeline (2s)

```
selectPriceUpdateUniverse() → WS/HTTP fetch → update last_price
                                                      ↓
selectPipelineUniverse() → ESPN context tagging → stage1 → stage2 → pending → signaled
```

**Universe A (price updates):** watching + pending_signal + **signaled**
**Universe B (signal pipeline):** watching + pending_signal (NO signaled)

**Critical invariant:** signaled markets MUST receive price updates (visibility) but MUST NOT re-enter pipeline (prevents duplicate signals).

**Price Update Path:**
1. Get token IDs (resolve YES/NO if needed via book score comparison)
2. Check WS cache (instant, <50ms)
3. If miss/stale → HTTP fallback (/book endpoint, 300-800ms)
4. Parse book → complementary pricing: `best_ask = min(yes_ask, 1 - no_bid)`
5. Update `market.last_price = { yes_best_ask, yes_best_bid, spread, updated_ts }`
6. Cache depth metrics (15s TTL, bust on 3¢ price move)

**Signal Pipeline Path (watching markets only):**

1. **ESPN Context Tagging** (if enabled)
   - Fetch scoreboard by dateKey (UTC day from market.endDateIso)
   - Match market → live game (team name normalization)
   - Derive context: period, score, minutes left
   - Compute win probability (Poisson for soccer, margin-based for basketball)
   - Store in `market.context` and `market.context_entry`

2. **Stage 1: Base Filters** (pure functions)
   - Price range: 0.93 ≤ ask ≤ 0.98
   - Max spread: 0.02
   - Near margin: ask ≥ 0.945 OR spread ≤ 0.015
   - EPS tolerance: 1e-6 (floating-point safety)

3. **Stage 2: Depth Check** (pure functions)
   - Entry depth (ask side): ≥ $1,000 below max_entry_price (0.98)
   - Exit depth (bid side): ≥ $2,000 above floor (0.70)
   - Iterates book levels until threshold met

4. **Pending Confirmation (6s window)**
   - Enter pending: set `status = pending_signal`, `pending_since_ts = now`
   - Cooldown: 20s per slug (prevents churning same market)
   - Timeout after 6s: log to signals.jsonl (`signal_timeout`)
   - Promote to signaled: if still passes Stage1+Stage2 after 6s

5. **Signal Generation**
   - Set `status = signaled`
   - Append to `journal/signals.jsonl` (`signal_open` event)
   - Update `journal/open_index.json` (open paper positions)
   - Include context snapshot (win prob, margin, time left, TP math)

6. **Trade Execution** (if mode != paper)
   - Load trade bridge (src/execution/trade_bridge.mjs)
   - Check guards (max position, exposure, concurrent, daily limit)
   - Execute buy (idempotent by signal_id)
   - Log to `journal/executions.jsonl`

**Key files:**
- `src/runtime/universe.mjs` — universe selection (SINGLE SOURCE OF TRUTH)
- `src/runtime/loop_eval_http_only.mjs` — main eval loop (2500 lines)
- `src/clob/ws_client.mjs` — WebSocket price feed
- `src/clob/book_http_client.mjs` — HTTP fallback
- `src/clob/book_parser.mjs` — parse and normalize book data
- `src/strategy/stage1.mjs` — base filters (pure)
- `src/strategy/stage2.mjs` — depth check (pure)
- `src/context/espn_*_scoreboard.mjs` — ESPN adapters
- `src/strategy/win_prob_table.mjs` — context entry gate

### 3. Resolution Tracker (60s)

```
loadOpenIndex() → for each open position → fetchGammaMarketBySlug()
                                                      ↓
                                           detectResolved() → signal_close
                                                      ↓
                                            addClosed(), removeOpen()
```

**Paper Stop Loss:**
- If current price ≤ 0.70 → close immediately (log `close_reason: stop_loss`)

**Resolution Detection:**
- Official: `market.closed = true` AND price ≥ 0.99
- Terminal: price ≥ 0.995 (safe for paper, real PnL identical)

**Timeout Resolution (counterfactual):**
- Reads `signal_timeout` events without matching `timeout_resolved`
- Polls Gamma for each unresolved timeout
- If resolved → compute hypothetical PnL
- Log verdict: `filter_saved_us` (would have lost) or `filter_cost_us` (would have won)

**Price Extremes Tracking:**
- Records min/max price during position lifetime
- Used for offline SL analysis (did we hold through dips?)

**Key files:**
- `src/runtime/loop_resolution_tracker.mjs` — resolution logic
- `src/core/journal.mjs` — open_index management

---

## Config System

### Cascade Order (highest to lowest precedence)

1. **Environment variables**: `WATCHLIST_CONFIG_JSON` (JSON string)
2. **Shadow config**: `state-{SHADOW_ID}/config-override.json` (if shadow runner)
3. **Local config**: `src/config/local.json` (prod overrides)
4. **Defaults**: `src/config/defaults.json` (baseline)

**Important:** `local.json` is gitignored. Never commit secrets or prod-specific settings to defaults.json.

### Config Structure

```javascript
{
  polling: {
    gamma_discovery_seconds: 30,
    clob_eval_seconds: 2,
    pending_window_seconds: 4,        // local.json override (default: 6)
    max_watchlist: 200,
    http_max_concurrency: 5,
    eval_max_markets_per_cycle: 20,
    max_token_resolves_per_cycle: 5
  },
  filters: {
    EPS: 1e-6,               // Floating-point tolerance
    min_prob: 0.93,          // Entry range lower bound
    max_entry_price: 0.98,   // Entry range upper bound
    max_spread: 0.04,        // local.json override (default: 0.02)
    near_prob_min: 0.945,    // Near margin (ask)
    near_spread_max: 0.015,  // Near margin (spread)
    min_exit_depth_usd_bid: 2000,
    min_entry_depth_usd_ask: 500,    // local.json override (default: 1000)
    exit_depth_floor_price: 0.70
  },
  gamma: {
    gamma_base_url: "https://gamma-api.polymarket.com",
    gamma_tags: ["esports", "nba", "ncaa-basketball", "soccer"],
    only_live_by_league: { cbb: true, nba: true, esports: true },
    min_vol24h_usd: 200,
    max_days_delta_keep_by_league: { cbb: 1, nba: 1, esports: 1 }
  },
  context: {
    enabled: true,
    entry_rules: {
      gate_mode: "tag_only",      // Default: observe, don't block
      gate_mode_nba: "blocking",  // Live trading guard (REQUIRED for mode!=paper)
      gate_mode_cbb: "blocking",  // Live trading guard
      min_win_prob: 0.90,
      max_minutes_left: 5,
      min_margin: 1
    },
    cbb: { provider: "espn", fetch_seconds: 15, max_ctx_age_ms: 120000 },
    nba: { provider: "espn", fetch_seconds: 15, max_ctx_age_ms: 120000 },
    soccer: { provider: "espn", fetch_seconds: 15 }
  },
  paper: {
    notional_usd: 10,
    stop_loss_bid: 0.70,   // Paper SL trigger (null = disabled)
    resolution_poll_seconds: 60
  },
  trading: {
    mode: "paper",  // or "shadow_live" or "live"
    credentials_path: "/path/to/.polymarket-credentials.json",
    funder_address: "0x...",
    max_position_usd: 10,
    max_total_exposure_usd: 50,
    max_concurrent_positions: 5,
    max_trades_per_day: 50,
    allowlist: null  // null = allow all, or ["slug1", "slug2"]
  },
  purge: {
    stale_book_minutes: 15,
    stale_quote_incomplete_minutes: 10,
    stale_tradeability_minutes: 12,
    expired_ttl_minutes: 30
  },
  health: {
    enabled: true,
    port: 3210,
    host: "127.0.0.1"
  }
}
```

### Reading Config in Code

```javascript
import { loadConfig } from "./src/core/config.js";
const cfg = loadConfig();
const minProb = Number(cfg?.filters?.min_prob ?? 0.94);
```

**Always use `??` or `||` with fallback defaults.** Never assume a key exists.

---

## State Management

### What's Persisted, How, and Why

**Primary state file:** `state/watchlist.json`

**Schema:**
```javascript
{
  version: 1,
  watchlist: {
    conditionId1: {
      slug: "epl-manchester-city-arsenal",
      league: "soccer",
      status: "watching",
      last_price: { yes_best_ask: 0.95, yes_best_bid: 0.93, spread: 0.02, updated_ts: 1234567890 },
      liquidity: { entry_depth_usd_ask: 1200, exit_depth_usd_bid: 2500 },
      context: { provider: "espn", sport: "soccer", period: 2, minutes_left: 12, ... },
      tokens: { clobTokenIds: ["id1", "id2"], yes_token_id: "id1", no_token_id: "id2" },
      first_seen_ts: 1234567890,
      last_seen_ts: 1234567890,
      // ... more fields
    },
    conditionId2: { ... }
  },
  runtime: {
    last_run_ts: 1234567890,
    runs: 42,
    health: { ... },
    context_cache: { ... },
    wsClient: null,  // NOT serialized (runtime only)
    // ... more runtime data
  }
}
```

**Persistence strategy:**
- **Dirty tracking**: marks important changes (status transitions, signals) vs cosmetic (health counters)
- **Critical changes**: persist immediately (new signals, resolutions)
- **Non-critical changes**: throttled to 5s (cache updates, health counters)
- **Atomic writes**: tmp file + rename + fsync (file + parent dir)
- **Backup rotation**: `.bak` file before every write

**Crash recovery:**
1. Try read `watchlist.json`
2. If corrupted → fallback to `watchlist.json.bak`
3. If both corrupted → start fresh (baseState())

**Code:**
```javascript
import { writeJsonAtomic, readJsonWithFallback } from "./src/core/state_store.js";

// Read (with automatic fallback)
const state = readJsonWithFallback(STATE_PATH) || baseState();

// Write (atomic + fsync + backup)
writeJsonAtomic(STATE_PATH, state);
```

### Journal (Append-Only)

**Files:**
- `state/journal/signals.jsonl` — source of truth for paper positions
- `state/journal/open_index.json` — fast lookup (rebuilt from JSONL on crash)
- `state/journal/executions.jsonl` — real trade execution log

**Schema (signals.jsonl):**
```javascript
// signal_open event
{
  type: "signal_open",
  runner_id: "prod",
  schema_version: 2,
  build_commit: "540451f",
  signal_id: "1234567890|epl-manchester-city-arsenal",
  ts_open: 1234567890,
  slug: "epl-manchester-city-arsenal",
  title: "Manchester City vs Arsenal",
  conditionId: "...",
  league: "soccer",
  entry_price: 0.95,
  spread: 0.02,
  paper_notional_usd: 10,
  entry_outcome_name: "Manchester City",
  would_gate_apply: true,
  would_gate_block: false,
  would_gate_reason: "allowed",
  tp_math_allowed: true,
  ctx: { ... },
  esports: null,
  status: "open"
}

// signal_close event
{
  type: "signal_close",
  signal_id: "1234567890|epl-manchester-city-arsenal",
  ts_close: 1234567890,
  close_reason: "resolved",  // or "stop_loss"
  resolve_method: "official",  // or "terminal_price"
  resolved_outcome_name: "Manchester City",
  win: true,
  paper_shares: 10.53,
  pnl_usd: 0.59,
  roi: 0.059,
  price_min_seen: 0.92,
  price_max_seen: 0.98
}

// signal_timeout event
{
  type: "signal_timeout",
  signal_id: "...",
  slug: "...",
  ts: 1234567890,
  timeout_reason: "fail_spread_above_max",
  entry_bid_at_pending: 0.94,
  bid_at_timeout: 0.91
}

// timeout_resolved event
{
  type: "timeout_resolved",
  slug: "...",
  timeout_ts: 1234567890,
  resolve_ts: 1234567891,
  resolved_winner: "Manchester City",
  would_have_won: false,
  hypothetical_pnl_usd: -10.0,
  verdict: "filter_saved_us"
}
```

**Reconciliation (crash recovery):**
```javascript
import { loadOpenIndex, reconcileIndex, saveOpenIndex } from "./src/core/journal.mjs";

const idx = loadOpenIndex();
const result = reconcileIndex(idx);  // Rebuilds from signals.jsonl
if (result.reconciled) {
  saveOpenIndex(idx);
  console.log(`Synced: added=${result.added} removed=${result.removed}`);
}
```

**Key property:** JSONL is append-only. Never edit existing lines. Only append new events.

---

## Trade Bridge Modes

### Paper (default)
- Signals logged to JSONL
- No real trades, no credentials needed
- Resolution via Gamma poll (60s)
- Safe for: strategy validation, testing new leagues

### Shadow Live
- Builds real orders (checks balance, depth, slippage)
- Logs what WOULD execute
- Does NOT send to CLOB
- Safe for: execution layer testing, pre-live validation

### Live
- **Real trades with real money**
- Idempotent by signal_id
- Pause fail-closed on SL exhaustion
- Guards: max position, exposure, concurrent, daily limit
- **ONLY use after extensive paper/shadow validation**

**Code:**
```javascript
// src/execution/trade_bridge.mjs
export class TradeBridge {
  constructor(cfg, state) {
    this.mode = cfg?.trading?.mode || "paper";
    // ...
  }

  async handleSignalOpen(signal) {
    if (this.mode === "paper") return null;
    
    // Idempotency
    const tradeId = `buy:${signal.signal_id}`;
    if (this.execState.trades[tradeId]) return;
    
    // Guards (pause, allowlist, daily limit, exposure, etc.)
    // ...
    
    if (this.mode === "shadow_live") {
      // Log what would happen, don't send
      console.log(`[SHADOW_BUY] ${signal.slug} ...`);
      return { status: "shadow", ... };
    }
    
    // LIVE execution
    const result = await executeBuy(this.client, tokenId, shares);
    // Telegram notification (fire-and-forget, never blocks trading)
    notifyTelegram(`🟢 BUY ${signal.slug} ...`);
    // ...
  }
}
```

**Telegram Notifications** (`src/notify/telegram.mjs`):
- Sends BUY/SELL alerts via Telegram Bot API
- Requires env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- Never throws — logs warning on failure, trading continues unaffected
- Set in launchd plist EnvironmentVariables + `.env` (gitignored)

---

## Testing

**Test count:** 437 tests across 18 files (all passing)

**How to run:**
```bash
npm test                                  # All tests
npm test -- --test-name-pattern="purge"  # Specific pattern
```

**Test categories:**
- **Universe selection** (20 tests) — invariants for price updates vs pipeline
- **Persistence** (24 tests) — crash-safe writes, dirty tracking
- **Health server** (18 tests) — HTTP endpoint, metrics
- **Complementary pricing** (10 tests) — binary market pricing
- **Purge gates** (15 tests) — stale market detection
- **ESPN context** (40+ tests) — scoreboard parsing, team matching
- **Signal pipeline** (60+ tests) — stage1, stage2, pending, timeout
- **Resolution tracker** (20 tests) — Gamma poll, SL triggers
- **Journal** (15 tests) — JSONL reconciliation, open_index

**Test structure:**
```javascript
import { describe, test } from "node:test";
import assert from "node:assert";

describe("Stage1 Filters", () => {
  test("base price range check", () => {
    const cfg = { filters: { min_prob: 0.94, max_entry_price: 0.97, EPS: 1e-6 } };
    const quote = { probAsk: 0.95, spread: 0.01 };
    const result = is_base_signal_candidate(quote, cfg);
    assert.strictEqual(result.pass, true);
  });
});
```

**Common patterns:**
- Mock config: `mockConfig({ filters: { min_prob: 0.90 } })`
- Mock market: `mockMarket({ slug: "test", status: "watching" })`
- Time mocking: pass explicit timestamps, don't use Date.now() in tests
- State snapshots: clone state before mutation, assert changes

---

## Common Patterns

### 1. bumpBucket(kind, key, count)

Rolling 5-minute buckets for health counters.

```javascript
function bumpBucket(kind, key, by = 1) {
  const nowMs = now;
  const minuteStart = Math.floor(nowMs / 60000) * 60000;
  health.buckets = health.buckets || { reject: { idx: 0, buckets: [] }, token: { idx: 0, buckets: [] } };
  const node = health.buckets[kind] || (health.buckets[kind] = { idx: 0, buckets: [] });
  if (!Array.isArray(node.buckets) || node.buckets.length !== 5) {
    node.buckets = Array.from({ length: 5 }, () => ({ start_ts: 0, counts: {} }));
    node.idx = 0;
  }
  const cur = node.buckets[node.idx];
  if (cur.start_ts !== minuteStart) {
    node.idx = (node.idx + 1) % 5;
    node.buckets[node.idx] = { start_ts: minuteStart, counts: {} };
  }
  const b = node.buckets[node.idx];
  b.counts[key] = (b.counts[key] || 0) + by;
}

// Usage:
bumpBucket("health", "quote_update", 1);
bumpBucket("reject", "spread_above_max", 1);
bumpBucket("token", "success:esports", 1);
```

**Purpose:** Track metrics over last 5 minutes (used in status.mjs verbose mode, health endpoint).

### 2. setReject(market, reason, extra)

Primary reject tracking (cumulative + per-cycle).

```javascript
function setReject(m, reason, extra) {
  m.last_reject = { reason, ts: Date.now(), ...extra };
  health.reject_counts_cumulative[reason] = (health.reject_counts_cumulative[reason] || 0) + 1;
}

// Usage:
setReject(m, "spread_above_max", { spread: 0.025 });
```

**Purpose:** Track why markets don't signal. Used for top reject reasons in dashboard.

### 3. Dirty Tracking

```javascript
import { DirtyTracker } from "./src/core/dirty_tracker.mjs";

const dirtyTracker = new DirtyTracker();

// Mark changes
dirtyTracker.mark("gamma:markets_added:5", false);  // Non-critical, throttled
dirtyTracker.mark("eval:signals_generated:2", true); // Critical, immediate

// Decide whether to persist
if (dirtyTracker.shouldPersist(now, { throttleMs: 5000 })) {
  writeJsonAtomic(STATE_PATH, state);
  dirtyTracker.clear(now);
}
```

**Purpose:** Reduce I/O (67% fewer writes) without sacrificing durability. Critical changes persist immediately, cosmetic changes throttled.

### 4. resolvePath(...parts)

Resolves paths relative to correct state directory (prod or shadow).

```javascript
import { resolvePath } from "./src/core/state_store.js";

const p = resolvePath("state", "watchlist.json");
// prod:   /path/to/polymarket-watchlist-v1/state/watchlist.json
// shadow: /path/to/polymarket-watchlist-v1/state-test01/watchlist.json
```

**Purpose:** Shadow runners use isolated state dirs. Always use resolvePath() for state files.

### 5. Universe Selection (SINGLE SOURCE OF TRUTH)

```javascript
import { selectPriceUpdateUniverse, selectPipelineUniverse } from "./src/runtime/universe.mjs";

// Price updates: watching + pending + signaled
const priceUpdateUniverse = selectPriceUpdateUniverse(state, cfg);

// Signal pipeline: watching + pending (NO signaled)
const pipelineUniverse = selectPipelineUniverse(state, cfg);
```

**Critical invariant:** signaled markets MUST receive price updates (visibility) but MUST NOT re-enter pipeline (prevents duplicate signals).

**Tests:** `tests/universe_selection.test.mjs` (20 tests)

### 6. Complementary Pricing (Binary Markets)

```javascript
// YES price + NO price = 1.00 (always)
// If one side missing → compute from complement

const bestAskYes = (() => {
  const yesAsk = parsePrice(rawBookYes?.asks?.[0]?.price);
  const noBid = parsePrice(rawBookNo?.bids?.[0]?.price);
  if (yesAsk != null && noBid != null) return Math.min(yesAsk, 1 - noBid);
  if (yesAsk != null) return yesAsk;
  if (noBid != null) return 1 - noBid;
  return null;
})();
```

**Purpose:** One-sided books don't mean no liquidity. Compute synthetic price from complement.

**Tests:** `tests/complementary_pricing.test.mjs` (10 tests)

---

## Shadow Runner Architecture

**Purpose:** Test changes with isolated state, separate from production.

### Isolation Rules

1. **State dir:** `state-{SHADOW_ID}/` (not `state/`)
2. **Lock file:** `state-{SHADOW_ID}/watchlist.lock`
3. **Port:** auto-assigned (3211-3260, deterministic from hash)
4. **Config:** defaults → local → `state-{SHADOW_ID}/config-override.json` → env
5. **Kill switches:**
   - MUST NOT have trading enabled (boot guard)
   - MUST NOT resolve to prod state dir (path validation)

### Example

```bash
# Start shadow with custom config
SHADOW_ID=test01 node run.mjs &

# Or use script
./scripts/shadow-start.sh test01 --maxwl 10

# Check status
./scripts/shadow-list.sh

# Compare metrics
./scripts/shadow-compare.sh test01 prod

# Stop
./scripts/shadow-stop.sh test01
```

**Config override** (`state-test01/config-override.json`):
```json
{
  "polling": {
    "max_watchlist": 10
  },
  "filters": {
    "min_prob": 0.90
  }
}
```

**Code checks:**
```javascript
// run.mjs
const IS_SHADOW = !runner.isProd;

if (IS_SHADOW) {
  // Kill switch: shadow must NEVER have live trading
  if (cfg.trading?.enabled || cfg.trading?.live) {
    console.error(`[SHADOW] FATAL: Shadow has live trading enabled`);
    process.exit(1);
  }
  
  // Verify state dir isolation
  if (stateDir.endsWith("/state") || stateDir === "state") {
    console.error(`[SHADOW] FATAL: State dir = prod directory`);
    process.exit(1);
  }
}
```

---

## Known Gotchas and Lessons Learned

### 1. Always Run Boot Check Before Deploy

**Lesson (2026-02-16):** Syntax error in nested `??` and `||` expression crashed prod. Tests passed because they import modules individually, not full boot sequence.

**Checklist BEFORE every deploy:**
```bash
npm test                                      # All tests pass
node -e "import('./src/runtime/loop_eval_http_only.mjs')"  # Parse check
STOP_AFTER_MS=5000 node run.mjs              # 5s boot test
# Verify config in first 50 lines (min_prob, max_spread, trading.mode)
```

### 2. Token Resolution Requires BOTH Books

**Lesson (2026-02-16):** One-sided YES books (ask missing) reported wrong prices. Only fetched YES, computed from NO complement.

**Fix:** Always fetch YES and NO books, use complementary pricing.

**Code:**
```javascript
const yesAsk = parsePrice(bookYes?.asks?.[0]?.price);
const noBid = parsePrice(bookNo?.bids?.[0]?.price);
const bestAsk = (yesAsk != null && noBid != null) ? Math.min(yesAsk, 1 - noBid) : (yesAsk ?? (noBid != null ? 1 - noBid : null));
```

### 3. Universe Selection Must Be Centralized

**Lesson (2026-02-16):** Duplicate logic in loop_gamma and loop_eval caused divergence when adding new statuses.

**Fix:** Single source of truth in `src/runtime/universe.mjs`.

**Tests:** `tests/universe_selection.test.mjs` enforces invariants.

### 4. Dirty Tracking Reduces I/O Without Sacrificing Durability

**Lesson (2026-02-16):** Writing state every cycle (30/min) caused unnecessary disk I/O. But skipping writes risked losing signals on crash.

**Fix:** Mark critical changes (signals, status transitions) for immediate persist. Throttle cosmetic changes (health counters) to 5s.

**Code:**
```javascript
if (newSignalsCount > 0) {
  dirtyTracker.mark(`eval:signals_generated:${newSignalsCount}`, true);  // critical
}
if (cache updated) {
  dirtyTracker.mark("gamma:cache_updated", false);  // throttled
}
```

### 5. Fsync Matters for Crash Safety

**Lesson (2026-02-16):** Atomic writes (tmp + rename) aren't enough. Power loss can leave data in buffer, file appears empty after boot.

**Fix:** fsync both file and parent directory.

**Code:**
```javascript
// src/core/state_store.js
writeFileSync(tmp, raw + "\n", "utf8");

const fd = openSync(tmp, "r+");
fsyncSync(fd);  // Force flush to disk
closeSync(fd);

renameSync(tmp, path);  // Atomic rename

const dirFd = openSync(dir, "r");
fsyncSync(dirFd);  // Ensure rename is durable
closeSync(dirFd);
```

### 6. Purge Gates Prevent Watchlist Pollution

**Lesson (2026-02-16):** Markets with sustained tradeability issues accumulate in watchlist, waste eval cycles.

**Fix:** Track first occurrence of degradation (book stale, quote incomplete, bad tradeability). Purge after threshold.

**Gates:**
- Book stale: 15 min without successful /book fetch
- Quote incomplete: 10 min of one-sided quotes
- Tradeability degraded: 12 min of spread + depth both failing

**Tests:** `tests/purge_gates.test.mjs` (15 tests)

### 7. Gamma Live Protection with WS Activity Check

**Lesson (2026-02-17):** Markets marked "live" by Gamma but with no WS activity for >10 min are actually dead. Purge gates were blocked forever.

**Fix:** Check WS activity age. If >10 min without update AND WS is healthy → unprotect and allow purge.

**Code:**
```javascript
const wsHealthy = wsClient?.isConnected === true;
const yesToken = m.tokens?.yes_token_id;
if (wsHealthy && yesToken) {
  const wsPrice = wsClient.getPrice(yesToken);
  if (wsPrice && (now - wsPrice.lastUpdate) > 600000) {
    // No WS activity for 10 min → dead market
    return false;  // Don't protect from purge
  }
}
```

**Tests:** `tests/gamma_live_protection.test.mjs` (8 tests)

---

## How to Add a New League/Sport

### Example: Adding MMA

**Step 1: Update Gamma Config**

`src/config/local.json`:
```json
{
  "gamma": {
    "gamma_tags": ["esports", "nba", "ncaa-basketball", "soccer", "mma"]
  }
}
```

**Step 2: Add Parser Logic**

`src/gamma/gamma_parser.mjs`:
```javascript
function leagueFromTag(tag) {
  if (tag === "mma") return "mma";
  // ...
}

function pickMarketsForEvent(tag, e, cfg) {
  if (tag === "mma") {
    // MMA-specific logic: ban method/round bets, keep fight winners
    const winners = active.filter(m => !m.slug.includes("-method-") && !m.slug.includes("-round-"));
    return winners.slice(0, 2);  // top 2 by volume
  }
  // ...
}
```

**Step 3: Add Context Provider (Optional)**

If you want ESPN/external data:

`src/context/espn_mma_scoreboard.mjs`:
```javascript
export async function fetchEspnMmaScoreboard(cfg, date) {
  // Similar to espn_nba_scoreboard.mjs
}

export function deriveMmaContextForMarket(market, events, cfg, now) {
  // Match market to live fight, derive round/time left
}
```

Then integrate in `src/runtime/loop_eval_http_only.mjs`:
```javascript
// In context tagging section
for (const m of wl) {
  if (m.league !== "mma") continue;
  // Fetch scoreboard, match, derive context
}
```

**Step 4: Add Tests**

`tests/mma_pipeline.test.mjs`:
```javascript
import { describe, test } from "node:test";
import assert from "node:assert";

describe("MMA Pipeline", () => {
  test("bans method/round markets", () => {
    const markets = [
      { slug: "ufc-jones-miocic", active: true },
      { slug: "ufc-jones-miocic-method-ko", active: true },
      { slug: "ufc-jones-miocic-round-1", active: true }
    ];
    const picked = pickMarketsForEvent("mma", { markets }, {});
    assert.strictEqual(picked.length, 1);
    assert.strictEqual(picked[0].slug, "ufc-jones-miocic");
  });
});
```

**Step 5: Dry-Run Validation**

```bash
# Start shadow runner with MMA tag
./scripts/shadow-start.sh mma-test --tags '["mma"]'

# Monitor for 1-2h
./scripts/shadow-list.sh

# Check metrics
curl http://localhost:3XXX/api/health | jq '.league_summary.mma'
```

**Step 6: Deploy to Prod**

If capture rate and signal quality look good:
```bash
# Update local.json
vim src/config/local.json  # add "mma" to gamma_tags

# Boot check
STOP_AFTER_MS=5000 node run.mjs  # verify config

# Deploy
git add -A && git commit -m "feat: add MMA support" && git push
# Restart prod runner
```

---

## How to Add a New Strategy Filter

### Example: Ban Markets with <5 Minutes to Close

**Step 1: Add to Stage1**

`src/strategy/stage1.mjs`:
```javascript
export function is_base_signal_candidate(quote, cfg) {
  const EPS = Number(cfg?.filters?.EPS || 1e-6);
  const minProb = Number(cfg?.filters?.min_prob);
  const maxEntry = Number(cfg?.filters?.max_entry_price);
  const maxSpread = Number(cfg?.filters?.max_spread);
  
  // NEW: Check minutes to close
  const minMinutesToClose = Number(cfg?.filters?.min_minutes_to_close ?? 5);
  if (quote?.minutesToClose != null && quote.minutesToClose < minMinutesToClose) {
    return { pass: false, reason: "too_close_to_resolution" };
  }

  const probAsk = Number(quote?.probAsk);
  const spread = Number(quote?.spread);

  if (!gte(probAsk, minProb, EPS) || !lte(probAsk, maxEntry, EPS)) {
    return { pass: false, reason: "price_out_of_range" };
  }
  if (!lte(spread, maxSpread, EPS)) {
    return { pass: false, reason: "spread_above_max" };
  }
  return { pass: true, reason: null };
}
```

**Step 2: Add Config**

`src/config/defaults.json`:
```json
{
  "filters": {
    "min_minutes_to_close": 5
  }
}
```

**Step 3: Integrate in Eval Loop**

`src/runtime/loop_eval_http_only.mjs`:
```javascript
// In Stage1 check
const quote = {
  probAsk: Number(m.last_price.yes_best_ask),
  probBid: Number(m.last_price.yes_best_bid),
  spread: Number(m.last_price.spread),
  minutesToClose: computeMinutesToClose(m)  // NEW
};

const stage1 = is_base_signal_candidate(quote, cfg);
if (!stage1.pass) {
  setReject(m, stage1.reason);
  continue;
}
```

**Step 4: Add Tests**

`tests/stage1_minutes_to_close.test.mjs`:
```javascript
import { describe, test } from "node:test";
import assert from "node:assert";
import { is_base_signal_candidate } from "../src/strategy/stage1.mjs";

describe("Stage1: Minutes to Close Filter", () => {
  test("rejects if <5 minutes to close", () => {
    const cfg = { filters: { min_prob: 0.94, max_entry_price: 0.97, max_spread: 0.02, min_minutes_to_close: 5 } };
    const quote = { probAsk: 0.95, spread: 0.01, minutesToClose: 3 };
    const result = is_base_signal_candidate(quote, cfg);
    assert.strictEqual(result.pass, false);
    assert.strictEqual(result.reason, "too_close_to_resolution");
  });

  test("allows if >=5 minutes to close", () => {
    const cfg = { filters: { min_prob: 0.94, max_entry_price: 0.97, max_spread: 0.02, min_minutes_to_close: 5 } };
    const quote = { probAsk: 0.95, spread: 0.01, minutesToClose: 6 };
    const result = is_base_signal_candidate(quote, cfg);
    assert.strictEqual(result.pass, true);
  });

  test("allows if minutesToClose not provided (no data)", () => {
    const cfg = { filters: { min_prob: 0.94, max_entry_price: 0.97, max_spread: 0.02, min_minutes_to_close: 5 } };
    const quote = { probAsk: 0.95, spread: 0.01, minutesToClose: null };
    const result = is_base_signal_candidate(quote, cfg);
    assert.strictEqual(result.pass, true);  // No data = don't reject
  });
});
```

**Step 5: Dry-Run Validation**

```bash
# Shadow runner with new filter
./scripts/shadow-start.sh minutes-test --min_minutes 5

# Monitor reject reasons
npm run status:verbose  # Check top rejects for "too_close_to_resolution"
```

**Step 6: Deploy**

If reject count matches expectations:
```bash
npm test  # All tests pass
git add -A && git commit -m "feat: add min_minutes_to_close filter" && git push
# Deploy to prod
```

---

## Critical Rules

### 1. Always Run Tests Before Commit

```bash
npm test  # ALL tests must pass
```

If a change breaks existing tests, fix them in the same commit.

### 2. Boot Check Before Deploy (MANDATORY)

```bash
npm test
node -e "import('./src/runtime/loop_eval_http_only.mjs')"
STOP_AFTER_MS=5000 node run.mjs
```

Verify config in first 50 lines matches expectations.

### 3. Never Modify Trading Params Without Confirmation

- Changing env vars (vol, margin, prob)
- Adding trading logic (GTC, websocket, new execution modes)
- Modifying filters, gates, strategy

**Always:** propose → wait for approval → dry-run → wait for approval → deploy

### 4. Shadow Validation for Risky Changes

Changes that affect signal generation:
- New leagues (might have unknown data quality)
- New filters (might block all signals or allow bad ones)
- Config changes (min_prob, max_spread, depth thresholds)

**Always:** run shadow for 1-2h, compare metrics before prod deploy.

### 5. Commit Messages Must Be Descriptive

```bash
# Good
git commit -m "feat: add MMA support with method/round ban logic"
git commit -m "fix: complementary pricing for one-sided books"

# Bad
git commit -m "update"
git commit -m "changes"
```

### 6. Document What Changed and Why

```javascript
// GOOD: Explains intent
// Complementary pricing: YES price + NO price = 1.00 (binary markets)
// If YES ask missing → compute from NO bid (1 - noBid)
const bestAsk = yesAsk ?? (noBid != null ? 1 - noBid : null);

// BAD: No context
const bestAsk = yesAsk ?? (noBid != null ? 1 - noBid : null);
```

### 7. Never Skip JSONL Reconciliation on Boot

`run.mjs` always calls:
```javascript
const idx = loadOpenIndex();
const result = reconcileIndex(idx);
if (result.reconciled) saveOpenIndex(idx);
```

**Purpose:** Crash recovery. Rebuilds open_index from signals.jsonl if desync detected.

### 8. Use resolvePath() for All State File Operations

```javascript
// GOOD
const p = resolvePath("state", "watchlist.json");

// BAD
const p = "state/watchlist.json";  // Breaks shadow runners
```

### 9. Handle Missing Config Keys Defensively

```javascript
// GOOD
const minProb = Number(cfg?.filters?.min_prob ?? 0.94);

// BAD
const minProb = cfg.filters.min_prob;  // Crashes if key missing
```

### 10. Never Assume Data Exists

```javascript
// GOOD
const outcomes = Array.isArray(m?.outcomes) ? m.outcomes : null;

// BAD
const outcomes = m.outcomes;  // Crashes if m is null or outcomes is not an array
```

---

## Debugging Tips

### 1. Check First 50 Lines of run.mjs Output

Contains full config dump. Verify:
- `min_prob`, `max_spread`, `trading.mode`
- `gamma_tags`, `max_watchlist`
- Boot checks passed (shadow isolation, lock acquired)

### 2. Use Status Dashboard for Quick Diagnostics

```bash
npm run status          # Quick snapshot
npm run status:verbose  # Full metrics + top candidates
```

Look for:
- Top reject reasons (why markets don't signal)
- Gamma fetch health (are we getting markets?)
- WS connection status (are price updates working?)
- Open positions (are signals generating?)

### 3. Health Endpoint for External Monitoring

```bash
curl http://localhost:3210/api/health | jq
```

Check:
- `.loop.last_cycle_age_seconds` (should be <10s)
- `.staleness.percent_stale_signaled` (should be 0%)
- `.http.success_rate_percent` (should be >98%)
- `.websocket.connected` (should be true)

### 4. Journal Stats for Paper Position Analysis

```bash
npm run journal:stats -- --since_hours 24 --only_esports true
```

Shows:
- Win rate, PnL, ROI
- Timeout effectiveness (filter_saved_us vs filter_cost_us)
- Price extremes (did we hold through dips?)

### 5. Inspect State File Directly

```bash
cat state/watchlist.json | jq '.watchlist | to_entries | .[0:5]'
```

Look for:
- `.status` (watching, pending_signal, signaled, expired)
- `.last_price` (updated_ts should be recent)
- `.last_reject.reason` (why didn't it signal?)

### 6. Tail JSONL for Recent Events

```bash
tail -20 state/journal/signals.jsonl | jq -c
```

See:
- `signal_open` events (new signals)
- `signal_close` events (resolutions)
- `signal_timeout` events (pending confirmations that failed)

### 7. Compare Shadow vs Prod Metrics

```bash
./scripts/shadow-compare.sh test01 prod
```

If shadow performs worse:
- Check config differences
- Look at reject reasons (are filters too strict?)
- Verify Gamma fetch (are we missing markets?)

### 8. Check Log Timing Breakdown

Dashboard → Loop Performance → last_breakdown

Shows ms spent in:
- `gamma_ms` (discovery)
- `eval_ms` (signal pipeline)
- `journal_ms` (JSONL writes)
- `resolution_ms` (position tracking)
- `persist_ms` (state write)

If any >1000ms → bottleneck identified.

---

## Emergency Procedures

### Bot Crashed, Won't Restart

1. **Check lock file**
   ```bash
   cat state/watchlist.lock
   # If PID doesn't exist → rm state/watchlist.lock
   ```

2. **Check state file**
   ```bash
   cat state/watchlist.json | jq .version
   # If corrupted → cp state/watchlist.json.bak state/watchlist.json
   ```

3. **Reconcile journal**
   ```bash
   STOP_AFTER_MS=1000 node run.mjs
   # Check logs for reconciliation output
   ```

### All Signals Stopped

1. **Check watchlist size**
   ```bash
   npm run status
   # If 0 markets → Gamma fetch failing
   ```

2. **Check Gamma health**
   ```bash
   curl http://localhost:3210/api/health | jq '.loop.gamma_fetch_count'
   ```

3. **Check reject reasons**
   ```bash
   npm run status:verbose
   # Top reject = bottleneck
   ```

4. **Verify filters**
   ```bash
   cat state/config-snapshot.json | jq '.filters'
   # Are thresholds too strict?
   ```

### WebSocket Disconnected

1. **Check connection**
   ```bash
   curl http://localhost:3210/api/health | jq '.websocket'
   ```

2. **Verify HTTP fallback**
   ```bash
   # Should show >0 HTTP fallback usage
   ```

3. **Restart bot**
   ```bash
   # WS client has auto-reconnect, but restart if stuck
   ```

### High Loop Time (>3s)

1. **Check depth cache hit rate**
   ```bash
   curl http://localhost:3210/api/health | jq '.depth_cache.hit_rate'
   # Should be >80%
   ```

2. **Check HTTP concurrency**
   ```bash
   cat state/config-snapshot.json | jq '.polling.http_max_concurrency'
   # Increase if needed (default 5)
   ```

3. **Check watchlist size**
   ```bash
   npm run status
   # If >100 markets → eviction not working
   ```

### SL Ladder Exhausted (Trading Paused)

1. **Check execution state**
   ```bash
   cat state/execution_state.json | jq '.paused'
   # If true → check pause_reason
   ```

2. **Manual intervention required**
   - Review failed SL sell in `journal/executions.jsonl`
   - Verify CLOB balance/positions match expected
   - If safe to resume → edit `execution_state.json`: `"paused": false`

3. **Resume trading**
   ```bash
   # Restart bot after unpause
   ```

---

## Performance Optimization Checklist

### If Loop Time >1s

- [ ] Check depth cache hit rate (target >80%)
- [ ] Verify WS connection (target >85% usage)
- [ ] Check HTTP concurrency (increase if needed)
- [ ] Profile breakdown (which phase is slow?)
- [ ] Reduce watchlist size (adjust eviction threshold)

### If HTTP Success Rate <98%

- [ ] Check rate limit counters
- [ ] Verify HTTP timeout (default 2500ms)
- [ ] Increase HTTP concurrency
- [ ] Check CLOB API status

### If Depth Cache Hit Rate <80%

- [ ] Check TTL (default 15s, increase if markets stable)
- [ ] Verify bust logic (3¢ price move, adjust if too sensitive)
- [ ] Check cache size (should match watchlist size)

### If Signals Not Generating

- [ ] Check top reject reasons (status.mjs verbose)
- [ ] Verify price updates (WS + HTTP fallback working)
- [ ] Check filters (are thresholds too strict?)
- [ ] Verify Gamma fetch (are markets being discovered?)

---

## Critical: Git & State Safety

**NEVER `git add -A` or `git add .`** — always `git add <specific files>`. State files live in `state/` and are gitignored. Using `-A` or `-f` on state files creates a time bomb where future commits silently overwrite runtime state.

**State and runtime logs NEVER go to git.** If state is lost, reconstruct from blockchain — not from git. State backup should use `cp` to a backup directory, never `git add -f`.

**Tests MUST use isolated state directories.** Use OS `tmpdir()` for test files, never write under `state/` or project root. Every test file path must be validated before write/delete. See `tests/reconcile_index.test.mjs` for the pattern.

**`resolvePath` args:** When calling `resolvePath` for state subpaths, use separate args: `resolvePath("state", "execution_state.json")` — NOT `resolvePath("state/execution_state.json")`. Only the first arg `=== "state"` triggers SHADOW_ID isolation.

## Final Notes

**This bot trades real money.** Every change has financial impact. Follow the critical rules, write tests, dry-run extensively.

**When in doubt, ask.** Don't guess. Don't skip validation. Don't deploy untested code.

**The codebase is deterministic.** Same inputs → same outputs. If behavior changes, a code change caused it. Find the diff.

**Tests are your safety net.** 535 tests (all passing) give confidence. Add tests for every change.

**Shadow runners are your friend.** Use them for risky changes. A/B test strategies. Validate before prod.

Good luck! 🚀
