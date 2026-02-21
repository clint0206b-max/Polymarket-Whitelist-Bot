# kch123 Wallet Analysis

**Wallet:** `0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee`  
**Rank:** #1 by PnL ($10.9M)  
**Analysis Date:** 2026-02-20  
**Trades Analyzed:** 1,000 (last 5,000 requested, API returned 1,000)

---

## Executive Summary

**kch123 is an NHL-specialized, hold-to-resolve trader with massive position sizes.** This wallet does NOT employ a favorites-buyer strategy. Instead, they take balanced positions (avg entry 0.589) and hold virtually every position to resolution, with an extraordinary 199:1 buy/sell ratio.

---

## Sport Breakdown

| Sport | Trades | % of Total |
|-------|--------|------------|
| **NHL** | 800 | **80.0%** |
| NFL | 130 | 13.0% |
| CBB | 33 | 3.3% |
| NBA | 18 | 1.8% |
| Other | 19 | 1.9% |

**Key Finding:** Heavily specialized in NHL (4 out of 5 trades). Also active in NFL during season.

---

## Most Traded Markets (Top 10)

1. `nfl-la-chi-2026-01-1` — 41 trades
2. `nfl-sea-ne-2026-02-0` — 31 trades
3. `nfl-hou-ne-2026-01-1` — 27 trades
4. `nhl-bos-nyr-2026-01-` — 24 trades
5. `nfl-la-sea-2026-01-2` — 18 trades
6. `nhl-car-nyr-2026-02-` — 16 trades
7. `nhl-det-utah-2026-02` — 16 trades
8. `nhl-bos-fla-2026-02-` — 16 trades
9. `nhl-edm-cal-2026-02-` — 15 trades
10. `nhl-wsh-van-2026-01-` — 15 trades

**Pattern:** Heavy re-entry and scaling into specific games. Not one-and-done.

---

## Entry Price Analysis

- **Total BUY trades:** 995
- **Total SELL trades:** 5
- **Buy/Sell Ratio:** 199:1

### Entry Price Distribution (BUY trades)

- **Average entry price:** 0.589
- **Entries ≥ 0.80 (favorites):** 235/995 (24%)
- **Entries < 0.80:** 760/995 (76%)

**Key Finding:** This is NOT a favorites-buyer strategy. Average entry of 0.589 indicates balanced/value hunting. Only 24% of entries are at 0.80+, which is well below what a favorites-focused strategy would show (typically 70%+).

---

## Hold-to-Resolve Behavior

- **Markets with BUY only (no sells):** 200/205 (98%)
- **Markets with SELL (early exit):** 5/205 (2%)

**Key Finding:** Extreme hold-to-resolve behavior. Almost never exits early. This trader is betting on outcomes and waiting for resolution, not trading price action.

---

## Position Sizing

- **Average position size:** $6,534.62
- **Median position size:** $371.42
- **Max position size:** $729,628.77

**Key Finding:** Massive position sizes with significant scaling. The median of $371 vs average of $6,534 indicates they scale heavily into high-conviction trades. The $729k max position shows willingness to deploy enormous capital.

---

## Strategy Classification

### Is this a favorites-buyer strategy?

**NO.** Key differences:

| Metric | kch123 | Typical Favorites Buyer |
|--------|--------|-------------------------|
| Avg entry price | 0.589 | 0.75-0.85 |
| % entries ≥ 0.80 | 24% | 70-90% |
| Hold to resolve | 98% | 90%+ |
| Position scaling | Heavy | Moderate |

### Actual Strategy Profile

**NHL Hold-to-Resolve Specialist with Balanced Entry Prices**

- **Sport focus:** 80% NHL, seasonal NFL
- **Entry style:** Value-hunting (0.589 avg) with some favorites (24% at 0.80+)
- **Exit style:** Hold to resolve (98% never sell)
- **Position management:** Aggressive scaling on conviction (avg $6.5k, max $729k)
- **Trade frequency:** High re-entry into same games (up to 41 trades per market)

### Similarity to Our Watchlist Strategy

**Moderate similarity:**

✅ Both hold to resolve (not price trading)  
✅ Both take balanced positions (not pure favorites)  
❌ kch123 specializes heavily in NHL (we're multi-sport)  
❌ kch123 uses massive position sizes (we're more conservative)  
❌ kch123 re-enters the same game many times (we typically one-shot or light scaling)

---

## Actionable Insights

1. **NHL markets have liquidity for large positions** — this trader regularly deploys $10k-$700k per game
2. **Hold-to-resolve works at scale** — 98% hold rate with $10.9M PnL validates the approach
3. **Balanced entry prices (0.589 avg) can be profitable** — don't need to only buy favorites
4. **Heavy scaling into conviction trades** — their max position is 1,966x their median
5. **Re-entry strategy** — they trade the same game up to 41 times (likely ladder scaling)

---

## Data Source

- **API:** `https://data-api.polymarket.com/trades?user=0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee&limit=5000`
- **Trades returned:** 1,000 (API may cap at 1,000 despite 5,000 limit)
- **Date range:** Most recent 1,000 trades (appears to be Jan-Feb 2026 based on slugs)
