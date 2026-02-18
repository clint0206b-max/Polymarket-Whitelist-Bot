# Polymarket Watchlist Bot v1

**High-frequency signal generation for Polymarket prediction markets**

A deterministic, spec-driven trading bot that discovers live sports/esports markets via Gamma API, evaluates them through a multi-stage signal pipeline with context-aware gates (ESPN scoreboards), and executes trades via CLOB API.

**Current Status:** Running LIVE with real money ($128.75 balance, commit `540451f`)

---

## Architecture Overview

```
Gamma Discovery (30s) → Watchlist (watching) → Signal Pipeline (2s) → Paper/Live Execution
                                ↓
                         Price Updates (WS+HTTP)
                                ↓
                       ESPN Context Tagging (15s)
                                ↓
                         Stage 1 (base+spread+near)
                                ↓
                         Stage 2 (depth check)
                                ↓
                      Pending Confirmation (6s window)
                                ↓
                       Signal Generation (JSONL)
                                ↓
                    Trade Bridge (paper/shadow_live/live)
                                ↓
                      Resolution Tracker (60s)
```

### Directory Structure

```
polymarket-watchlist-v1/
├── src/
│   ├── config/
│   │   ├── defaults.json          # Default configuration
│   │   └── local.json              # Local overrides (prod settings)
│   ├── core/
│   │   ├── config.js               # Config cascade (defaults → local → shadow → env)
│   │   ├── state_store.js          # Crash-safe persistence (atomic+fsync+backup)
│   │   ├── journal.mjs             # Append-only JSONL for signals/positions
│   │   ├── dirty_tracker.mjs       # Intelligent persistence (immediate vs throttled)
│   │   ├── lockfile.js             # Single-runner lock
│   │   ├── time.js                 # Time utilities
│   │   └── invariants.js           # State consistency checks
│   ├── gamma/
│   │   ├── gamma_client.mjs        # Gamma API discovery (tags: esports, nba, cbb, soccer)
│   │   └── gamma_parser.mjs        # Parse events→markets, detect leagues, ban spreads/totals
│   ├── clob/
│   │   ├── book_http_client.mjs    # /book endpoint fetcher
│   │   ├── book_parser.mjs         # Parse and normalize book data
│   │   └── ws_client.mjs           # WebSocket CLOB price feed (auto-reconnect)
│   ├── context/
│   │   ├── espn_cbb_scoreboard.mjs # NCAA basketball ESPN integration
│   │   ├── espn_nba_scoreboard.mjs # NBA ESPN integration
│   │   └── espn_soccer_scoreboard.mjs # Soccer ESPN integration (multi-league)
│   ├── strategy/
│   │   ├── stage1.mjs               # Base price+spread+near margin filters (pure)
│   │   ├── stage2.mjs               # Depth check (pure)
│   │   ├── win_prob_table.mjs       # Context entry gate (win probability model)
│   │   ├── watchlist_upsert.mjs     # Market insertion/update logic
│   │   ├── ttl_cleanup.mjs          # Expire stale markets
│   │   └── eviction.mjs             # Watchlist size limit (FIFO)
│   ├── runtime/
│   │   ├── loop_gamma.mjs           # Gamma discovery loop (30s)
│   │   ├── loop_eval_http_only.mjs  # Signal pipeline + price updates (2s)
│   │   ├── loop_resolution_tracker.mjs # Paper position resolution (60s)
│   │   ├── universe.mjs             # Universe selection (centralized, tested)
│   │   ├── health_server.mjs        # HTTP monitoring endpoint (:3210)
│   │   ├── http_queue.mjs           # Concurrent HTTP queue (max 5)
│   │   └── dashboard.html           # Visual dashboard (auto-refresh 5s)
│   ├── execution/
│   │   ├── trade_bridge.mjs         # Execution layer (paper/shadow_live/live)
│   │   └── order_executor.mjs       # CLOB client wrapper (buy/sell/balance)
│   ├── metrics/
│   │   ├── daily_events.mjs         # Per-league funnel tracking
│   │   └── daily_snapshot.mjs       # Daily state snapshots (5min)
│   └── tools/
│       └── journal_stats.mjs        # Paper position analysis CLI
├── tests/                           # 437 tests (all passing)
│   ├── universe_selection.test.mjs  # Universe logic invariants
│   ├── persistence.test.mjs         # Crash-safe write verification
│   ├── health_server.test.mjs       # Monitoring endpoint
│   ├── purge_gates.test.mjs         # Stale market detection
│   ├── complementary_pricing.test.mjs # Binary market pricing
│   └── ... (18 total test files)
├── state/                           # Runtime state (gitignored)
│   ├── watchlist.json               # Current watchlist (main state)
│   ├── watchlist.json.bak           # Automatic backup (crash recovery)
│   ├── watchlist.lock               # Process lock file
│   ├── config-snapshot.json         # Boot config (reproducibility)
│   ├── execution_state.json         # Trade idempotency tracking
│   ├── journal/
│   │   ├── signals.jsonl            # Append-only signal log (source of truth)
│   │   ├── open_index.json          # Open paper positions index
│   │   └── executions.jsonl         # Real trade execution log
│   ├── snapshots/
│   │   └── YYYY-MM-DD.json          # Daily state snapshots (5min)
│   └── daily_events.json            # Per-league funnel metrics
├── scripts/
│   ├── health-check.sh              # External alerting (threshold-based)
│   ├── shadow-start.sh              # Start shadow runner
│   ├── shadow-stop.sh               # Stop shadow runner
│   ├── shadow-list.sh               # List active shadow runners
│   └── shadow-compare.sh            # Compare shadow vs prod metrics
├── docs/                            # Design docs
├── run.mjs                          # Main entry point
├── status.mjs                       # CLI status dashboard
└── package.json
```

