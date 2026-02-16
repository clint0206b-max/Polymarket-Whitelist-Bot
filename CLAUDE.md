# CLAUDE.md — Polymarket Watchlist Bot v1

> Paper-trading signal generator for Polymarket sports/esports prediction markets.
> **No real orders** — generates paper signals, tracks them to resolution, computes PnL.

## Quick Reference

```
# Bot runs 24/7 via launchd (see Process Management below)
# Manual run for testing:
STOP_AFTER_MS=15000 node run.mjs      # Test run (15s)
STOP_AFTER_MS=0 node run.mjs          # Run indefinitely (manual)
node status.mjs                       # Dashboard (reads state, no side effects)
node --test tests/*.test.mjs          # Run all tests (404 tests)
curl -s http://localhost:3210/health | jq  # Health check
open http://localhost:3210/            # Visual dashboard (auto-refresh 5s)
```

## Process Management (launchd — 24/7)

The bot runs as a macOS launchd service that auto-starts at login and auto-restarts on crash.

**Plist**: `~/Library/LaunchAgents/com.polymarket.watchlist-v1.plist`
**Logs**: `logs/launchd-stdout.log`, `logs/launchd-stderr.log`

```bash
# Check status
launchctl list | grep polymarket

# Stop (for maintenance/deploy)
launchctl unload ~/Library/LaunchAgents/com.polymarket.watchlist-v1.plist

# Start
launchctl load ~/Library/LaunchAgents/com.polymarket.watchlist-v1.plist

# Restart (after code changes)
launchctl unload ~/Library/LaunchAgents/com.polymarket.watchlist-v1.plist && \
  sleep 2 && rm -f state/watchlist.lock && \
  launchctl load ~/Library/LaunchAgents/com.polymarket.watchlist-v1.plist
```

**Behavior:**
- `RunAtLoad: true` — starts at login
- `KeepAlive.SuccessfulExit: false` — restarts on crash (exit code != 0)
- `ThrottleInterval: 10` — waits 10s between restarts (anti-spin)
- `STOP_AFTER_MS=0` — runs indefinitely

## Directory Structure

