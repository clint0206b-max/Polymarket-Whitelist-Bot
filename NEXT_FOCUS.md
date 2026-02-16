# NEXT_FOCUS.md - Priority Queue for Watchlist v1

## Active Focus

None — all High ROI items complete.

## High ROI ✅ COMPLETE

- ✅ **Watchlist state persistence**: Crash-safe persistence with fsync + backup (commit 529e89f)
- ✅ **Graceful shutdown**: Shutdown handler always persists final state (commit 529e89f)
- ✅ **Health monitoring**: HTTP endpoint + alerting script (commit TBD)

## Medium ROI

- **Dashboard improvements**:
  - Show last price update timestamp for each market
  - Add "time in status" for pending markets
  - Show reject reason distribution (pie chart)
  - Add league breakdown (esports/NBA/CBB/soccer)
  - Integrate health metrics (reuse `buildHealthResponse()` from health_server.mjs)

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

### Health Monitoring (2026-02-16)

**HTTP endpoint for external observability:**
- Endpoint: `GET http://localhost:3210/health`
- No authentication (local-only, binds to 127.0.0.1)
- No sensitive data (no watchlist details, tokens, credentials)
- Response includes: uptime, loop stats, HTTP success rate, staleness, persistence, status counts
- Alerting script: `scripts/health-check.sh` with configurable thresholds
- Tests: `tests/health_server.test.mjs` (14 tests)
- Docs: `HEALTH.md`

**Alert thresholds:**
- HTTP success rate < 98.5%
- Stale signaled markets > 0% for >2min
- Rate limited count > 0
- Last write age > 10s (2x persistence throttle)
- Last cycle age > 10s (loop stalled)

**Usage:**
```bash
# Manual check
curl http://localhost:3210/health | jq

# Monitor script
./scripts/health-check.sh --alert-only || echo "ALERT: Bot unhealthy"
```

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