---

## Signal Pipeline

The bot operates as a deterministic funnel: markets flow from discovery → watchlist → signal generation → execution.

### Stage Flow

1. **Gamma Discovery (30s cycle)**
   - Fetches live events by tag (esports, nba, ncaa-basketball, soccer)
   - Filters: min $200 vol/24h, ±1 day from now (configurable by league)
   - Bans: spreads, totals, draws, over/under
   - Output: candidate markets → watchlist

2. **Price Updates (2s cycle)**
   - **Universe A**: watching + pending_signal + signaled
   - WebSocket primary, HTTP fallback
   - Complementary pricing: `best_ask = min(yes_ask, 1 - no_bid)`
   - Depth cache (15s TTL, bust on 3¢ price move)

3. **ESPN Context Tagging (15s)**
   - CBB/NBA: fetch scoreboard by date window (market endDateIso ±1 day)
   - Soccer: multi-league support (EPL, UCL, La Liga, Bundesliga, Serie A, +10 more)
   - Match market → live game → derive context (period, score, time left)
   - Cache by dateKey (UTC), purge stale entries >2 days old

4. **Stage 1: Base Filters** (watching markets only)
   - Price range: 0.93 ≤ ask ≤ 0.98 (configurable)
   - Max spread: 0.02 (2¢)
   - Near margin: ask ≥ 0.945 OR spread ≤ 0.015
   - Pure functions with EPS tolerance (1e-6)

5. **Stage 2: Depth Check**
   - Entry depth (ask side): ≥ $1,000
   - Exit depth (bid side): ≥ $2,000 above 0.70 floor
   - Iterates levels until threshold met or floor hit

6. **Pending Confirmation (4s window, configurable)**
   - Cooldown: 20s per slug (prevents churning)
   - Timeout tracking: records entry price + bid at timeout
   - Counterfactual analysis: "would we have won?" (filter effectiveness)

7. **Signal Generation**
   - Promoted after confirmation window OR immediate if gate blocking disabled
   - Logs to `signals.jsonl` (append-only, crash-safe)
   - Updates `open_index.json` (open paper positions)
   - Includes context snapshot (win probability, margin, time left)

8. **Trade Execution** (if mode != paper)
   - Idempotent by signal_id
   - Guards: max $10/trade, $50 total exposure, 5 concurrent, 50/day
   - SL at 0.70 with escalating floor (5 attempts: -0.00, -0.01, -0.02, -0.03, -0.05)
   - Post-fill verification (conditional balance check)
   - Pause fail-closed on SL sell failure
   - **Telegram notifications** on BUY/SELL (via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env vars)

9. **Resolution Tracker (60s)**
   - Polls Gamma /markets by slug
   - Paper SL: closes at 0.70 trigger
   - Resolved detection: official (Gamma closed=true) or terminal (price ≥ 0.995)
   - Price extremes tracking (min/max during position lifetime)
   - Timeout resolution: checks unresolved timeouts against Gamma

---

## Configuration System