```
polymarket-watchlist-v1/
├── run.mjs                    # Main loop: gamma → eval → journal → resolution
├── status.mjs                 # Read-only dashboard (prints to stdout)
├── CLAUDE.md                  # THIS FILE — project map
├── TODO-ANALYSIS.md           # Analysis checklist for first signal closes
│
├── src/
│   ├── config/
│   │   ├── defaults.json      # Full config with all defaults
│   │   └── local.json         # Overrides (merged on top of defaults)
│   │
│   ├── core/                  # Utilities (no business logic)
│   │   ├── config.js          # loadConfig() — merges defaults + local
│   │   ├── state_store.js     # readJson / writeJsonAtomic / resolvePath
│   │   ├── journal.mjs        # appendJsonl / loadOpenIndex / saveOpenIndex / addOpen / removeOpen
│   │   ├── lockfile.js        # acquireLock / releaseLock (PID-based)
│   │   ├── invariants.js      # checkAndFixInvariants (state self-healing)
│   │   ├── time.js            # nowMs / sleepMs
│   │   └── dirty_tracker.mjs # Dirty tracking for intelligent persistence (skip writes when no changes)
│   │
│   ├── gamma/                 # Gamma API (market discovery)
│   │   ├── gamma_client.mjs   # fetchLiveEvents(tag, cfg) → raw JSON
│   │   └── gamma_parser.mjs   # parseEventsToMarkets(tag, events, cfg) → market candidates
│   │                          #   Filters: spread/total slugs, vol24h, per-league market selection
│   │
│   ├── clob/                  # CLOB API (order book data)
│   │   ├── book_http_client.mjs  # getBook(tokenId, cfg) → raw book
│   │   ├── book_parser.mjs       # parseAndNormalizeBook(raw) → { bids[], asks[], bestBid, bestAsk }
│   │   └── ws_client.mjs         # WebSocket client (real-time price feed, singleton)
│   │
│   ├── context/               # ESPN live game context
│   │   ├── espn_cbb_scoreboard.mjs  # fetchEspnCbbScoreboardForDate / deriveCbbContextForMarket
│   │   └── espn_nba_scoreboard.mjs  # fetchEspnNbaScoreboardForDate / deriveNbaContextForMarket
│   │                                # Context: { state, period, minutes_left, margin, teams, scores }
│   │
│   ├── runtime/               # Main loops
│   │   ├── loop_gamma.mjs     # Phase 1: Gamma discovery → watchlist upsert/evict/ttl
│   │   ├── loop_eval_http_only.mjs  # Phase 2: CLOB eval pipeline (THE BIG FILE — 2200 lines)
│   │   │                            # WS primary → HTTP fallback → stage1 → near → depth → pending → signal
│   │   │                            # Also: ESPN context, purge gates, TTL cleanup, opportunity classification
│   │   ├── loop_resolution_tracker.mjs  # Closes paper signals via Gamma polling
│   │   ├── health_server.mjs  # HTTP health endpoint + HTML dashboard (port 3210)
│   │   ├── universe.mjs       # Centralized universe selection (which markets to evaluate)
│   │   └── http_queue.mjs     # Rate-limited HTTP queue (concurrency + queue size limits)
│   │
│   ├── strategy/              # Pure strategy functions
│   │   ├── stage1.mjs         # is_base_signal_candidate (price range + spread check)
│   │   ├── stage2.mjs         # compute_depth_metrics / is_depth_sufficient (order book depth)
│   │   ├── win_prob_table.mjs # estimateWinProb (normal CDF) + checkContextEntryGate
│   │   ├── watchlist_upsert.mjs  # upsertMarket — merges Gamma data into watchlist entry
│   │   ├── eviction.mjs       # evictIfNeeded — drops lowest-priority when at max_watchlist
│   │   ├── ttl_cleanup.mjs    # markExpired — TTL-based cleanup of stale markets
│   │   └── purge_gates.mjs   # Intelligent purge rules (stale book, incomplete quote, tradeability)
│   │
│   ├── metrics/
│   │   └── daily_events.mjs   # Daily event utilization tracker (per-league per-day watermarks)
│   │
│   └── tools/
│       └── journal_stats.mjs  # (Placeholder — not yet implemented, waiting for closed signals)
│
├── tools/
│   └── esports-monitor.mjs    # Standalone esports book monitor
│
├── tests/                            # 404 tests total (node --test tests/*.test.mjs)
│   ├── ws_client.test.mjs            # 12 tests — WS client, cache, reconnect, shutdown
│   ├── health_server.test.mjs        # 18 tests — health endpoint, dashboard, metrics
│   ├── universe_selection.test.mjs   # 20 tests — centralized universe selection
│   ├── persistence.test.mjs          # 24 tests — crash-safe persistence, dirty tracking
│   ├── purge_gates.test.mjs          # 25 tests — intelligent purge rules
│   ├── ttl_purge.test.mjs            # 14 tests — expired market TTL cleanup
│   ├── signaled_price_update.test.mjs # 12 tests — signaled markets price refresh
│   ├── win_prob_table.test.mjs       # 31 tests — win prob model + entry gate
│   ├── resolution_tracker.test.mjs   # 26 tests — detectResolved + computePnl
│   └── ... (+ strategy, context, invariants, etc.)
│
├── state/                     # Runtime state (gitignored)
│   ├── watchlist.json         # Main state: { version, watchlist, runtime, polling, filters, events_index }
│   ├── daily_events.json      # Daily event utilization (keyed by date → league → event_id)
│   ├── journal/
│   │   ├── signals.jsonl      # Append-only: signal_open + signal_close entries
│   │   ├── open_index.json    # { open: { id: {...} }, closed: { id: {...} } }
│   │   └── context_snapshots.jsonl  # Win prob snapshots for ALL price levels (0.80-0.98)
│   ├── watchlist.lock         # PID-based lock (prevents concurrent runs)
│   └── runner.pid             # PID of nohup background process
│
└── docs/
    ├── IMPLEMENTATION-PLAN.md
    └── WATCHLIST-SPEC.md
```

## Data Flow (Pipeline)

