#!/usr/bin/env python3
"""
Alternative methods to fetch Polymarket trade data for CBB/CWBB markets.

Methods:
1. GraphQL Subgraph (recommended)
2. Direct blockchain query via Polygon RPC
3. Browser automation scraping
"""

import json
import requests
from typing import List, Dict

# ============================================================================
# METHOD 1: GraphQL Subgraph
# ============================================================================

POLYMARKET_SUBGRAPH = "https://api.thegraph.com/subgraphs/name/polymarket/polymarket-matic"

def fetch_via_graphql(condition_ids: List[str]) -> List[dict]:
    """Fetch trades via Polymarket GraphQL subgraph."""
    
    query = """
    query GetTrades($conditionIds: [String!]!) {
      trades(
        first: 1000
        where: { condition_in: $conditionIds }
        orderBy: timestamp
        orderDirection: desc
      ) {
        id
        trader
        outcomeIndex
        outcomeTokensTraded
        collateralAmount
        price
        timestamp
        condition {
          id
          questionId
        }
      }
    }
    """
    
    variables = {"conditionIds": condition_ids}
    
    response = requests.post(
        POLYMARKET_SUBGRAPH,
        json={"query": query, "variables": variables}
    )
    
    if response.status_code == 200:
        data = response.json()
        return data.get('data', {}).get('trades', [])
    else:
        print(f"GraphQL error: {response.status_code}")
        return []

# ============================================================================
# METHOD 2: On-Chain via Polygon RPC
# ============================================================================

POLYGON_RPC = "https://polygon-rpc.com"
CTF_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"  # Polymarket CTF

# Event signature for trades (example)
TRADE_EVENT_TOPIC = "0x3e9c37b3143f2eb7e9a2a0f8091b6de097b62efcfe48e1f68847a832e521750a"

def fetch_via_rpc(condition_id: str, from_block: int = 40000000, to_block: int = 'latest') -> List[dict]:
    """Fetch trades by querying Polygon blockchain directly."""
    
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_getLogs",
        "params": [{
            "address": CTF_CONTRACT,
            "topics": [TRADE_EVENT_TOPIC, condition_id],
            "fromBlock": hex(from_block),
            "toBlock": to_block
        }]
    }
    
    response = requests.post(POLYGON_RPC, json=payload)
    
    if response.status_code == 200:
        data = response.json()
        return data.get('result', [])
    else:
        print(f"RPC error: {response.status_code}")
        return []

def decode_trade_log(log: dict) -> dict:
    """Decode trade log from blockchain event."""
    # This is simplified - actual ABI decoding needed
    return {
        'tx_hash': log['transactionHash'],
        'block_number': int(log['blockNumber'], 16),
        'trader': '0x' + log['topics'][1][-40:],  # Extract address from topic
        'data': log['data']  # Needs proper ABI decoding
    }

# ============================================================================
# METHOD 3: Browser Automation (Selenium/Playwright)
# ============================================================================

def fetch_via_browser(market_slug: str) -> List[dict]:
    """
    Scrape trade data using browser automation.
    
    Requires: pip install playwright && playwright install
    """
    from playwright.sync_api import sync_playwright
    
    trades = []
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        # Navigate to market
        url = f"https://polymarket.com/event/{market_slug}"
        page.goto(url)
        
        # Wait for trades to load
        page.wait_for_selector('.trade-item', timeout=10000)
        
        # Extract trade data
        trade_elements = page.query_selector_all('.trade-item')
        
        for elem in trade_elements:
            trade = {
                'address': elem.query_selector('.trader-address').inner_text(),
                'size': elem.query_selector('.trade-size').inner_text(),
                'price': elem.query_selector('.trade-price').inner_text(),
                'outcome': elem.query_selector('.trade-outcome').inner_text(),
                'timestamp': elem.query_selector('.trade-time').inner_text()
            }
            trades.append(trade)
        
        browser.close()
    
    return trades

# ============================================================================
# MAIN: Orchestration
# ============================================================================

def main():
    """Fetch trades using all available methods."""
    
    # Load target markets
    with open('/tmp/target_markets.json') as f:
        data = json.load(f)
    
    condition_ids = data['condition_ids']
    market_info = data['market_info']
    
    print("="*80)
    print("FETCHING TRADES - ALTERNATIVE METHODS")
    print("="*80)
    
    all_trades = []
    
    # Method 1: Try GraphQL first
    print("\n[1/3] Attempting GraphQL subgraph...")
    try:
        graphql_trades = fetch_via_graphql(condition_ids)
        print(f"  → Fetched {len(graphql_trades)} trades")
        all_trades.extend(graphql_trades)
    except Exception as e:
        print(f"  → GraphQL failed: {e}")
    
    # Method 2: Try on-chain if GraphQL failed
    if len(all_trades) == 0:
        print("\n[2/3] Attempting on-chain RPC query...")
        try:
            for cond_id in condition_ids[:5]:  # Sample first 5
                logs = fetch_via_rpc(cond_id)
                decoded = [decode_trade_log(log) for log in logs]
                all_trades.extend(decoded)
                print(f"  → {cond_id[:10]}...: {len(decoded)} trades")
        except Exception as e:
            print(f"  → RPC failed: {e}")
    
    # Method 3: Browser scraping as last resort
    if len(all_trades) == 0:
        print("\n[3/3] Attempting browser scraping...")
        try:
            for cond_id, info in list(market_info.items())[:3]:  # Sample first 3
                slug = info['slug']
                trades = fetch_via_browser(slug)
                all_trades.extend(trades)
                print(f"  → {slug}: {len(trades)} trades")
        except Exception as e:
            print(f"  → Browser scraping failed: {e}")
    
    # Save results
    if all_trades:
        output_file = 'cbb_cwbb_trades.json'
        with open(output_file, 'w') as f:
            json.dump(all_trades, f, indent=2)
        
        print(f"\n✓ Successfully fetched {len(all_trades)} trades")
        print(f"✓ Saved to {output_file}")
        print(f"\nNext: Run analyze_wallets.py {output_file} markets.json")
    else:
        print("\n✗ All methods failed. Consider:")
        print("  1. Check Polymarket API documentation for changes")
        print("  2. Use Polymarket's official data export tools")
        print("  3. Contact Polymarket support for API access")
        print("  4. Use Dune Analytics queries for Polymarket data")

if __name__ == '__main__':
    main()
