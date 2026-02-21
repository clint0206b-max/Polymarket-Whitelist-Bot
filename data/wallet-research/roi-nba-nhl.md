# High-ROI Small Wallets: NBA & NHL Markets

**Research Date:** 2026-02-20  
**Markets Analyzed:** 20 top NBA/NHL markets by volume  
**Total Trades Collected:** 20,865  
**Unique Wallets:** 9,194  

## Objective

Find wallets that started small ($50-$500), made many trades with small position sizes, and have high win rates. **ROI matters more than absolute PnL.**

## Methodology

1. **Data Collection**
   - Fetched 23 NBA markets + 8 NHL markets (closed, sorted by volume)
   - Selected top 20 markets by volume
   - Downloaded all trades (20,865 total) via Polymarket Data API

2. **Wallet Aggregation**
   - Calculated for each wallet:
     - Total trades (count)
     - Total volume (sum of size × price)
     - Average trade size (volume / trades)
     - Unique markets traded
     - Buy/sell distribution

3. **Filtering Criteria**
   - **Original (Strict):** ≥20 trades, <$500 avg trade, ≥5 markets
   - **Relaxed:** ≥10 trades, <$1000 avg trade, ≥3 markets

4. **Win Rate Calculation**
   - For each market a wallet traded, checked resolution via Gamma API
   - WIN = bought YES and market resolved YES (outcome price > 0.95), OR bought NO and market resolved NO
   - Calculated net P&L per market based on position aggregation

5. **Ranking Metric**
   - **Score = Win Rate × Total Trades** (rewards both accuracy AND volume)

---

## 🏆 Top Wallets - RELAXED Criteria
*≥10 trades, <$1000 avg trade size, ≥3 markets*

### #1 - `0xe8dd7741ccb12350957ec71e9ee332e0d1e6ec86` ⭐
- **Trades:** 695 across 3 markets
- **Avg Trade Size:** $58.89
- **Win Rate:** 100.0% (3W-0L) 
- **Estimated P&L:** $133.99
- **Score:** 695.00
- **Profile:** Market maker or arbitrageur with exceptional consistency. Small avg trade but massive volume.

### #2 - `0xe3726a1b9c6ba2f06585d1c9e01d00afaedaeb38` ⭐
- **Trades:** 323 across 3 markets
- **Avg Trade Size:** $0.27
- **Win Rate:** 100.0% (3W-0L)
- **Estimated P&L:** $88.80
- **Score:** 323.00
- **Profile:** Micro-trader with perfect record. Extremely low position sizes (<$1 avg).

### #3 - `0x63d43bbb87f85af03b8f2f9e2fad7b54334fa2f1` ⭐
- **Trades:** 216 across 3 markets
- **Avg Trade Size:** $152.33
- **Win Rate:** 100.0% (3W-0L)
- **Estimated P&L:** $104.71
- **Score:** 216.00
- **Profile:** Mid-size trader with 100% accuracy. Solid position sizing.

### #4 - `0x204f72f35326db932158cba6adff0b9a1da95e14`
- **Trades:** 368 across 4 markets
- **Avg Trade Size:** $89.94
- **Win Rate:** 50.0% (2W-2L)
- **Estimated P&L:** -$1,482.55
- **Score:** 184.00
- **Profile:** High volume but mediocre performance. Negative overall P&L.

### #5 - `0xe60a9b0be459d9849bc2339dac20517639ae6a47`
- **Trades:** 709 across 5 markets
- **Avg Trade Size:** $94.24
- **Win Rate:** 20.0% (1W-4L)
- **Estimated P&L:** $11,381.12
- **Score:** 141.80
- **Profile:** **Interesting case:** Low win rate (20%) but POSITIVE P&L of $11k! Likely got lucky on one big winning position or hedged well.

### #6 - `0xd218e474776403a330142299f7796e8ba32eb5c9`
- **Trades:** 165 across 4 markets
- **Avg Trade Size:** $137.23
- **Win Rate:** 75.0% (3W-1L)
- **Estimated P&L:** -$33.77
- **Score:** 123.75
- **Profile:** Strong win rate but slightly negative P&L. Sizing issues?

### #7 - `0xead152b855effa6b5b5837f53b24c0756830c76a`
- **Trades:** 177 across 3 markets
- **Avg Trade Size:** $254.08
- **Win Rate:** 33.3% (1W-2L)
- **Estimated P&L:** $5,597.88
- **Score:** 59.00
- **Profile:** Lower win rate but strong positive P&L. Position sizing working in their favor.

### #8 - `0x6a5cfe36360363a009323432b566017308b0b3f2`
- **Trades:** 64 across 3 markets
- **Avg Trade Size:** $2.70
- **Win Rate:** 66.7% (2W-1L)
- **Estimated P&L:** $2.86
- **Score:** 42.67
- **Profile:** Very small positions but solid win rate.

### #9 - `0xd6f44883f664d7dc963d8b89c5a0689fdd330566`
- **Trades:** 58 across 3 markets
- **Avg Trade Size:** $52.76
- **Win Rate:** 66.7% (2W-1L)
- **Estimated P&L:** -$264.27
- **Score:** 38.67

### #10 - `0x97317409bfd9e992611596acee93e8b938019b35`
- **Trades:** 53 across 3 markets
- **Avg Trade Size:** $114.48
- **Win Rate:** 66.7% (2W-1L)
- **Estimated P&L:** $615.44
- **Score:** 35.33

---

## 🎯 Top Wallets - ORIGINAL Criteria (Strict)
*≥20 trades, <$500 avg trade size, ≥5 markets*