**Config Cascade** (precedence: highest to lowest):
1. Environment variables (`WATCHLIST_CONFIG_JSON`)
2. Shadow config override (`state-{SHADOW_ID}/config-override.json`)
3. Local config (`src/config/local.json`)
4. Defaults (`src/config/defaults.json`)

### Key Parameters

**From `defaults.json`:**
```json
{
  "polling": {
    "gamma_discovery_seconds": 60,
    "clob_eval_seconds": 2,
    "watchlist_ttl_minutes": 30,
    "candidate_cooldown_seconds": 20,
    "depth_cache_ttl_seconds": 15,
    "pending_window_seconds": 6,
    "max_watchlist": 200
  },
  "filters": {
    "min_prob": 0.94,
    "max_entry_price": 0.97,
    "max_spread": 0.02,
    "near_prob_min": 0.945,
    "near_spread_max": 0.015,
    "min_exit_depth_usd_bid": 2000,
    "min_entry_depth_usd_ask": 1000,
    "exit_depth_floor_price": 0.70
  },
  "paper": {
    "notional_usd": 10,
    "stop_loss_bid": null,
    "resolution_poll_seconds": 60
  },
  "purge": {
    "stale_book_minutes": 15,
    "stale_quote_incomplete_minutes": 10,
    "stale_tradeability_minutes": 12,
    "expired_ttl_minutes": 30
  },
  "context": {
    "enabled": false,
    "entry_rules": {
      "min_win_prob": 0.90,
      "max_minutes_left": 5,
      "min_margin": 1,
      "gate_mode": "tag_only"
    }
  }
}
```

**From `local.json` (prod overrides):**
```json
{
  "polling": {
    "gamma_discovery_seconds": 30,
    "max_watchlist": 50
  },
  "filters": {
    "min_prob": 0.93,
    "max_entry_price": 0.98
  },
  "context": {
    "enabled": true,
    "entry_rules": {
      "gate_mode": "tag_only",
      "gate_mode_nba": "blocking",
      "gate_mode_cbb": "blocking"
    }
  },
  "paper": {
    "stop_loss_bid": 0.70
  },
  "trading": {
    "mode": "live",
    "credentials_path": "/Users/andres/.openclaw/workspace/.polymarket-credentials.json",
    "funder_address": "0xddb60e6980B311997F75CDA0028080E46fACeBFA",
    "max_position_usd": 10,
    "max_total_exposure_usd": 50,
    "max_concurrent_positions": 5,
    "max_trades_per_day": 50
  }
}
```

---

## State Files

All state lives under `state/` (or `state-{SHADOW_ID}/` for shadows).

### Core State

- **`watchlist.json`**: Main state file (markets, runtime counters, cache)
  - Schema: `{ version, watchlist: {conditionId→market}, runtime: {...} }`
  - Persistence: atomic tmp+rename + fsync + backup rotation
  - Dirty tracking: immediate persist for signals/status changes, throttled (5s) for cosmetic
  - Backup: `.bak` file on every write (crash recovery)

- **`watchlist.lock`**: Process lock (prevents duplicate runners)
  - Contains PID, timestamp, runner_id
  - Checked on boot, cleaned on shutdown

- **`config-snapshot.json`**: Boot config + metadata
  - Reproducibility: commit hash, PID, timestamp, effective config

### Journal (Append-Only)

- **`journal/signals.jsonl`**: Source of truth for paper positions
  - Events: `signal_open`, `signal_close`, `signal_timeout`, `timeout_resolved`
  - Schema v2: includes context snapshot, TP math, esports metadata
  - Never edited, only appended (crash-safe by design)

- **`journal/open_index.json`**: Fast lookup for open positions
  - Rebuilt from signals.jsonl on crash (reconciliation)
  - Fields: slug, ts_open, entry_price, entry_outcome_name, context_entry

- **`journal/executions.jsonl`**: Real trade execution log
  - Events: `trade_executed`, `trade_failed`, `shadow_buy`, `shadow_sell`
  - Includes: orderID, fills, slippage, PnL (real or projected)

### Snapshots

- **`snapshots/YYYY-MM-DD.json`**: Daily state (written every 5min)
  - Metrics: trades, PnL, timeouts, watchlist, rejects, league funnel, loop perf
  - Historical comparison without parsing JSONL

- **`daily_events.json`**: Per-league funnel tracking
  - Capture rate: markets crossed threshold vs entered
  - Missed opportunities with dominant reject reason
  - Purged automatically after 7 days

