# Changelog - Polymarket Watchlist v1

## [Unreleased]

## [1.0.1] - 2026-02-16

### Fixed
- **Signaled markets price freeze** (commit e414f89)
  - **Bug:** Markets with `status=signaled` froze `last_price` at entry time, causing dashboard to show stale prices (up to 64 minutes old in production)
  - **Root cause:** Signal pipeline filter `(m.status === "watching" || m.status === "pending_signal")` excluded signaled markets from price update loop
  - **Impact:** Open positions showed outdated prices, making it impossible to track performance in real-time
  - **Fix:** Separated "price update universe" (watching, pending_signal, signaled) from "signal pipeline universe" (watching, pending_signal only)
  - **Verification:** Duke position now updates every 2s, age <30s
  - **Tests:** 12 new tests in `tests/signaled_price_update.test.mjs`
  - **Spec ref:** WATCHLIST-SPEC.md line 1026-1029 ("update last_price for visibility")
  - **Performance impact:** +2.3% HTTP calls (44 vs 43 markets), negligible

### Added
- Health metric documentation: `docs/HEALTH_METRICS.md`
- Fix analysis: `docs/FIX_SIGNALED_PRICE_UPDATE.md`
- Operational checks: `docs/OPERATIONAL_CHECKS.md`
- Changelog: this file

### Documentation
- Updated `claude.md` with correct working directory
- Established baseline for `percent_stale_signaled` metric (0%)

## [1.0.0] - 2026-02-15

Initial release of paper trading bot with:
- HTTP-only price polling (no WebSocket yet)
- 50 market watchlist (CBB, NBA, esports)
- Conservative filters: [0.93, 0.98] price range
- Win probability model (normal CDF)
- Terminal price resolution (≥0.995)
- Paper position tracking via JSONL journal

### Known Limitations
- No WebSocket support (planned for v1.1)
- No automated trading (paper only)
- Resolution relies on Gamma polling, not real-time events

---

## Protected References (DO NOT MODIFY without review)

These references are critical to the signaled price update fix:

1. **Spec:** `docs/WATCHLIST-SPEC.md` lines 1026-1029
   - Requirement: "update last_price / liquidity for visibility"
   
2. **Test:** `tests/signaled_price_update.test.mjs`
   - Regression detection: verifies signaled markets update price without re-entering pipeline
   
3. **Code:** `src/runtime/loop_eval_http_only.mjs`
   - Functions: `pickPriceUpdateUniverse()`, `pickEvalUniverse()`
   - Pipeline gate: line ~1410 (check `if (!inPipeline) continue`)

**If modifying these files:** Run regression test first, verify with real bot, document in this changelog.
