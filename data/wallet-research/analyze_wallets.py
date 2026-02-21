#!/usr/bin/env python3
"""
High-ROI Small Wallet Analysis for CBB/CWBB Markets

Usage:
    python3 analyze_wallets.py trades.json markets.json

Where:
    trades.json - Trade data with fields: maker, size, price, outcome, market_id, timestamp
    markets.json - Market info with resolution outcomes
"""

import json
import sys
from collections import defaultdict
from typing import Dict, List, Tuple
import math

def load_data(trades_file: str, markets_file: str) -> Tuple[List[dict], Dict[str, dict]]:
    """Load trades and market data."""
    with open(trades_file) as f:
        trades = json.load(f)
    
    with open(markets_file) as f:
        markets = json.load(f)
    
    return trades, markets

def aggregate_by_wallet(trades: List[dict]) -> Dict[str, dict]:
    """Aggregate trade data by wallet address."""
    
    wallets = defaultdict(lambda: {
        'total_trades': 0,
        'total_volume': 0.0,
        'trade_sizes': [],
        'markets': set(),
        'positions': []
    })
    
    for trade in trades:
        wallet = trade['maker'].lower()
        size = float(trade.get('size', 0))
        price = float(trade.get('price', 0))
        volume = size * price
        
        wallets[wallet]['total_trades'] += 1
        wallets[wallet]['total_volume'] += volume
        wallets[wallet]['trade_sizes'].append(size)
        wallets[wallet]['markets'].add(trade.get('market_id'))
        wallets[wallet]['positions'].append(trade)
    
    # Calculate averages
    for wallet, data in wallets.items():
        data['avg_trade_size'] = sum(data['trade_sizes']) / len(data['trade_sizes'])
        data['unique_markets'] = len(data['markets'])
        data['markets'] = list(data['markets'])
    
    return dict(wallets)

def filter_small_traders(wallets: Dict[str, dict], 
                         min_trades: int = 10,
                         max_avg_size: float = 500,
                         min_markets: int = 3) -> Dict[str, dict]:
    """Filter for small active traders."""
    
    filtered = {}
    
    for addr, data in wallets.items():
        if (data['total_trades'] >= min_trades and 
            data['avg_trade_size'] < max_avg_size and
            data['unique_markets'] >= min_markets):
            filtered[addr] = data
    
    return filtered

def calculate_win_rate(wallet_data: dict, markets: Dict[str, dict]) -> float:
    """Calculate win rate for a wallet."""
    
    wins = 0
    total_positions = 0
    
    # Group positions by market
    market_positions = defaultdict(list)
    for pos in wallet_data['positions']:
        market_positions[pos['market_id']].append(pos)
    
    for market_id, positions in market_positions.items():
        market = markets.get(market_id)
        if not market or not market.get('resolved'):
            continue
        
        winning_outcome = market.get('winning_outcome')
        if winning_outcome is None:
            continue
        
        # Check if wallet held winning outcome
        # (Simplified: assumes last position held)
        last_position = positions[-1]
        if last_position.get('outcome') == winning_outcome:
            wins += 1
        
        total_positions += 1
    
    return wins / total_positions if total_positions > 0 else 0.0

def estimate_pnl(wallet_data: dict, markets: Dict[str, dict]) -> float:
    """Estimate profit/loss for a wallet."""
    
    total_pnl = 0.0
    
    # Group positions by market and outcome
    market_positions = defaultdict(lambda: defaultdict(list))
    for pos in wallet_data['positions']:
        market_positions[pos['market_id']][pos['outcome']].append(pos)
    
    for market_id, outcomes in market_positions.items():
        market = markets.get(market_id)
        if not market or not market.get('resolved'):
            continue
        
        winning_outcome = market.get('winning_outcome')
        
        for outcome, positions in outcomes.items():
            # Calculate weighted average entry price
            total_size = sum(float(p['size']) for p in positions)
            weighted_price = sum(float(p['size']) * float(p['price']) for p in positions) / total_size
            
            # Exit price is 1 if won, 0 if lost
            exit_price = 1.0 if outcome == winning_outcome else 0.0
            
            # PnL
            pnl = total_size * (exit_price - weighted_price)
            total_pnl += pnl
    
    return total_pnl

def score_wallet(wallet_data: dict, win_rate: float) -> float:
    """Score wallet by win rate, activity, and diversity."""
    
    # Score = WR * trades * sqrt(markets)
    # Favors high WR, high activity, and market diversity
    
    score = (
        win_rate * 
        wallet_data['total_trades'] * 
        math.sqrt(wallet_data['unique_markets'])
    )
    
    return score

def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    
    trades_file = sys.argv[1]
    markets_file = sys.argv[2]
    
    print("Loading data...")
    trades, markets = load_data(trades_file, markets_file)
    
    print(f"Loaded {len(trades):,} trades across {len(markets)} markets")
    
    print("\nAggregating by wallet...")
    wallets = aggregate_by_wallet(trades)
    print(f"Found {len(wallets):,} unique wallets")
    
    print("\nFiltering for small active traders...")
    small_traders = filter_small_traders(wallets)
    print(f"Found {len(small_traders):,} qualifying wallets")
    
    print("\nCalculating win rates and PnL...")
    results = []
    
    for addr, data in small_traders.items():
        win_rate = calculate_win_rate(data, markets)
        pnl = estimate_pnl(data, markets)
        score = score_wallet(data, win_rate)
        
        results.append({
            'address': addr,
            'total_trades': data['total_trades'],
            'avg_trade_size': data['avg_trade_size'],
            'unique_markets': data['unique_markets'],
            'win_rate': win_rate,
            'est_pnl': pnl,
            'score': score
        })
    
    # Sort by score
    results.sort(key=lambda x: x['score'], reverse=True)
    
    print("\n" + "="*80)
    print("TOP 10 HIGH-ROI SMALL WALLETS (CBB/CWBB)")
    print("="*80)
    print(f"{'Rank':<6}{'Address':<44}{'Trades':<8}{'Avg Size':<10}{'Markets':<9}{'WR%':<8}{'Est PnL':<12}{'Score':<10}")
    print("-"*80)
    
    for i, result in enumerate(results[:10], 1):
        print(
            f"{i:<6}"
            f"{result['address']:<44}"
            f"{result['total_trades']:<8}"
            f"${result['avg_trade_size']:<9.0f}"
            f"{result['unique_markets']:<9}"
            f"{result['win_rate']*100:<7.1f}%"
            f"${result['est_pnl']:<11,.2f}"
            f"{result['score']:<10.2f}"
        )
    
    # Save results
    output_file = 'roi_wallets_output.json'
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"\nFull results saved to {output_file}")
    
    # Print summary stats
    if results:
        print("\nSUMMARY STATISTICS:")
        print(f"  Median Win Rate: {sorted([r['win_rate'] for r in results])[len(results)//2]*100:.1f}%")
        print(f"  Median Trades: {sorted([r['total_trades'] for r in results])[len(results)//2]}")
        print(f"  Median Markets: {sorted([r['unique_markets'] for r in results])[len(results)//2]}")
        print(f"  Total Est PnL (Top 10): ${sum(r['est_pnl'] for r in results[:10]):,.2f}")

if __name__ == '__main__':
    main()