### Execution State

- **`execution_state.json`**: Trade idempotency + pause state
  - Per signal_id: trade_id, status (queued/sent/filled/failed), fills, orderID
  - Daily trade counter (reset at midnight UTC)
  - Pause flag (fail-closed on SL ladder exhaustion)

---

## How to Run

### Development (paper mode, default)

```bash
npm start                       # Start bot (paper trading)
npm run status                  # CLI dashboard
npm run status:verbose          # Full metrics + top candidates
npm run journal:stats           # Paper position analysis
npm test                        # Run all 437 tests
```

### Paper Mode (signals only, no execution)

```bash
STOP_AFTER_MS=30000 node run.mjs    # Run for 30s then exit
```

State written to `state/` (default).

### Shadow Mode (test changes with isolated state)

```bash
SHADOW_ID=test01 node run.mjs       # Runs with state-test01/ directory
```

Shadow runners:
- **Isolated state**: `state-{SHADOW_ID}/` (separate watchlist, journal, lock)
- **Auto port**: health port = 3211 + hash(SHADOW_ID) % 50 (avoids collisions)
- **Kill switches**: refuses to start if trading enabled or state dir = prod
- **Config override**: reads `state-{SHADOW_ID}/config-override.json` (optional)

Scripts:
```bash
./scripts/shadow-start.sh test01 --maxwl 10    # Start shadow with config override
./scripts/shadow-list.sh                        # List all active shadows
./scripts/shadow-compare.sh test01 prod         # Compare metrics
./scripts/shadow-stop.sh test01                 # Stop shadow runner
```

### Live Mode (real trades, requires credentials)

**Prerequisites:**
1. Create credentials file: `~/.openclaw/workspace/.polymarket-credentials.json`
   ```json
   {
     "privateKey": "0x...",
     "chainId": 137
   }
   ```
2. Set `trading.mode` in `src/config/local.json`:
   ```json
   {
     "trading": {
       "mode": "live",
       "credentials_path": "/Users/andres/.openclaw/workspace/.polymarket-credentials.json",
       "funder_address": "0xddb60e6980B311997F75CDA0028080E46fACeBFA",
       "max_position_usd": 10
     }
   }
   ```

**Boot checklist (ALWAYS before deploy):**
```bash
npm test                                    # All tests passing
node -e "import('./src/runtime/loop_eval_http_only.mjs')"  # Parse check
STOP_AFTER_MS=5000 node run.mjs            # 5s boot test (verify config in logs)
# Only THEN deploy to prod (launchctl load, pm2, etc.)
```

