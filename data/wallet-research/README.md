# High-ROI Small Wallet Research: CBB/CWBB Markets

## Summary

Research to identify high-ROI small wallets trading College Basketball (CBB) and College Women's Basketball (CWBB) markets on Polymarket.

**Target Profile:**
- Small traders (avg position <$500)
- High activity (≥10 trades)
- Market diversity (≥3 unique markets)
- High win rates

**Goal:** Find skilled traders with consistent profits who started small.

## Current Status: **FRAMEWORK READY - DATA ACCESS BLOCKED**

### What's Complete ✅

1. **Market Discovery**
   - Identified 17 closed CBB/CWBB markets
   - Top volume: $999K (Lamar vs. New Orleans)
   - Range: $100 - $1M volume
   - Markets saved to `/tmp/cbb_filtered.json` and `/tmp/cwbb_filtered.json`

2. **Analysis Pipeline**
   - Complete wallet aggregation logic
   - Win rate calculation (checks market resolutions)
   - PnL estimation (entry vs. exit prices)
   - Scoring algorithm (WR × trades × √markets)
   - See: `analyze_wallets.py`

3. **Data Fetching Framework**
   - GraphQL subgraph integration
   - On-chain Polygon RPC queries
   - Browser automation fallback
   - See: `fetch_trades_alternative.py`

### What's Blocked ⛔

**Polymarket API Issues:**
- `/markets/{id}/trades` endpoint → 404 errors
- CLOB API not responding
- Need alternative data source

## Files

| File | Purpose | Status |
|------|---------|--------|
| `roi-cbb.md` | Main analysis report | ✅ Framework ready |
| `analyze_wallets.py` | Analysis script | ✅ Ready to run |
| `fetch_trades_alternative.py` | Data fetching script | ✅ Ready to run |
| `/tmp/cbb_filtered.json` | CBB markets (13) | ✅ Complete |
| `/tmp/cwbb_filtered.json` | CWBB markets (4) | ✅ Complete |
| `/tmp/target_markets.json` | Analysis targets | ✅ Complete |

## How to Complete Analysis

### Option 1: Try GraphQL (Recommended)

```bash
cd /Users/andres/.openclaw/workspace/polymarket-watchlist-v1/data/wallet-research
python3 fetch_trades_alternative.py
```

This will attempt:
1. Polymarket GraphQL subgraph
2. Direct blockchain queries (Polygon RPC)
3. Browser scraping (if playwright installed)

### Option 2: Manual Small-Scale Analysis

For quick results with minimal infrastructure:

1. Pick top 3 highest volume markets
2. Navigate to each on Polymarket UI
3. Export recent trades (if available)
4. Run analysis on small dataset

### Option 3: Use Dune Analytics

Polymarket data is available on Dune:
- Query: `polymarket.trades`
- Filter: CBB/CWBB markets by condition ID
- Export CSV, convert to JSON
- Run `analyze_wallets.py`

## What the Analysis Will Show

Once data is obtained, output will include:

**Top 10 Wallets with:**
- Wallet address
- Total trades & avg size
- Unique markets traded
- Win rate %
- Estimated PnL
- Composite score

**Example:**
```
1. 0x1234...5678  |  45 trades  |  $250 avg  |  8 markets  |  73% WR  |  +$1,234
2. 0xabcd...ef01  |  32 trades  |  $180 avg  |  6 markets  |  69% WR  |    +$892
```

## Methodology

### Filters
```python
min_trades = 10           # Active traders
max_avg_size = 500       # Small positions
min_markets = 3          # Diversified
```

### Scoring
```python
score = win_rate × total_trades × sqrt(unique_markets)
```

This rewards:
- **High win rates** (most important)
- **Trading activity** (confidence in strategy)
- **Market diversity** (reduces single-market luck)

### Win Rate Calculation
1. Group positions by market
2. Check market resolution outcome
3. Count positions on winning side
4. `win_rate = wins / total_positions`

### PnL Estimation
1. Calculate weighted avg entry price per market
2. Exit price = 1.0 if won, 0.0 if lost
3. `pnl = size × (exit_price - entry_price)`

## Next Actions

1. **Immediate**: Run `fetch_trades_alternative.py` to try GraphQL
2. **If blocked**: Use Dune Analytics or manual export
3. **Once data obtained**: Run `analyze_wallets.py`
4. **Output**: Review `roi-cbb.md` for final results

## Notes

- All scripts are ready and tested (logic-wise)
- Only blocker is API data access
- Analysis can run once trade data is available
- Estimated runtime: <5 minutes with data

---

**Created**: 2026-02-20  
**Status**: Framework complete, awaiting data access
