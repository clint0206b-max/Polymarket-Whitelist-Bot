# High-ROI Small Wallets Research: LoL, Dota2, UFC, MLB, NFL
**Date:** 2026-02-20  
**Status:** ⚠️ **BLOCKED - Multiple API Limitations**

## Objective
Find small wallets with:
- ✅ High trade frequency (≥10 trades)
- ✅ Small average trade size (<$500)
- ✅ Multi-market activity (≥3 unique markets)
- ✅ High win rates
- ✅ Focus on: League of Legends, Dota2, UFC, MLB, NFL

---

## 🚨 Critical Blockers

### 1. Polymarket Gamma API - Trade Data Requires Auth
**Endpoint:** `https://gamma-api.polymarket.com/trades`  
**Status:** 404 Not Found (requires authentication)

### 2. Polymarket CLOB API - Invalid Credentials
**Endpoint:** `https://clob.polymarket.com/trades`  
**Status:** 401 Unauthorized  
**Credentials found:** `~/.openclaw/workspace/.polymarket-credentials.json`  
**Issue:** Bot's API key appears invalid or requires different auth method (HMAC signing failed)

### 3. Polygon RPC - Public Endpoint Disabled
**Endpoint:** `https://polygon-rpc.com`  
**Status:** 403 Forbidden ("tenant disabled")  
**Impact:** Cannot query on-chain OrderFilled events from CTF Exchange contracts

### 4. LoL Markets - None Found
**Search attempts:**
- `slug_contains=lol-`
- `_title_contains=league-of-legends`
- Series slug: `league-of-legends`

**Result:** 0 closed LoL markets found (may not exist or require different search terms)

---

## ✅ What Was Accomplished

### Markets Discovered (Partial Success)

From 500 recent closed markets, identified sports categories:

| Sport | Markets Found | Top Volume | Status |
|-------|---------------|------------|--------|
| **UFC** | 2 | $999,732 | ✅ Found |
| **Dota2** | 26 | $99,890 | ✅ Found |
| **MLB** | 4 | $999,452 | ✅ Found |
| **NFL** | 36 | $99,957 | ✅ Found |
| **LoL** | 0 | N/A | ❌ Not found |

### Top 20 Sports Markets by Volume

1. **UFC** - $999,732 - Dvalishvili vs. Sandhagen  
   `0x61ef853c0ecc72a583da722cf6434681f9b92d10652cded44d8f889beb923418`

2. **MLB** - $999,452 - Astros vs. Blue Jays  
   `0x124df10e1ad97d41ebc03a98884bf12378e7a64956b15d9ccb1bf24a29a01af2`

3. **MLB** - $99,965 - Reds vs. Royals  
   `0xa587dec85bea70ff0ad2a12a73be0d8c78e3d72a8f623841769cd951492e43c2`

4. **MLB** - $99,964 - Braves vs. Brewers  
   `0x0777c5ddfc707b208d665ab5fe0314e9f3b9913df8e803d928ad3c75de87d8ab`

5. **NFL** - $99,957 - Texans vs. Chargers: O/U 39.5  
   `0x6bf0992b8ad9180dbb63c6c1f3534ee9899638b70bc758036df9476d99999f5a`

6. **MLB** - $99,918 - Nationals vs. Giants  
   `0xfedad3141e8ccda58199d97712004f90d82f2eb26163821a4fc334742eb980d0`

7. **DOTA2** - $99,890 - Xtreme Gaming vs. Nigma Galaxy  
   `0x9de4612a0a1c13ca43754bf646c1eeab24372d181c46b3a47f8791c96850ab0e`

8. **NFL** - $99,842 - Bears vs. Eagles: O/U 44.5  
   `0x4fcbbc517cc6e2e39fa4eab3adb336b7e6bade39399f533ad590d0643bdc03f8`

9-20. (Various Dota2 kill count O/U markets, $1k-$10k volume)

**Full list:** `/tmp/top_sports_markets.json`

---

## 🔧 Alternative Solutions

### Option A: Use Dune Analytics (RECOMMENDED)
Dune has indexed Polymarket contract events:

```sql
-- Example Dune query for Polymarket trades
SELECT 
    maker,
    taker,
    maker_amount / 1e6 as trade_size_usd,
    block_time
FROM polygon.logs
WHERE contract_address IN (
    0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E,  -- CTF Exchange
    0xC5d563A36AE78145C45a50134d48A1215220f80a   -- Neg Risk Exchange
)
AND topic0 = 0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2f8c4f9a68e
AND block_time > NOW() - INTERVAL '30 days'
LIMIT 10000
```

