#!/usr/bin/env python3
"""
Verify the $118K in 30 days claim from the article
"""
import json
from datetime import datetime, timedelta
import statistics

# Load trades
with open('/Users/andres/.openclaw/workspace/polymarket-watchlist-v1/data/wallet-research/xdd07070_all_trades.json') as f:
    all_trades = json.load(f)

print("="*80)
print("VERIFYING $118K CLAIM")
print("="*80)

# Get the most recent trade timestamp
latest_timestamp = max(t['timestamp'] for t in all_trades)
latest_date = datetime.fromtimestamp(latest_timestamp)
thirty_days_ago = latest_date - timedelta(days=30)

print(f"\nAnalyzing last 30 days:")
print(f"From: {thirty_days_ago.strftime('%Y-%m-%d')}")
print(f"To: {latest_date.strftime('%Y-%m-%d')}")

# Filter trades from last 30 days
recent_trades = [t for t in all_trades if datetime.fromtimestamp(t['timestamp']) >= thirty_days_ago]
print(f"\nTrades in last 30 days: {len(recent_trades)}")

# Organize by market
from collections import defaultdict
markets = defaultdict(list)
for trade in recent_trades:
    market_key = (trade['slug'], trade['title'])
    markets[market_key].append(trade)

print(f"Markets in last 30 days: {len(markets)}")

# Calculate P&L for each market
total_pnl = 0
wins = 0
losses = 0

print(f"\n{'='*80}")
print("DETAILED MARKET BREAKDOWN (Last 30 Days)")
print(f"{'='*80}\n")

for i, ((slug, title), trades_list) in enumerate(sorted(markets.items(), key=lambda x: x[0][1]), 1):
    trades_sorted = sorted(trades_list, key=lambda x: x['timestamp'])
    
    buys = [t for t in trades_sorted if t['side'] == 'BUY']
    sells = [t for t in trades_sorted if t['side'] == 'SELL']
    
    total_bought = sum(t['size'] for t in buys)
    total_sold = sum(t['size'] for t in sells)
    
    cost_basis = sum(t['size'] * t['price'] for t in buys)
    proceeds = sum(t['size'] * t['price'] for t in sells)
    pnl = proceeds - cost_basis
    
    net_position = total_bought - total_sold
    is_open = abs(net_position) > 0.01
    
    total_pnl += pnl
    if pnl > 0:
        wins += 1
    elif pnl < 0:
        losses += 1
    
    status = "OPEN" if is_open else "CLOSED"
    avg_buy = cost_basis / total_bought if total_bought > 0 else 0
    avg_sell = proceeds / total_sold if total_sold > 0 else 0
    
    print(f"{i}. {title}")
    print(f"   Status: {status} | Trades: {len(trades_sorted)}")
    print(f"   Bought: ${total_bought:,.2f} @ {avg_buy:.4f}")
    print(f"   Sold: ${total_sold:,.2f} @ {avg_sell:.4f}")
    print(f"   P&L: ${pnl:,.2f}")
    print()

print(f"{'='*80}")
print("SUMMARY (Last 30 Days)")
print(f"{'='*80}")
print(f"Total realized P&L: ${total_pnl:,.2f}")
print(f"Markets: {wins}W / {losses}L")
print(f"Win rate: {wins/(wins+losses)*100:.1f}%" if (wins+losses) > 0 else "N/A")

# Check if this matches the article's claim
print(f"\n📰 ARTICLE CLAIM: $118,748.16 in one month")
print(f"📊 OUR CALCULATION: ${total_pnl:,.2f} in last 30 days")
print(f"💡 Difference: ${abs(118748.16 - total_pnl):,.2f}")

if abs(total_pnl - 118748.16) > 10000:
    print(f"\n⚠️  NOTE: Significant discrepancy detected.")
    print(f"Possible reasons:")
    print(f"  1. Open positions with unrealized gains not counted")
    print(f"  2. Different time window than what article analyzed")
    print(f"  3. Markets resolved after trades but before article publication")
    print(f"  4. Article may have included unrealized P&L from current positions")

print(f"\nOpen positions: {len([m for (m, trades) in markets.items() if abs(sum(t['size'] if t['side'] == 'BUY' else -t['size'] for t in trades)) > 0.01])}")
