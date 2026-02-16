# Complementary Pricing Bug Fix (2026-02-16)

## The Bug

Bot was reporting **inverted prices** for esports markets when the YES token book was one-sided.

**Example**: `cs2-faze-prv-2026-02-16-game1`

**What the bot reported**:
```json
{
  "yes_best_ask": 0.001,   // WRONG (came from NO token bid)
  "yes_best_bid": null,
  "yes_token": "PARIVISION"
}
```

**What CLOB actually showed**:
```bash
# YES token (PARIVISION):
asks: [0.999, 0.998, 0.997]  ← should report this
bids: []

# NO token (FaZe):
bids: [0.001, 0.002, 0.003]  ← bot was reporting this as YES ask
asks: []
```

**Root cause**: Bot only fetched YES token book and used its prices directly, **without considering the complementary NO token book**.

---

## The Fix

Binary markets have complementary pricing: **YES price + NO price = 1.00**

To get the true best prices, we must consider **both books**:

```javascript
// Best ask for YES (cheapest way to buy YES)
yes_best_ask = min(yes_book.asks[0], 1 - no_book.bids[0])

// Best bid for YES (best way to sell YES)
yes_best_bid = max(yes_book.bids[0], 1 - no_book.asks[0])
```

**New logic**:
1. Fetch both YES and NO token books
2. Parse both (either can be one-sided or empty)
3. Compute synthetic prices from NO book:
   - `synthetic_ask = 1 - no_book.bids[0]`
   - `synthetic_bid = 1 - no_book.asks[0]`
4. Choose best prices:
   - `best_ask = min(yes_ask, synthetic_ask)` (cheapest)
   - `best_bid = max(yes_bid, synthetic_bid)` (highest)

---

## Impact

**Did this affect real trades?**
- ❌ **No** — esports markets with inverted prices were at terminal levels (99.95%)
- ✅ Bot correctly **rejected them** (outside entry range [0.94, 0.97])
- ⚠️ **If** bot had seen 0.94-0.97 esports with one-sided books, prices would have been wrong

**Markets affected**: Any esports market where:
- YES token book was one-sided (only asks OR only bids)
- NO token book had complementary liquidity

---

## Tests

**New test suite**: `tests/complementary_pricing.test.mjs` (10 tests)

**Coverage**:
- ✅ YES book empty, NO book has bids → synthetic ask
- ✅ YES book has bid, NO book has ask → synthetic bid
- ✅ Both books have liquidity → choose best prices
- ✅ Terminal market (99.95%) → synthetic matches
- ✅ Only YES book exists → use YES only
- ✅ Only NO book exists → use synthetic only
- ✅ Neither book exists → both null
- ✅ Synthetic worse than direct → choose direct
- ✅ Complementary math identity (1 - x)

**Test results**: ✅ All 353 tests pass (343 existing + 10 new)

---

## Example (Real Case)

**Before fix**:
```json
{
  "slug": "cs2-faze-prv-2026-02-16-game1",
  "yes_best_ask": 0.001,  // WRONG
  "yes_best_bid": null
}
```

**After fix**:
```json
{
  "slug": "cs2-faze-prv-2026-02-16-game1",
  "yes_best_ask": 0.999,  // CORRECT (min(null, 1-0.001))
  "yes_best_bid": null
}
```

---

## Observability

Added health counters for monitoring synthetic price usage:
- `price_synthetic_ask_used` — count when synthetic ask is chosen over null YES ask
- `price_synthetic_bid_used` — count when synthetic bid is chosen over null YES bid

---

## References

- Commit: [TO BE FILLED]
- Tests: `tests/complementary_pricing.test.mjs`
- Modified: `src/runtime/loop_eval_http_only.mjs` (lines ~1207-1315)
- Issue reported: 2026-02-16 07:18 GMT-3
- Root cause: Missing complementary pricing logic for binary markets
