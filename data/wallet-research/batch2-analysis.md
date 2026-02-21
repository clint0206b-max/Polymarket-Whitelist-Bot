# Polymarket Wallet Analysis - Batch 2

**Generated**: 2026-02-20 19:01:07

**Objective**: Find favorites-buyers who hold to resolution (buy 0.80-0.95, minimal selling)

---


## blackwall (0xac44...afbd7) - $3.97M THIS WEEK

### 1. Sport Breakdown (Top 10)
- **ucl**: 37 trades (39.8%)
- **lal**: 24 trades (25.8%)
- **ere**: 11 trades (11.8%)
- **fl1**: 8 trades (8.6%)
- **elc**: 6 trades (6.5%)
- **bun**: 5 trades (5.4%)
- **epl**: 2 trades (2.2%)

### 2. Buy Price Analysis
- **Average BUY price**: 0.546
- **Average SELL price**: 0.000 (no sells)
- **Favorites buying (>0.80)**: 0.0% of buys (0/93)
- **Underdogs (<0.50)**: 45.2% of buys (42/93)
- **Total BUY trades**: 93
- **Total SELL trades**: 0
- **Buy/Sell ratio**: ∞ (no sells)

### 3. Hold-to-Resolve Analysis
- **Markets traded**: 8
- **Markets with ONLY buys (no sells)**: 8
- **Hold-to-resolve %**: 100.0%

### 4. Position Sizes
- **Median trade value**: $14,992
- **Average trade value**: $55,356
- **Min trade value**: $9
- **Max trade value**: $564,000

### 5. Trading Frequency
- **Total trades**: 93
- **First trade**: 2026-02-08
- **Last trade**: 2026-02-18
- **Days active**: 10
- **Trades per day**: 9.1

### 6. Profile Match Assessment

**Target profile**: Buy sports favorites at 0.80-0.95, hold to resolution

❌ Avg buy price 0.546 - NOT a favorites buyer
✅ **Strong hold-to-resolve** (100.0% of markets held without selling)
❌ Rarely buys favorites (0.0% >0.80)

**MATCH SCORE: 1/3**
⚠️  **PARTIAL MATCH** - Some similarities but key differences


---


## fengdubiying (0x17db...5f6d) - $3.2M PnL

### 1. Sport Breakdown (Top 10)
- **lol**: 274 trades (70.3%)
- **will**: 54 trades (13.8%)
- **nba**: 27 trades (6.9%)
- **fed**: 13 trades (3.3%)
- **bitcoin**: 10 trades (2.6%)
- **ethereum**: 5 trades (1.3%)
- **nhl**: 4 trades (1.0%)
- **atp**: 2 trades (0.5%)
- **ufc**: 1 trades (0.3%)

### 2. Buy Price Analysis
- **Average BUY price**: 0.655
- **Average SELL price**: 0.709 (47 sells)
- **Favorites buying (>0.80)**: 26.8% of buys (92/343)
- **Underdogs (<0.50)**: 21.6% of buys (74/343)
- **Total BUY trades**: 343
- **Total SELL trades**: 47
- **Buy/Sell ratio**: 7.3x

### 3. Hold-to-Resolve Analysis
- **Markets traded**: 117
- **Markets with ONLY buys (no sells)**: 91
- **Hold-to-resolve %**: 77.8%

### 4. Position Sizes
- **Median trade value**: $8,000
- **Average trade value**: $23,423
- **Min trade value**: $7
- **Max trade value**: $500,000

### 5. Trading Frequency
- **Total trades**: 390
- **First trade**: 2025-10-04
- **Last trade**: 2026-01-10
- **Days active**: 98
- **Trades per day**: 4.0

### 6. Profile Match Assessment

**Target profile**: Buy sports favorites at 0.80-0.95, hold to resolution

❌ Avg buy price 0.655 - NOT a favorites buyer
✅ **Strong hold-to-resolve** (77.8% of markets held without selling)
❌ Rarely buys favorites (26.8% >0.80)

**MATCH SCORE: 1/3**
⚠️  **PARTIAL MATCH** - Some similarities but key differences


---

## Summary & Next Steps

### Findings
- ❌ Could not retrieve addresses for **SeriouslySirius** ($3.6M) and **GamblingIsAllYouNeed** ($3.4M)
  - Leaderboard API endpoint returned 404 errors
  - Alternative: Manual lookup on Polymarket website or try different API endpoints

### Analyzed Wallets
- **blackwall**: 100% hold-to-resolve but NOT a favorites buyer (avg 0.546)
- **fengdubiying**: 77.8% hold-to-resolve, only 26.8% favorites buys

### Recommendation
**Neither wallet matches our profile.** Both traders:
- Buy at lower odds (underdogs/value plays) rather than favorites (>0.80)
- Show good hold discipline, but different entry strategy

**Suggested next steps:**
1. Try to find SeriouslySirius and GamblingIsAllYouNeed addresses via web scraping
2. Look for traders in the 0.80-0.95 buy range specifically
3. Consider that high-profit traders may use MIXED strategies (not pure favorites)