```
┌─────────────────────────────────────────────────────────────────────┐
│ run.mjs main loop (every 2s)                                        │
│                                                                     │
│  Phase 1: Gamma Discovery (every 30s)                               │
│  ┌──────────────────────────────────────┐                           │
│  │ gamma_client → gamma_parser          │                           │
│  │ → watchlist_upsert → eviction/ttl    │                           │
│  │ Result: state.watchlist updated      │                           │
│  └──────────────────────────────────────┘                           │
│                                                                     │
│  Phase 2: Eval Loop (every 2s)                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ For each market (max 20/cycle):                              │   │
│  │                                                              │   │
│  │  Token Resolve (if yes_token_id unknown)                     │   │
│  │  → getBook(tokenA) + getBook(tokenB)                         │   │
│  │  → compare to determine yes/no token                         │   │
│  │                                                              │   │
│  │  Price Fetch (WS primary, HTTP fallback)                     │   │
│  │  → WS: real-time via wss://ws-subscriptions-clob.polymarket  │   │
│  │  → HTTP fallback: if WS cache stale (>10s) or missing        │   │
│  │  → Complementary pricing: min(yes_ask, 1-no_bid)            │   │
│  │                                                              │   │
│  │  Stage 1: is_base_signal_candidate                           │   │
│  │  → ask ∈ [0.93, 0.98]? spread ≤ 0.02?                       │   │
│  │                                                              │   │
│  │  Near Margin: is_near_signal_margin                          │   │
│  │  → ask ≥ 0.945 OR spread ≤ 0.015?                           │   │
│  │                                                              │   │
│  │  Stage 2: is_depth_sufficient                                │   │
│  │  → exit depth ≥ $2000? entry depth ≥ $1000?                  │   │
│  │                                                              │   │
│  │  TP Math: tp_math_margin ≥ min_profit_per_share?             │   │
│  │                                                              │   │
│  │  State machine: watching → pending_signal → signaled         │   │
│  │  (pending_window_seconds = 6s confirmation)                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ESPN Context (CBB/NBA, every 15s)                                  │
│  ┌──────────────────────────────────────┐                           │
│  │ Fetch scoreboard → derive per-market │                           │
│  │ context: state, period, minutes_left │                           │
│  │ margin, teams, scores               │                           │
│  │                                      │                           │
│  │ Win Prob: estimateWinProb()          │                           │
│  │ Entry Gate: checkContextEntryGate()  │                           │
│  │ (tag-only, does NOT block signals)   │                           │
│  └──────────────────────────────────────┘                           │
│                                                                     │
│  Journal: new signals → signals.jsonl + open_index.json             │
│                                                                     │
│  Resolution Tracker (every 60s)                                     │
│  ┌──────────────────────────────────────┐                           │
│  │ For each open signal:                │                           │
│  │ → fetch Gamma by slug               │                           │
│  │ → detectResolved:                    │                           │
│  │   official (closed=true, px≥0.99)    │                           │
│  │   terminal_price (px≥0.995)          │                           │
│  │ → compute PnL → signal_close         │                           │
│  └──────────────────────────────────────┘                           │
│                                                                     │
│  Metrics: opportunity classification + daily_events                 │
└─────────────────────────────────────────────────────────────────────┘
```

## Market State Machine

```
watching → pending_signal → signaled
    │           │
    │           └── (timeout after 6s) → watching + cooldown
    │
    └── (cooldown_active) → skip eval until cooldown expires
```

- **watching**: default state, evaluating every cycle
- **pending_signal**: passed all filters, waiting 6s confirmation
- **signaled**: confirmed signal, written to journal, enters cooldown

## Config

Two files merged: `defaults.json` (committed) + `local.json` (overrides, committed).

**Active overrides (local.json):**
| Key | Default | Local | Effect |
|-----|---------|-------|--------|
| `filters.min_prob` | 0.94 | **0.93** | Lower entry floor |
| `filters.max_entry_price` | 0.97 | **0.98** | Higher entry ceiling |
| `polling.gamma_discovery_seconds` | 60 | **30** | Faster discovery |
| `polling.max_watchlist` | 200 | **50** | Smaller watchlist |
| `context.enabled` | false | **true** | ESPN context active |

**Key config sections:**
- `polling.*` — timing, rate limits, concurrency
- `filters.*` — Stage 1/2 thresholds (min_prob, max_spread, depth)
- `gamma.*` — Gamma API settings, tags, vol filters
- `tp.*` — Take-profit math (bid_target=0.998, min_profit=0.002)
- `context.*` — ESPN integration + entry rules (tag-only)
- `paper.*` — Paper trading (notional=$10, resolution_poll=60s)
- `esports.*` — Series guard threshold

