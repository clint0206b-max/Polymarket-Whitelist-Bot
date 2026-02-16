# NEXT_FOCUS.md - Priority Queue for Watchlist v1

## Active Focus

None — ready for deployment.

## High ROI (Next Sprint)

- **Watchlist state persistence**: Serialize watchlist state to disk (JSON) on each loop cycle, reload on startup. Prevents losing watchlist on restart. (~1h)
- **Graceful shutdown**: Handle SIGTERM/SIGINT to persist state before exit. (~30m)

## Medium ROI

- **Dashboard improvements**:
  - Show last price update timestamp for each market
  - Add "time in status" for pending markets
  - Show reject reason distribution (pie chart)
  - Add league breakdown (esports/NBA/CBB/soccer)

- **Health monitoring**:
  - Expose health endpoint (HTTP or file-based)
  - Add alerting for fetch failures, rate limits, resolve failures
  - Track "time to signal" histogram (from first seen to signaled)

## Low ROI (Backlog)

- **Token resolver enhancements**:
  - Cache resolved tokens to disk (persist across restarts)
  - Add retry logic with exponential backoff

- **Context improvements**:
  - Add more sports (MLB, NHL, soccer leagues)
  - Improve ESPN matching accuracy (fuzzy matching, aliases)

## Architecture Notes

### Universe Selection (2026-02-16)

**CRITICAL: Universe logic is centralized in `src/runtime/universe.mjs`.**

Do NOT re-implement status gates in loops. Always use:
- `selectPriceUpdateUniverse(state, cfg)` for price/liquidity updates
- `selectPipelineUniverse(state, cfg)` for signal pipeline (stage1/stage2)
- `selectAllActive(state)` for operations on all non-expired markets

**Spec requirement (commit e414f89):**
- `signaled` markets MUST receive price updates (visibility)
- `signaled` markets MUST NOT re-enter signal pipeline (would duplicate entry)

**Tests:** `tests/universe_selection.test.mjs` (20 tests)

If you need to add a new status or change universe rules:
1. Update `src/runtime/universe.mjs`
2. Update `tests/universe_selection.test.mjs` with new invariants
3. Run all tests (`node --test tests/*.test.mjs`)
4. Document the change here

### Status Lifecycle

```
watching → pending_signal → signaled (paper position open)
   ↓           ↓                ↓
expired    expired          (resolved by tracker)
```

### Token Resolution

- Scheduled per-league quotas (infra): esports=2, NBA=1, CBB=1 per cycle
- Fallback to global rank (by vol desc) if quota not met
- Disabled when pending markets exist (scheduling priority)

### Context Tagging

- CBB/NBA: ESPN scoreboard API, cached per dateKey (3-day window)
- Soccer: ESPN multi-league API, cached per leagueId (15s TTL)
- All leagues: tag ALL watching/pending markets (not just eval universe)

### Paper Positions

- Resolution tracker: separate loop (`loop_resolution_tracker.mjs`)
- Polls Gamma by slug, detects terminal prices (≥0.995) or official resolution
- Tracks price extremes (min/max) for offline SL analysis
