# CLAUDE.md — Polymarket Watchlist Bot v1

> Paper-trading signal generator for Polymarket sports/esports prediction markets.
> **No real orders** — generates paper signals, tracks them to resolution, computes PnL.

## Quick Reference

```
node run.mjs                          # Run bot (default 60s, or set STOP_AFTER_MS)
STOP_AFTER_MS=999999999999 node run.mjs  # Run indefinitely
node status.mjs                       # Dashboard (reads state, no side effects)
node --test tests/*.test.mjs          # Run all tests
```

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
│   │   └── time.js            # nowMs / sleepMs
│   │
│   ├── gamma/                 # Gamma API (market discovery)
│   │   ├── gamma_client.mjs   # fetchLiveEvents(tag, cfg) → raw JSON
│   │   └── gamma_parser.mjs   # parseEventsToMarkets(tag, events, cfg) → market candidates
│   │                          #   Filters: spread/total slugs, vol24h, per-league market selection
│   │
│   ├── clob/                  # CLOB API (order book data)
│   │   ├── book_http_client.mjs  # getBook(tokenId, cfg) → raw book
│   │   └── book_parser.mjs       # parseAndNormalizeBook(raw) → { bids[], asks[], bestBid, bestAsk }
│   │
│   ├── context/               # ESPN live game context
│   │   ├── espn_cbb_scoreboard.mjs  # fetchEspnCbbScoreboardForDate / deriveCbbContextForMarket
│   │   └── espn_nba_scoreboard.mjs  # fetchEspnNbaScoreboardForDate / deriveNbaContextForMarket
│   │                                # Context: { state, period, minutes_left, margin, teams, scores }
│   │
│   ├── runtime/               # Main loops
│   │   ├── loop_gamma.mjs     # Phase 1: Gamma discovery → watchlist upsert/evict/ttl
│   │   ├── loop_eval_http_only.mjs  # Phase 2: CLOB eval pipeline (THE BIG FILE — 1700 lines)
│   │   │                            # Token resolve → book fetch → stage1 → near → depth → pending → signal
│   │   │                            # Also: ESPN context fetch, win_prob, opportunity classification, daily events
│   │   ├── loop_resolution_tracker.mjs  # Closes paper signals via Gamma polling
│   │   └── http_queue.mjs     # Rate-limited HTTP queue (concurrency + queue size limits)
│   │
│   ├── strategy/              # Pure strategy functions
│   │   ├── stage1.mjs         # is_base_signal_candidate (price range + spread check)
│   │   ├── stage2.mjs         # compute_depth_metrics / is_depth_sufficient (order book depth)
│   │   ├── win_prob_table.mjs # estimateWinProb (normal CDF) + checkContextEntryGate
│   │   ├── watchlist_upsert.mjs  # upsertMarket — merges Gamma data into watchlist entry
│   │   ├── eviction.mjs       # evictIfNeeded — drops lowest-priority when at max_watchlist
│   │   └── ttl_cleanup.mjs    # markExpired — TTL-based cleanup of stale markets
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
├── tests/
│   ├── win_prob_table.test.mjs       # 31 tests — win prob model + entry gate
│   └── resolution_tracker.test.mjs   # 26 tests — detectResolved + computePnl
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
│  │  Book Fetch (HTTP /book endpoint)                            │   │
│  │  → parseAndNormalizeBook → bestAsk, bestBid, spread          │   │
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
| Check bot alive | `kill -0 $(cat state/runner.pid)` |
| View status | `node status.mjs` |
| View signals | `cat state/journal/signals.jsonl \| jq` |
| Run tests | `node --test tests/*.test.mjs` |
| Start bot background | `nohup env STOP_AFTER_MS=999999999999 node run.mjs > state/runner-nohup.log 2>&1 &` |
| Stop bot | `kill $(cat state/runner.pid)` |
| Test run (30s) | `STOP_AFTER_MS=30000 node run.mjs` |
| Check Gamma market | `curl -s "https://gamma-api.polymarket.com/markets?slug=SLUG" \| jq '.[0]'` |

## Known Issues / Gotchas

- **loop_eval_http_only.mjs is 1700 lines** — the monolith. Most changes happen here.
- **Gamma `closed` flag can lag** — markets show terminal prices (0.9995) but `closed: false` for hours. Resolution tracker handles this with `terminal_price` method (≥0.995).
- **ESPN All-Star game** has no clock/period data → win_prob returns null → entry_gate blocks as `no_context`.
- **Esports context** is from Gamma only (no ESPN). Win prob does NOT apply to esports.
- **`state/watchlist.json`** is the single source of truth for runtime state. ~50KB, written every ~4s.
- **Lock file** (`state/watchlist.lock`) prevents concurrent runs. If bot dies ungracefully, delete manually.
- **Mac sleep** will kill the nohup process. No watchdog/restart mechanism yet.

---
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

*Last updated: 2026-02-15 (commit 583af5e+)*