**Pros:** 
- Free tier available
- Pre-indexed Polygon data
- SQL interface for analysis

**Cons:**
- May hit query limits
- Need to join with market metadata

### Option B: PolygonScan API
**Endpoint:** `https://api.polygonscan.com/api`  
**Free tier:** 100k calls/day  

```bash
# Get OrderFilled events for CTF Exchange
curl "https://api.polygonscan.com/api?module=logs&action=getLogs&address=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E&topic0=0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2f8c4f9a68e&fromBlock=54000000&toBlock=latest&apikey=YOUR_KEY"
```

**Pros:**
- Free API key
- Reliable
- Can filter by topics

**Cons:**
- Requires signup
- 5 calls/sec rate limit

### Option C: Alchemy/Infura Polygon RPC
Paid RPC providers that work:
- **Alchemy:** Free tier: 300M compute units/month
- **Infura:** Free tier: 100k requests/day

### Option D: Graph Protocol Subgraph
Polymarket may have a subgraph indexing their contracts:

```graphql
{
  trades(first: 1000, where: {conditionId: "0x61ef..."}) {
    maker
    taker
    amount
    timestamp
  }
}
```

Check: `https://thegraph.com/explorer` for Polymarket subgraphs

---

## 📊 What Analysis Would Look Like (If Data Available)

### Step 1: Aggregate Trades by Wallet
```python
wallets[address] = {
    'total_trades': 47,
    'total_volume': 8234.50,
    'avg_trade_size': 175.20,
    'unique_markets': 12,
    'sports_traded': ['ufc', 'dota2', 'mlb'],
    'wins': 32,
    'losses': 15,
    'win_rate': 0.681
}
```

### Step 2: Filter Criteria
- `total_trades >= 10` ✅
- `avg_trade_size < 500` ✅  
- `unique_markets >= 3` ✅
- Sports in: UFC, Dota2, MLB, NFL ✅

### Step 3: Rank by ROI Score
```
score = win_rate * total_trades
```

### Expected Top 10 Format
```
1. 0xabc...123
   • Trades: 89 | Avg Size: $127 | Win Rate: 74.2%
   • Markets: 23 (ufc: 12, dota2: 8, mlb: 3)
   • Est PnL: +$4,832
   • Score: 66.04

2. 0xdef...456
   • Trades: 67 | Avg Size: $243 | Win Rate: 70.1%
   • Markets: 15 (nfl: 9, ufc: 4, dota2: 2)
   • Est PnL: +$3,201
   • Score: 46.97

[...]
```

---

## 🎯 Recommended Next Action

**PRIORITY 1:** Use **Dune Analytics**
1. Create free Dune account
2. Fork existing Polymarket dashboard
3. Modify query to filter for our target condition IDs
4. Export results as CSV
5. Run analysis in Python

**PRIORITY 2:** If Dune insufficient → **PolygonScan API**
1. Get free API key (2 minutes)
2. Fetch logs for both CTF contracts
3. Decode OrderFilled events
4. Match to our sports markets

**Time estimate:** 1-2 hours for complete analysis with proper data access

---

## 📁 Files Created

- `/tmp/top_sports_markets.json` - 20 sports markets with condition IDs
- `/tmp/wallet_summary.json` - Empty (no trade data)
- `/tmp/filtered_wallets.json` - Empty (no trade data)
- `roi-lol-ufc-other.md` - This report

---

## 🔍 LoL Markets Investigation

**Why no LoL markets found?**

Possible reasons:
1. **Naming:** Markets may use "League of Legends" (full name) not "LoL"
2. **Timing:** No recent closed LoL markets (check live markets)
3. **Volume filter:** May be lower volume, got filtered out
4. **Tournament gaps:** Between LCS/Worlds seasons

**Next steps for LoL:**
```bash
# Try alternative searches
curl "https://gamma-api.polymarket.com/markets?_title_contains=League%20of%20Legends&closed=true"
curl "https://gamma-api.polymarket.com/markets?_title_contains=T1&closed=true"  # Team names
curl "https://gamma-api.polymarket.com/markets?_title_contains=LCS&closed=true"
```

---

**Status:** Research framework complete, awaiting data access solution.  
**Blocker:** Trade data requires external API (Dune/PolygonScan/Alchemy)  
**ETA:** Can complete in 1-2 hours once data access is secured
