# Analysis Checklist — First Signal Closes

## 1. Validate close integrity (first 3 closed signals)
- [ ] signal_open exists in signals.jsonl
- [ ] signal_close exists in signals.jsonl
- [ ] resolved_outcome makes sense (winner matches game result)
- [ ] pnl and roi not inverted (positive when won, negative when lost)
- [ ] timestamps coherent (ts_close > ts_open)

## 2. First cut (10-20 closes needed)
Per league (CBB first, NBA when available):
- [ ] How many pass win_prob >= 0.90, and how do they perform?
- [ ] How many would pass at win_prob >= 0.85? Performance diff?
- [ ] Average ask band of winners vs losers
- [ ] Top 3 blocked_reason in candidates (is funnel too strict?)

## 3. Token resolver coverage (priority)
- [ ] If no_token_resolved stays high after 1h of regular games:
  - Increase max_token_resolves_per_cycle from 5 → 10
  - Keep per-league quotas (esports:2, nba:2, cbb:2, rest global)
  - Monitor fail_rate — if rises, revert
- [ ] Add resolver speed metrics to status: attempted/success per min, pending total
- [ ] Long-term: prioritize resolving markets in ask band + live over stale ones

## 4. Rules for adjustments
- Change ONE variable at a time (win_prob threshold OR ask band, not both)
- Tag-only first, gate hard only after validation
- Commit each change separately with descriptive message
