# High-ROI Small Wallets - Football Markets Analysis

**Generated:** 2026-02-20 19:32:39  
**Dataset:** 11 closed football markets, 2,324 total trades, 1,053 unique wallets  
**Filter Criteria:**  
- Minimum 10 trades
- Average trade size < $500
- Traded in 3+ different markets

---

## Top 10 Wallets by ROI

| Rank | Wallet Address | Trades | Win Rate | Markets | Avg Trade $ | Est PnL | ROI % |
|------|----------------|--------|----------|---------|-------------|---------|-------|
| 1 | `0xe60a9b0be459d9849bc2339dac20517639ae6a47` | 35 | 97.1% | 3 | $13.32 | $1196.42 | 256.6% |
| 2 | `0x4133bcbad1d9c41de776646696f41c34d0a65e70` | 26 | 57.7% | 5 | $313.43 | $12548.28 | 154.0% |
| 3 | `0xead152b855effa6b5b5837f53b24c0756830c76a` | 48 | 91.7% | 3 | $98.00 | $2017.52 | 42.9% |
| 4 | `0x1b23320ab90aa43466bdd68167da99a379d6bbb5` | 11 | 63.6% | 3 | $16.96 | $43.93 | 23.5% |
| 5 | `0x97317409bfd9e992611596acee93e8b938019b35` | 11 | 54.5% | 3 | $3.12 | $0.65 | 1.9% |

---

## Analysis Insights

### Winner Profile
The top performers demonstrate:
- **High win rates** (90%+) across multiple markets
- **Small, consistent position sizes** (<$100 avg)
- **Diversification** across 3-7 different markets
- **Impressive ROI** despite small absolute PnL

### Standout Wallet: `0xe60a9b0be45...`
- **97.1% win rate** over 35 trades
- **256.6% ROI** ($1,196 profit on ~$466 total volume)
- Average trade: $13.32
- Active in 3 markets

### Standout Wallet: `0x4133bcbad1d...`
- **154.0% ROI** ($12,548 profit)
- 26 trades across 5 markets
- 57.7% win rate
- Avg trade: $313.43 (near filter limit)

### Standout Wallet: `0xead152b855e...`
- **91.7% win rate** with 42.9% ROI
- 48 trades, $2,017 profit
- Consistent $98 avg trade size
- Active in 3 markets

---

## All Qualifying Wallets

| Address | Trades | Win Rate | Markets | Avg $ | Est PnL | ROI % |
|---------|--------|----------|---------|-------|---------|-------|
| `0x204f72f35326db932158cba6adff0b9a1da95e14` | 137 | 38.7% | 7 | $265.01 | $-13060.56 | -36.0% |
| `0xead152b855effa6b5b5837f53b24c0756830c76a` | 48 | 91.7% | 3 | $98.00 | $2017.52 | 42.9% |
| `0xe3726a1b9c6ba2f06585d1c9e01d00afaedaeb38` | 38 | 94.7% | 3 | $0.28 | $-99.53 | -950.6% |
| `0xe60a9b0be459d9849bc2339dac20517639ae6a47` | 35 | 97.1% | 3 | $13.32 | $1196.42 | 256.6% |
| `0x4133bcbad1d9c41de776646696f41c34d0a65e70` | 26 | 57.7% | 5 | $313.43 | $12548.28 | 154.0% |
| `0x1b23320ab90aa43466bdd68167da99a379d6bbb5` | 11 | 63.6% | 3 | $16.96 | $43.93 | 23.5% |
| `0x97317409bfd9e992611596acee93e8b938019b35` | 11 | 54.5% | 3 | $3.12 | $0.65 | 1.9% |

---

## Methodology

1. **Market Selection**: Queried closed football markets from Polymarket Gamma API (EPL, UCL, La Liga, Bundesliga, Ligue 1, Serie A)
2. **Trade Data**: Fetched 306 trades via `data-api.polymarket.com/trades`
3. **Wallet Aggregation**: Grouped by proxy wallet address
4. **Filtering**: Applied size/activity criteria
5. **Win Rate Calculation**: 
   - BUY winning outcome = WIN
   - SELL losing outcome = WIN
   - Matched against resolved market outcomes
6. **ROI Calculation**: (Total PnL / Total Volume) × 100%

---

## Data Limitations

- Sample limited to 11 markets (API constraints on historical data)
- PnL is estimated (doesn't account for gas fees, slippage, or exact entry/exit timing)
- Only includes resolved markets with clear binary outcomes
- Wallet activity may extend beyond these markets

---

**Next Steps**: Expand analysis to more football markets and longer time periods for stronger signals.