## Glossary

| Term | Meaning |
|------|---------|
| **Stage 1** | Price range check: ask ∈ [min_prob, max_entry_price] + spread ≤ max_spread |
| **Stage 2** | Order book depth check: bid-side ≥ $2000, ask-side ≥ $1000 |
| **near_margin** | Tighter filter: ask ≥ 0.945 OR spread ≤ 0.015. Required after Stage 1 |
| **near_by** | How near_margin passed: "ask", "spread", or "both" |
| **tp_math** | Take-profit math: can we exit at 0.998 bid with ≥0.002 profit after spread? |
| **pending_signal** | Market passed all filters, in 6s confirmation window |
| **signaled** | Confirmed paper signal, written to journal |
| **cooldown** | After signal/timeout, market is blocked from re-entering pending for N seconds |
| **token resolve** | Determining which CLOB token is "Yes" vs "No" (by comparing book prices) |
| **win_prob** | Local win probability estimate from ESPN score + time (normal CDF model) |
| **entry_gate** | Context-based entry filter: final period, ≤5min, margin≥1, win_prob≥0.90. Tag-only |
| **ev_edge** | win_prob - ask_price. Positive = our model thinks market underprices the team |
| **terminal_price** | Gamma outcomePrices ≥0.995 on one side — game effectively decided |
| **opportunity classification** | Per-league market health: two-sided, one-sided, spread, tradeable counts |
| **daily_events** | Per-day per-league event utilization: total events, quote/tradeable/signal counts |

## Strategy Hierarchy (v1)

Agreed strategy — market price is primary, win_prob is confirmation:

1. **ask ∈ [0.93, 0.98]** — market says high probability (primary signal)
2. **spread ≤ 0.02 + depth passes** — liquid and executable
3. **tp_math_allowed** — economic filter (margin to TP at 0.998)
4. **Near margin** — ask ≥ 0.945 OR spread ≤ 0.015
5. **6s pending confirmation** — not a single-tick fluke
6. **win_prob ≥ 0.90** (tag-only) — ESPN sanity check, doesn't block

## Leagues

| League | Gamma tag | Markets/event | Context | Notes |
|--------|-----------|---------------|---------|-------|
| CBB | ncaa-basketball | 1 (main) | ESPN CBB | Only fetches events within ±7 days |
| NBA | nba | 1 (main) | ESPN NBA | Same window, All-Star has no clock data |
| Esports | esports | Up to 6 (game/map sub-markets) | None | Series guard for BO3/BO5 |
| Soccer | soccer | 2 per event (team A wins, team B wins) | ESPN Soccer | 11 leagues, Poisson model, gate BLOQUEANTE |

## Signal Journal Schema (v2)

**signal_open:**
```json
{
  "type": "signal_open",
  "schema_version": 2,
  "build_commit": "a798f34",
  "signal_id": "1771195263179|lol-c9-fly-2026-02-15",
  "ts_open": 1771195263179,
  "slug": "lol-c9-fly-2026-02-15",
  "league": "esports",
  "entry_price": 0.96,
  "spread": 0.01,
  "entry_outcome_name": "Cloud9",
  "tp_math_allowed": true,
  "tp_math_margin": 0.028,
  "ctx": { "entry_gate": { "win_prob": 0.95, "ev_edge": -0.01, "entry_allowed": true } }
}
```

**signal_close:**
```json
{
  "type": "signal_close",
  "signal_id": "...",
  "ts_close": 1771200000000,
  "close_reason": "resolved",
  "resolve_method": "terminal_price",
  "resolved_outcome_name": "Cloud9",
  "win": true,
  "pnl_usd": 0.42,
  "roi": 0.042
}
```

## Status Dashboard Sections

`node status.mjs` outputs (in order):
1. **Config summary** — active filters, polling intervals
2. **Watchlist** — market count by league, by status
3. **Hot candidates** — markets close to signaling
4. **Opportunity classification** — CBB/NBA/Esports market health
5. **Context Entry Gate** — win_prob evaluated/allowed/blocked
6. **Paper Positions** — open/closed/W-L/PnL/resolution tracker health
7. **Daily Event Utilization** — events per league, utilization %, miss reasons
8. **Funnel by League** — rolling 5min: eval→quote→base→spread→depth→pending→signaled

