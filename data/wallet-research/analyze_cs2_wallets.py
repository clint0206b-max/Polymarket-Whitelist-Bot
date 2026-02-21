#!/usr/bin/env python3
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime

# Fetch CS2 markets
print("Fetching CS2 markets from Gamma API...")
result = subprocess.run(
    ['curl', '-s', 'https://gamma-api.polymarket.com/markets?tag=esports&limit=100&closed=true&order=volume&ascending=false'],
    capture_output=True,
    text=True
)

markets = json.loads(result.stdout)
cs2_markets = [m for m in markets if 'cs2' in m.get('slug', '').lower() or 'counter' in m.get('slug', '').lower()]
cs2_markets_sorted = sorted(cs2_markets, key=lambda x: float(x.get('volume', 0)), reverse=True)[:10]

print(f"Found {len(cs2_markets)} CS2 markets, analyzing top {len(cs2_markets_sorted)}")
print()

# Aggregate wallet data across all markets
all_wallets = defaultdict(lambda: {
    'buys': 0,
    'sells': 0,
    'volume': 0.0,
    'markets': set(),
    'market_details': []
})

for i, market in enumerate(cs2_markets_sorted, 1):
    condition_id = market.get('conditionId', '')
    slug = market.get('slug', '')
    market_volume = float(market.get('volume', 0))
    
    print(f"[{i}/10] Fetching trades for {slug} (vol=${market_volume:.2f})...")
    
    # Fetch trades for this market
    trades_result = subprocess.run(
        ['curl', '-s', f'https://data-api.polymarket.com/trades?market={condition_id}&limit=1000'],
        capture_output=True,
        text=True
    )
    
    try:
        trades = json.loads(trades_result.stdout)
        print(f"  -> {len(trades)} trades found")
        
        for trade in trades:
            wallet = trade.get('proxyWallet', '')
            if not wallet:
                continue
                
            side = trade.get('side', '')
            size = float(trade.get('size', 0))
            price = float(trade.get('price', 0))
            trade_volume = size * price
            
            all_wallets[wallet]['volume'] += trade_volume
            all_wallets[wallet]['markets'].add(slug)
            
            if side == 'BUY':
                all_wallets[wallet]['buys'] += 1
            else:
                all_wallets[wallet]['sells'] += 1
                
    except json.JSONDecodeError as e:
        print(f"  -> Error parsing trades: {e}")
        continue

print()
print("Aggregating and ranking wallets...")

# Convert to serializable format and rank
wallets_list = []
for wallet, stats in all_wallets.items():
    wallets_list.append({
        'wallet': wallet,
        'total_volume': stats['volume'],
        'total_trades': stats['buys'] + stats['sells'],
        'buys': stats['buys'],
        'sells': stats['sells'],
        'unique_markets': len(stats['markets']),
        'markets': sorted(list(stats['markets']))
    })

wallets_ranked = sorted(wallets_list, key=lambda x: x['total_volume'], reverse=True)[:20]

# Print summary
print()
print("=" * 80)
print("TOP 20 CS2 WALLETS BY VOLUME")
print("=" * 80)
for i, w in enumerate(wallets_ranked, 1):
    print(f"{i:2}. {w['wallet']}")
    print(f"    Volume: ${w['total_volume']:.2f} | Trades: {w['total_trades']} (B:{w['buys']}, S:{w['sells']}) | Markets: {w['unique_markets']}")
    print()

# Save to JSON
output = {
    'generated_at': datetime.utcnow().isoformat() + 'Z',
    'description': 'Top 20 Polymarket wallets trading CS2 esports markets',
    'markets_analyzed': len(cs2_markets_sorted),
    'total_wallets_found': len(all_wallets),
    'markets': [
        {
            'condition_id': m.get('conditionId'),
            'slug': m.get('slug'),
            'volume': float(m.get('volume', 0))
        }
        for m in cs2_markets_sorted
    ],
    'top_wallets': wallets_ranked
}

output_path = '/Users/andres/.openclaw/workspace/polymarket-watchlist-v1/data/wallet-research/cs2-wallets.json'
with open(output_path, 'w') as f:
    json.dump(output, f, indent=2)

print(f"Results saved to {output_path}")