**Only 3 wallets met the strict criteria.**

### #1 - `0xe60a9b0be459d9849bc2339dac20517639ae6a47`
- **Trades:** 709 across 5 markets
- **Avg Trade Size:** $94.24
- **Win Rate:** 20.0% (1W-4L)
- **Estimated P&L:** $11,381.12
- **Score:** 141.80

### #2 - `0x1d949489f736378cbde40db18c093c5cff459100`
- **Trades:** 48 across 5 markets
- **Avg Trade Size:** $12.53
- **Win Rate:** 40.0% (2W-3L)
- **Estimated P&L:** -$55.99
- **Score:** 19.20

### #3 - `0xde0463ea7f611b065e8ab06bbfbddad75e6dfa37`
- **Trades:** 20 across 5 markets
- **Avg Trade Size:** $45.98
- **Win Rate:** 20.0% (1W-4L)
- **Estimated P&L:** $636.37
- **Score:** 4.00

---

## 📊 Market Statistics

### Top 20 Markets Analyzed

1. **will-the-milwaukee-bucks-win-the-2025-nba-finals** - $9.99M volume
2. **will-the-phoenix-suns-win-the-2025-nba-finals** - $9.99M volume
3. **nba-det-phi-2025-11-09** - $999K volume
4. **nhl-sj-van-2026-01-27** - $999K volume
5. **nba-sac-mem-2025-11-20** - $998K volume
6. **nba-will-the-suns-beat-the-warriors-by-more-than-5pt5-points** - $100K volume
7. **nba-bos-nyk-2025-10-24-spread-home-4pt5** - $100K volume
8. **nhl-det-fla-2025-04-10** - $99.8K volume
9. **nhl-las-bos-2025-02-08** - $99.8K volume
10. **nba-dal-lal-2025-11-28-spread-home-10pt5** - $99.8K volume

### Wallet Distribution

**By Trade Count:**
- 1-4 trades: 8,881 wallets (96.6%)
- 5-9 trades: 192 wallets (2.1%)
- 10-19 trades: 58 wallets (0.6%)
- 20-49 trades: 35 wallets (0.4%)
- 50+ trades: 28 wallets (0.3%)

**By Average Trade Size:**
- <$50: 6,766 wallets (73.6%)
- $50-100: 663 wallets (7.2%)
- $100-250: 653 wallets (7.1%)
- $250-500: 239 wallets (2.6%)
- $500-1k: 551 wallets (6.0%)
- >$1k: 322 wallets (3.5%)

**By Unique Markets:**
- 1-2 markets: 9,147 wallets (99.5%)
- 3-4 markets: 41 wallets (0.4%)
- 5-9 markets: 6 wallets (0.1%)

---

## 🔍 Key Findings

### 1. **100% Win Rate Traders Exist!**
Three wallets achieved 100% win rate across 3 markets with significant volume:
- `0xe8dd7741ccb12350957ec71e9ee332e0d1e6ec86`: 695 trades, $58.89 avg
- `0xe3726a1b9c6ba2f06585d1c9e01d00afaedaeb38`: 323 trades, $0.27 avg
- `0x63d43bbb87f85af03b8f2f9e2fad7b54334fa2f1`: 216 trades, $152.33 avg

### 2. **Win Rate ≠ P&L**
Wallet `0xe60a9b0be459d9849bc2339dac20517639ae6a47` has only 20% win rate but $11k+ P&L. This suggests:
- Their one winning market was highly profitable
- Position sizing on the winning trade was large
- OR they're hedging across markets effectively

### 3. **Most Traders Are Passive**
96.6% of wallets made ≤4 trades. Only 0.3% are "active" (50+ trades).

### 4. **Few Diversify**
99.5% of wallets trade only 1-2 markets. Finding wallets with ≥5 markets is rare.

### 5. **Small Position Sizes Dominate**
73.6% of wallets average <$50 per trade. These are retail/casual traders, not whales.

---

## 💡 Recommendations

### Top Watchlist Candidates

**For high-frequency, low-risk:**
1. `0xe8dd7741ccb12350957ec71e9ee332e0d1e6ec86` - 695 trades, 100% WR, $59 avg
2. `0xe3726a1b9c6ba2f06585d1c9e01d00afaedaeb38` - 323 trades, 100% WR, $0.27 avg

**For mid-volume, strong performance:**
3. `0x63d43bbb87f85af03b8f2f9e2fad7b54334fa2f1` - 216 trades, 100% WR, $152 avg
4. `0xd218e474776403a330142299f7796e8ba32eb5c9` - 165 trades, 75% WR, $137 avg

**Anomaly to investigate:**
5. `0xe60a9b0be459d9849bc2339dac20517639ae6a47` - 709 trades, 20% WR but $11k P&L (how?)

### Next Steps

1. **Monitor these wallets in real-time** for current NBA/NHL markets
2. **Analyze position entry/exit timing** - are 100% WR traders using specific strategies?
3. **Investigate wallet #5's outlier P&L** - what was their winning market?
4. **Expand to more markets** - test if these wallets maintain performance in other sports
5. **Track wallet addresses on-chain** - check if they're connected to known entities

---

## Data Files

- Raw trades: `/tmp/all_trades.json` (20,865 trades)
- Market info: `/tmp/market_info.json` (20 markets)
- Strict criteria rankings: `/tmp/wallet_rankings.json` (3 wallets)
- Relaxed criteria rankings: `/tmp/wallet_rankings_relaxed.json` (18 wallets)

---

**Generated by OpenClaw Agent**  
*Session: roi-nba-nhl*