## Git Workflow

```bash
# After every change:
git add -A
git commit -m "type: description"  # feat/fix/test/metrics/tune/chore/docs
git push
```

- **All tests must pass before commit**
- **One change per commit** with descriptive message
- **Never modify bot parameters without explicit approval from Andres**

## Common Tasks

| Task | How |
|------|-----|
| Check bot alive | `launchctl list \| grep polymarket` or `curl -s http://localhost:3210/health \| jq .status` |
| View dashboard | `open http://localhost:3210/` |
| View health JSON | `curl -s http://localhost:3210/health \| jq` |
| View status | `node status.mjs` |
| View signals | `cat state/journal/signals.jsonl \| jq` |
| Run tests | `node --test tests/*.test.mjs` |
| Start bot (launchd) | `launchctl load ~/Library/LaunchAgents/com.polymarket.watchlist-v1.plist` |
| Stop bot (launchd) | `launchctl unload ~/Library/LaunchAgents/com.polymarket.watchlist-v1.plist` |
| Restart bot | See "Process Management" section above |
| Test run (15s) | `STOP_AFTER_MS=15000 node run.mjs` |
| Check Gamma market | `curl -s "https://gamma-api.polymarket.com/markets?slug=SLUG" \| jq '.[0]'` |
| Check WS ratio | `curl -s http://localhost:3210/health \| jq .websocket.usage` |
| Check loop perf | `curl -s http://localhost:3210/health \| jq .loop.performance` |

## Known Issues / Gotchas

- **loop_eval_http_only.mjs is ~2200 lines** — the monolith. Most changes happen here.
- **Gamma `closed` flag can lag** — markets show terminal prices (0.9995) but `closed: false` for hours. Resolution tracker handles this with `terminal_price` method (≥0.995).
- **ESPN All-Star game** has no clock/period data → win_prob returns null → entry_gate blocks as `no_context`.
- **Esports context** is from Gamma only (no ESPN). Win prob does NOT apply to esports.
- **`state/watchlist.json`** is the single source of truth for runtime state. Written only when dirty (dirty tracker + 5s throttle).
- **Lock file** (`state/watchlist.lock`) prevents concurrent runs. If bot dies ungracefully, delete manually (`rm -f state/watchlist.lock`).
- **Mac sleep** will pause launchd service. Bot resumes when machine wakes.
- **WS reconnect** uses exponential backoff (1s → 60s). On intentional shutdown, reconnect is suppressed (`_closing` flag).
- **Health endpoint histogram** is lifetime (not rolling). Counters grow with uptime. Design debt — use `histogram_since_ts` or rolling window for rates.

## WebSocket Integration

**Primary price source** — eliminates most HTTP /book requests.

```
Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
Protocol:
  1. Initial subscribe: { assets_ids: [...], type: "market" }  (once per connection)
  2. Dynamic subscribe: { assets_ids: [...], operation: "subscribe" }  (for new tokens)
Messages received:
  - price_change: { event_type: "price_change", price_changes: [{asset_id, best_bid, best_ask}] }
  - book: { event_type: "book", asset_id, bids: [...], asks: [...] }
  - last_trade_price: fallback if no book data yet
```

**Key design decisions:**
- `type: "market"` (lowercase, not `"MARKET"`)
- ONE initial message per connection, then `operation: "subscribe"` for new assets
- Lazy connect (on first `subscribe()` call, not on import)
- `_closing` flag prevents reconnect loop during shutdown
- WS client is singleton on `state.runtime.wsClient` — excluded from JSON persist
- Stale threshold: `cfg.ws.max_stale_seconds` (default 10)
- Complementary pricing: `bestAsk = min(yes_ask, 1 - no_bid)` when both tokens fresh

**Health metrics** (in `/health` → `.websocket`):
- `ws_ratio_percent`: % of price fetches from WS (target: >95%, typical: 99%+)
- `http_fallback_cache_miss`: WS had no data for token
- `http_fallback_stale`: WS data existed but too old
- `http_fallback_mismatch`: true if cache_miss + stale ≠ total (indicates untracked path)

## Health Monitoring

**Endpoint**: `GET http://localhost:3210/health` → JSON
**Dashboard**: `GET http://localhost:3210/` → auto-refresh HTML

