# Polymarket watchlist bot — Implementation plan v1

## Objective
Implement the system defined in `WATCHLIST-SPEC.md` incrementally, with milestones that preserve:
- determinism
- observability
- low refactor risk
- stable local execution on Mac M1 (8 GB)

## Principles
- One process, one writer.
- Determinism + state first; WS later; performance + UX after.
- Each phase must be runnable, measurable, and have a clear **done** criteria.

---

## Suggested folder structure

```
polymarket/
  state/
    watchlist.json
    watchlist.lock

  src/
    config/
      defaults.json

    core/
      time.js
      state_store.js
      lockfile.js
      invariants.js
      mutations_contract.js

    gamma/
      gamma_client.js
      gamma_parser.js

    clob/
      book_http_client.js
      ws_client.js
      ws_cache.js

    strategy/
      stage1.js
      stage2.js
      state_machine.js
      reject_mapping.js
      health_metrics.js

    runtime/
      engine.js
      scheduler.js
      http_queue.js
      depth_cache.js

    ui/
      status.mjs

  docs/
    WATCHLIST-SPEC.md
    TODO.md
    IMPLEMENTATION-PLAN.md
```

## Config
- Keep config in JSON with v1 defaults from the spec.
- Allow overrides via env vars or a `local.json`.

---

## Phase 0 — Scaffolding & hygiene
**Goal:** project skeleton and a runnable app with no trading logic.

Includes:
- Node runtime setup
- config load (defaults)
- `state/` and lockfile
- state load/init with base schema
- atomic write (tmp + rename)
- empty loop that updates `runtime.last_run_ts`

**Done when:**
- `node run.mjs` starts, creates lockfile, creates `watchlist.json` if missing, runs 60s without crashing, and cleans lockfile on exit.

---

## Phase 1 — Core engine without WS (Loop A / Gamma)
**Goal:** discovery and watchlist persistence without WS.

Includes:
- Gamma client fetch live events
- parse + select game-bet markets
- vol24h filter (cheap)
- upsert watchlist keyed by conditionId
- TTL cleanup + eviction when > watchlist_max
- apply mutations contract (non-destructive)
- invariants check end-of-cycle

**Done when (with Gamma enabled):**
- watchlist grows and stays `<= 200`
- TTL marks expired correctly
- eviction respects ordering
- state persists atomically
- invariants show no violations in normal operation

---

## Phase 2 — Strategy Stage 1 & Stage 2 using `/book` only (HTTP mode)
**Goal:** validate deterministic pipeline without WS.

Includes:
- `/book` client + parse/validation (truncate + heavily_filtered counter)
- derive quote from `/book` (best bid/ask)
- Stage 1 pure functions (EPS)
- Stage 2 pure functions (depth metrics) + cache TTL (in-memory ok)
- state machine transitions (watching/pending/signaled/timeout)
- reject mapping + health metrics (incl. rate limit)
- rolling 5-min buckets for rejects + health

**Done when (subset e.g. 20 markets):**
- `pending_signal` and `signaled` happen per S04/S05
- rejects happen per S01/S02/S09/S10
- `gray_zone_count` increments per S03
- rolling `last_5min` updates stably
- `signaled` is sticky (no spam)

---

## Phase 3 — HTTP safety, concurrency & backpressure
**Goal:** make HTTP mode safe on laptop (no bursts).

Includes:
- `http_max_concurrency`, `http_queue_max`
- timeouts default 2500ms
- queue drop counter
- optional 429 mitigation
- ensure Stage 2 depth fetch respects concurrency
- ensure Reason A vs B maps rejects correctly

**Done when:**
- forced heavy-candidate conditions never exceed concurrency
- `http_queue_dropped_count` reflects backpressure
- `rate_limited_count` recorded correctly
- main loop does not stall

---

## Phase 4 — WS integration (primary) + unified `/book` fallback
**Goal:** add WS as primary price source while preserving deterministic behavior.

Includes:
- ws_client connect + reconnect
- ws_cache per token_id with local updated_ts
- WS stale (2500ms) + incomplete handling
- Stage 1 uses WS when fresh+usable
- fallback to `/book` when missing/stale/incomplete
- WS/HTTP health metrics
- keep WS vs HTTP comparability in dashboard

**Done when:**
- most quotes come from WS (`ws_fresh_count` high)
- fallback only when it should
- scenarios S08/S09 reproducible (disconnect / staleness)
- signal behavior matches Phase 2 (deterministic logic unchanged)

---

## Phase 5 — Dashboard (`status.mjs`)
**Goal:** implement exact output spec, default + verbose, without logs.

Includes:
- SUMMARY, WATCHLIST, SIGNALS, TOP_REJECTS, HEALTH
- verbose: NEAR_SIGNALS, REJECT_SAMPLES, WS_FRESHNESS
- show last_cycle + last_5min
- samples: 2–3 default, 3–5 verbose

**Done when:**
- `status.mjs` accurately reflects counts, signals, ages, rejects + samples, and health counters.

---

## Phase 6 — Hardening final (invariants + auto-fix)
**Goal:** enforce invariants in runtime, not only in tests.

Includes:
- invariants I1–I12
- auto-fix rules
- integrity counters
- ignored on identity mismatch

**Done when:**
- on simulated JSON corruption: system recovers conservatively
- does not touch trade fields
- does not generate invalid signals
- integrity counters increment

---

## Phase 7 — Deterministic scenario harness (optional but recommended)
**Goal:** convert S01–S10 into an offline harness (no network).

Includes:
- mocks for WS cache and `/book`
- deterministic replay of transitions + counters

**Done when:**
- each scenario produces exactly the expected Then.

---

## Recommended implementation order (summary)
0) scaffolding
1) Gamma discovery + state + TTL + eviction
2) Stage 1 + Stage 2 with `/book` only
3) HTTP concurrency + rate limit hardening
4) WS integration + unified fallback
5) Dashboard
6) Invariants in runtime
7) Scenario harness

## Notes
- Keep each phase mergeable and usable.
- Do not jump to WS or dashboard before validating deterministic pipeline with `/book`.