**Transition path:**
1. `paper` (default) → validate signals match expectations (100% WR target)
2. `shadow_live` → dry-run execution (checks balance, builds orders, logs but doesn't send)
3. `live` → real trades

**Safety guards (enforced at boot):**
- NBA/CBB gate mode MUST be `blocking` for non-paper trading
- Stop loss MUST be set (0 < SL < 1)
- Max position MUST be reasonable (0 < x ≤ 1000)
- Credentials file MUST exist

---

## Health Monitoring

### HTTP Endpoint

```bash
curl http://localhost:3210/health | jq
```

Returns JSON with:
- Loop stats (runs, last cycle age, performance histogram)
- Staleness (% signaled markets with stale prices)
- HTTP (success rate, rate limited count)
- Persistence (last write age, write/skip counts)
- Watchlist breakdown (status, league)
- Reject reasons (top 5 + other)
- WebSocket metrics (connection, usage ratio, subscriptions)
- Depth cache (hit rate, size, avg age)
- Trade bridge status (mode, paused, balance, open positions)

**Alerting thresholds** (scripts/health-check.sh):
- HTTP success rate < 98.5%
- Stale signaled markets > 0%
- Rate limited count > 0
- Last write age > 10s
- Last cycle age > 10s

### Visual Dashboard

Open `http://localhost:3210/` in browser:
- Auto-refreshes every 5s
- Color-coded KPIs (green/yellow/red thresholds)
- Live positions table, trades today, reject reasons
- Loop performance histogram
- Timeout analysis (filter effectiveness)

Additional API endpoints:
- `/api/health` — full health JSON
- `/api/trades` — trades today + summary
- `/api/positions` — open paper positions
- `/api/watchlist` — current watchlist snapshot
- `/api/config` — effective config (safe keys only)
- `/api/executions` — real trade execution log + divergence check

---

## Shadow Runners

Shadow runners allow testing changes with isolated state, separate from production.

### Use Cases
- Test config changes (different min_prob, spread, depth)
- Validate new leagues (add soccer tag, monitor signals)
- A/B test strategies (compare capture rate between shadows)
- Dry-run code changes before prod deploy

### Isolation Rules
- **State**: `state-{SHADOW_ID}/` directory (watchlist, journal, snapshots all separate)
- **Lock**: `state-{SHADOW_ID}/watchlist.lock` (prevents shadow-prod lock conflicts)
- **Port**: auto-assigned (3211-3260 range, deterministic from hash)
- **Config**: defaults → local → `state-{SHADOW_ID}/config-override.json` → env
- **Kill switches**:
  - MUST NOT have trading enabled (refuses boot)
  - MUST NOT resolve to prod state dir (path validation)
  - MUST use different port than prod

### Example Workflow

```bash
# Start shadow with smaller watchlist (test scaling)
./scripts/shadow-start.sh scale-test --maxwl 10

# Check status
./scripts/shadow-list.sh
# Output: scale-test | PID 12345 | port 3215 | maxwl=10 | watching=8 pending=0

# Compare metrics after 1h
./scripts/shadow-compare.sh scale-test prod
# Output:
#   scale-test: 8 markets, 2 signals, 25% capture
#   prod:      45 markets, 9 signals, 20% capture
#   → smaller watchlist = higher capture (fewer misses from queue saturation)

# Stop shadow
./scripts/shadow-stop.sh scale-test
```

---

## Trading Modes

### 1. Paper (default)
- Signals logged to `journal/signals.jsonl`
- No real trades, no API credentials needed
- Resolution via Gamma market poll (60s)
- Use for: strategy validation, A/B testing, dry-run new leagues

### 2. Shadow Live
- Builds real orders (checks balance, depth, slippage)
- Logs what WOULD execute to `journal/executions.jsonl`
- Does NOT send orders to CLOB
- Use for: execution layer testing, verify order construction, pre-live validation

### 3. Live
- **Real trades with real money**
- Idempotent execution (no duplicate buys/sells per signal_id)
- Pause fail-closed on SL ladder exhaustion
- Guards: max position, total exposure, concurrent, daily limit, allowlist
- Use for: production trading

**Mode Selection** (src/config/local.json):
```json
{
  "trading": {
    "mode": "paper"  // or "shadow_live" or "live"
  }
}
```

---

## Key Design Decisions

### Why Append-Only JSONL?
- **Crash-safe by design**: appends are atomic, never corrupt existing entries
- **Source of truth**: reconciliation rebuilds open_index from JSONL on crash
- **Audit trail**: complete history of all signals (never deleted)
- **Simple**: no database, no migrations, grep-friendly

### Why Dirty Tracking?
- **Reduced I/O**: 67% fewer writes (10/min vs 30/min)
- **Still durable**: critical changes (signals, status transitions) persist immediately
- **Throttled non-critical**: cosmetic changes (health counters, cache) batched every 5s
- **Crash-safe**: atomic writes with fsync + backup rotation

### Why Fsync?
- **Power-loss safety**: without fsync, atomic rename can succeed but data still in buffer
- **Defense in depth**: fsync file + parent directory = guaranteed durability
- **Negligible latency**: <1ms on SSD, only on persist (not every loop)

### Why WebSocket + HTTP Fallback?
- **Latency**: WS updates are instant (<50ms), HTTP is 300-800ms
- **Reliability**: HTTP fallback when WS disconnects (auto-reconnect in progress)
- **Usage ratio**: 85%+ WS in steady state, HTTP only on misses/stale
- **Depth cache**: reduces HTTP load, 15s TTL with price-move bust logic

### Why 6s Confirmation Window?
- **Anti-flicker**: prevents entering on transient spikes
- **Counterfactual tracking**: timeout resolution measures filter effectiveness
- **Data-driven**: 60%+ of timeouts saved us (filter_saved_us > filter_cost_us)
- **Tunable**: can adjust if data shows different optimal window

### Why Complementary Pricing?
- **Binary markets**: YES price + NO price = 1.00 (always)
- **One-sided books**: YES ask missing → compute from NO bid (1 - no_bid)
- **Arbitrage-free**: `best_ask = min(yes_ask, 1 - no_bid)` is cheapest way to buy YES
- **Bug fix**: previous version only fetched YES, reported wrong prices on one-sided books

### Why Context Entry Gate?
- **Win probability model**: Poisson for soccer, margin-based for basketball
- **Fail-safe default**: tag-only mode (observability without blocking)
- **Blocking mode**: NBA/CBB require ≥90% win prob before entry (live trading guard)
- **Prevents bad entries**: don't buy "team to win" at 95% when losing by 15 with 2 min left

### Why Shadow Runners?
- **Safe experimentation**: test config changes without affecting prod
- **A/B testing**: run multiple configs simultaneously, compare metrics
- **Zero downtime**: validate code changes before prod deploy
- **Rollback safety**: if shadow performs worse, discard and keep prod config

---

## Current Live Parameters

**Effective config** (defaults + local overrides):

```
Polling:
  gamma_discovery_seconds: 30
  clob_eval_seconds: 2
  pending_window_seconds: 4
  max_watchlist: 200

Filters:
  min_prob: 0.93
  max_entry_price: 0.98
  max_spread: 0.04
  near_prob_min: 0.945
  near_spread_max: 0.015
  min_exit_depth_usd_bid: 2000
  min_entry_depth_usd_ask: 500
  exit_depth_floor_price: 0.70

Paper:
  notional_usd: 10
  stop_loss_bid: 0.70

Trading (LIVE):
  mode: live
  max_position_usd: 10
  max_total_exposure_usd: 50
  max_concurrent_positions: 5
  max_trades_per_day: 50

Context (ESPN gates):
  enabled: true
  gate_mode: tag_only (default)
  gate_mode_nba: blocking (required for live)
  gate_mode_cbb: blocking (required for live)
  min_win_prob: 0.90
  max_minutes_left: 5
  min_margin: 1

Purge:
  stale_book_minutes: 15
  stale_quote_incomplete_minutes: 10
  stale_tradeability_minutes: 12
  expired_ttl_minutes: 30
```

---

## Performance Metrics

**Paper Trading (2026-02-16, full day):**
- Trades: 22
- Win rate: 100% (22W/0L)
- PnL: +$12.59
- Verified: 9/9 sampled trades matched Gamma outcomes

**Live Trading (2026-02-17, 6:27 AM):**
- Balance: $128.75
- Mode: live
- Open positions: 0
- Status: monitoring for entry signals

**Loop Performance (steady state):**
- Cycle time: ~1s (with depth cache)
- WS usage: 85%+ (HTTP fallback <15%)
- Depth cache hit rate: ~90%
- State writes: 10/min (throttled, critical immediate)

---

## Testing

**Coverage:** 437 tests across 18 test files (all passing)

**Test Categories:**
- Universe selection (20 tests) — invariants for price updates vs signal pipeline
- Persistence (24 tests) — crash-safe writes, backup rotation, dirty tracking
- Health server (18 tests) — monitoring endpoint, metrics computation
- Complementary pricing (10 tests) — binary market pricing logic
- Purge gates (15 tests) — stale market detection and timeouts
- ESPN context (40+ tests) — scoreboard parsing, team matching, win probability
- Signal pipeline (60+ tests) — stage1, stage2, pending confirmation, timeout tracking
- Resolution tracker (20 tests) — Gamma polling, SL triggers, outcome detection
- Journal consistency (15 tests) — JSONL reconciliation, open_index rebuilding

**Run tests:**
```bash
npm test                                  # All tests
npm test -- --test-name-pattern="purge"  # Specific test file
```

**Test patterns:**
- Pure functions tested with edge cases (EPS tolerance, boundary conditions)
- State mutations tested with before/after snapshots
- Time-dependent logic tested with mocked timestamps
- HTTP/WebSocket tested with mock responses
- Crash recovery tested by corrupting files and verifying fallback

---

## Common Patterns in Codebase

### bumpBucket(kind, key, count)
Rolling 5-minute buckets for health counters (reject reasons, token resolution, etc.).
- Bucket rotation at minute boundary
- Ring buffer (5 buckets)
- Used for: status.mjs verbose metrics, health endpoint trends

### setReject(market, reason, extra)
Primary reject tracking (cumulative + per-cycle).
- Sets `market.last_reject = { reason, ts, ...extra }`
- Increments `health.reject_counts_cumulative[reason]`
- Used for: top reject reasons, debugging why markets don't signal

### Dirty Tracker
```javascript
dirtyTracker.mark("gamma:markets_added:5", false);  // throttled
dirtyTracker.mark("eval:signals_generated:2", true); // critical, immediate persist
if (dirtyTracker.shouldPersist(now, { throttleMs: 5000 })) {
  writeJsonAtomic(STATE_PATH, state);
  dirtyTracker.clear(now);
}
```

### resolvePath(...parts)
Resolves paths relative to correct state directory (prod or shadow).
```javascript
const p = resolvePath("state", "watchlist.json");
// prod:   /Users/andres/.openclaw/workspace/polymarket-watchlist-v1/state/watchlist.json
// shadow: /Users/andres/.openclaw/workspace/polymarket-watchlist-v1/state-test01/watchlist.json
```

### Universe Selection (centralized)
```javascript
const priceUpdateUniverse = selectPriceUpdateUniverse(state, cfg);
// Returns: watching + pending_signal + signaled

const pipelineUniverse = selectPipelineUniverse(state, cfg);
// Returns: watching + pending_signal (NO signaled to prevent re-entry)
```

**Critical invariant:** signaled markets MUST receive price updates (visibility) but MUST NOT re-enter signal pipeline (prevents duplicate entries).

---

## Troubleshooting

### Bot won't start
1. Check lock file: `cat state/watchlist.lock` → kill PID if stale
2. Verify config: `STOP_AFTER_MS=1000 node run.mjs` → check first 50 lines for config dump
3. Run tests: `npm test` → ensure all pass
4. Check parse: `node -e "import('./src/runtime/loop_eval_http_only.mjs')"`

### No signals generated
1. Check watchlist size: `npm run status` → if 0, Gamma discovery failing
2. Check rejects: `npm run status:verbose` → top reject reasons
3. Verify price updates: dashboard → WS connection status, HTTP fallback count
4. Check filters: are min_prob/max_spread too restrictive?

### Stale signaled markets
1. Dashboard → staleness metric (should be 0%)
2. Check WS: `curl http://localhost:3210/api/health | jq .websocket`
3. Verify resolution tracker: last_check_ts should be <120s
4. Manual check: `curl https://gamma-api.polymarket.com/markets?slug=<slug>`

### High loop time (>3s)
1. Check depth cache: hit rate should be >80%
2. Verify HTTP concurrency: default is 5, increase if needed
3. Check watchlist size: >100 markets = more HTTP calls
4. Look at breakdown: `curl http://localhost:3210/api/health | jq .loop.performance.last_breakdown`

### Duplicate signals
1. Verify open_index: `cat state/journal/open_index.json | jq '.open | keys'`
2. Check for slug in cooldown: 20s per slug enforced
3. Review recent signals: `tail -20 state/journal/signals.jsonl`

### Shadow won't start
1. Port conflict: check `SHADOW_ID` hash → port 3211-3260
2. State dir collision: verify `state-{SHADOW_ID}` exists and != "state"
3. Trading enabled: shadow MUST have `trading.enabled = false`
4. Lock conflict: check `state-{SHADOW_ID}/watchlist.lock`

---

## Deployment Checklist

**Before EVERY deploy to production:**

1. ✅ All tests passing: `npm test`
2. ✅ Parse check: `node -e "import('./src/runtime/loop_eval_http_only.mjs')"`
3. ✅ Boot test (5s): `STOP_AFTER_MS=5000 node run.mjs`
   - Verify config in first 50 lines (min_prob, max_spread, trading.mode, etc.)
   - No syntax errors, no immediate crashes
4. ✅ Shadow validation (optional but recommended):
   - Run shadow for 1-2h with new code
   - Compare metrics: `./scripts/shadow-compare.sh test prod`
   - If capture rate / signal quality similar or better → proceed
5. ✅ Commit: `git add -A && git commit -m "..." && git push`
6. ✅ Deploy: restart prod runner (launchctl/pm2/systemd/etc.)
7. ✅ Verify: `npm run status` within 60s → check config matches expectations

**Post-deploy validation (first 5 min):**
- Dashboard shows green KPIs
- WS connected, HTTP success rate >98%
- Signals generating (if markets available)
- No ERROR logs in console

---

## License

Private repository. Not licensed for public use.

---

## Contact

Andres — Product Owner, HQ Rental Software, Mendoza, Argentina

**For questions or issues:** This is a private trading bot. Do not share credentials or state files.