**Key sections in /health response:**
| Section | What it shows |
|---------|--------------|
| `loop.performance` | histogram, slow_loops, very_slow_loops, last_breakdown |
| `websocket.usage` | ws_ratio, cache_miss, stale counts |
| `staleness` | % of signaled markets with stale prices |
| `http` | success rate, rate limited count |
| `persistence` | last write age, write/skip counts |
| `watchlist` | total, by_status, by_league |
| `reject_reasons` | top 5 reject reasons (last cycle) |

**Loop timing breakdown** (logged on slow loops, exposed in health):
```
[SLOW_LOOP] 3548ms | gamma=1932ms eval=1616ms journal=0ms resolution=1ms persist=0ms | markets=32 heapUsed=12MB heapTotal=17MB external=4MB
```

**Thresholds:**
- `>= 3000ms` → `[SLOW_LOOP]` (counter: `slow_loops`)
- `>= 5000ms` → `[VERY_SLOW_LOOP]` (counter: `very_slow_loops`)

## Persistence

**Strategy**: Dirty tracking with fsync + atomic write + backup.
- Only writes when state actually changed (`DirtyTracker`)
- Throttled to max 1 write per 5s (unless critical: new signals)
- `writeJsonAtomic`: tmp file → fsync → rename (crash-safe)
- Size guardrail: warns if state > 1MB

## Purge Gates

**3 rules for removing watching markets** (require double conditions to avoid false purges):
1. Book stale >15min
2. Quote incomplete >10min
3. Tradeability degraded >12min (BOTH spread + depth failing)

**Expired TTL**: Markets with `status=expired` + `resolved_ts` older than 5h are auto-deleted each cycle.

---
## Soccer Integration

**Model**: Poisson (discrete goals, ~0.015 goals/min/team)
**Gate**: BLOQUEANTE (not tag-only like CBB/NBA)

| Rule | Value | Why |
|------|-------|-----|
| Min margin | **2 goals** | 1-goal leads vulnerable to late equalizer |
| Max minutes (margin=2) | **15** | With win_prob ≥ 0.97 threshold |
| Max minutes (margin=3+) | **20** | With win_prob ≥ 0.95 threshold |
| Score change cooldown | **90s** | VAR / goal reversal protection |
| Confidence required | **high** | Only 2nd half, clock 45-90 min |
| Banned slugs | draw, total, spread, btts, over, under | Only team-win markets |
| Period | **must be 2** | Blocks 1st half, halftime, extra time |

**11 ESPN leagues**: eng.1, esp.1, ita.1, fra.1, ger.1, uefa.champions, uefa.europa, mex.1, arg.1, ned.1, por.1

**Matching**: normalized team names + aliases (20+), unique match required, ±6h time window, fail-closed on any ambiguity.

**Key files**:
- `src/strategy/win_prob_table.mjs` — `soccerWinProb()`, `checkSoccerEntryGate()`
- `src/context/espn_soccer_scoreboard.mjs` — adapter, matching, score tracking
- `src/gamma/gamma_parser.mjs` — `isSoccerSlug()`, `isSoccerBannedSlug()`

**Fully integrated into pipeline** — Phases 1-4 complete (commit `855bf26`).
- Soccer gate is BLOQUEANTE in the eval loop (after context snapshot, before Stage 1)
- ESPN cache: per-league, 15s TTL, fail-closed on fetch errors
- Needs live games to generate signals (Sunday night = all post-FT)

## Context Snapshots (win_prob validation)

File: `state/journal/context_snapshots.jsonl`

Captures win_prob + ask/bid for in-game markets at ALL price levels for model calibration:
- **Conditions**: game "in" state, minutes_left ≤ 8, ask ∈ [0.80, 0.98]
- **Throttle**: max 1 snapshot per market per 30 seconds
- **Purpose**: validate win_prob calibration AND detect mispricing at lower ask levels
- **Future analysis**: join with resolution outcomes → "when win_prob said 0.96 and ask was 0.88, did the team win?"

```json
{ "ts": ..., "league": "cbb", "slug": "...", "ask": 0.88, "bid": 0.86, "win_prob": 0.96,
  "ev_edge": 0.08, "margin_for_yes": 12, "minutes_left": 3.5, "period": 2 }
```

*Last updated: 2026-02-16 (commit 3659b6b — WS integration, health monitoring, launchd, loop metrics, audit fixes)*
