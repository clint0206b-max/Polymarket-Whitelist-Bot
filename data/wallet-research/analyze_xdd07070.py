#!/usr/bin/env python3
"""
Comprehensive analysis of Polymarket trader xdd07070
Wallet: 0x25e28169faea17421fcd4cc361f6436d1e449a09
"""
import json
from datetime import datetime
from collections import defaultdict, Counter
import statistics

# Load trades
with open('/Users/andres/.openclaw/workspace/polymarket-watchlist-v1/data/wallet-research/xdd07070_all_trades.json') as f:
    all_trades = json.load(f)

print(f"{'='*80}")
print(f"POLYMARKET TRADER ANALYSIS: xdd07070")
print(f"Wallet: 0x25e28169faea17421fcd4cc361f6436d1e449a09")
print(f"{'='*80}\n")

# Basic stats
print(f"📊 BASIC STATISTICS")
print(f"Total trades: {len(all_trades)}")

# Filter esports only
esports_prefixes = ['cs2-', 'lol-', 'dota2-', 'val-', 'valorant:', 'counter-strike:', 'league-of-legends:', 'dota-2:']
esports_trades = [t for t in all_trades if any(t['slug'].lower().startswith(p) or t['title'].lower().startswith(p.replace('-', ' ').strip(':')) for p in esports_prefixes)]

print(f"Esports trades: {len(esports_trades)} ({len(esports_trades)/len(all_trades)*100:.1f}%)")
print(f"Non-esports trades: {len(all_trades) - len(esports_trades)}")

# Date range
timestamps = [t['timestamp'] for t in all_trades]
start_date = datetime.fromtimestamp(min(timestamps))
end_date = datetime.fromtimestamp(max(timestamps))
days_active = (end_date - start_date).days

print(f"\n📅 ACTIVITY PERIOD")
print(f"First trade: {start_date.strftime('%Y-%m-%d')}")
print(f"Last trade: {end_date.strftime('%Y-%m-%d')}")
print(f"Days active: {days_active} days")

# Organize trades by market
markets = defaultdict(list)
for trade in all_trades:
    market_key = (trade['slug'], trade['title'])
    markets[market_key].append(trade)

print(f"\n🎯 MARKET PARTICIPATION")
print(f"Unique markets traded: {len(markets)}")

# Analyze position flow (BUY -> SELL pattern)
market_analysis = []
total_pnl = 0
wins = 0
losses = 0

for (slug, title), trades_list in markets.items():
    trades_sorted = sorted(trades_list, key=lambda x: x['timestamp'])
    
    # Calculate entry/exit
    buys = [t for t in trades_sorted if t['side'] == 'BUY']
    sells = [t for t in trades_sorted if t['side'] == 'SELL']
    
    total_bought = sum(t['size'] for t in buys)
    total_sold = sum(t['size'] for t in sells)
    avg_buy_price = statistics.mean([t['price'] for t in buys]) if buys else 0
    avg_sell_price = statistics.mean([t['price'] for t in sells]) if sells else 0
    
    # Calculate P&L
    cost_basis = sum(t['size'] * t['price'] for t in buys)
    proceeds = sum(t['size'] * t['price'] for t in sells)
    pnl = proceeds - cost_basis
    
    # Determine if position is still open
    net_position = total_bought - total_sold
    is_open = abs(net_position) > 0.01
    
    # Time held
    if trades_sorted:
        entry_time = datetime.fromtimestamp(trades_sorted[0]['timestamp'])
        exit_time = datetime.fromtimestamp(trades_sorted[-1]['timestamp']) if not is_open else datetime.now()
        time_held_hours = (exit_time - entry_time).total_seconds() / 3600
    else:
        time_held_hours = 0
    
    market_analysis.append({
        'title': title,
        'slug': slug,
        'trades_count': len(trades_sorted),
        'total_bought': total_bought,
        'total_sold': total_sold,
        'avg_buy_price': avg_buy_price,
        'avg_sell_price': avg_sell_price,
        'pnl': pnl,
        'is_open': is_open,
        'time_held_hours': time_held_hours,
        'entry_time': datetime.fromtimestamp(trades_sorted[0]['timestamp']) if trades_sorted else None,
        'is_esports': any(slug.lower().startswith(p) or title.lower().startswith(p.replace('-', ' ').strip(':')) for p in esports_prefixes)
    })
    
    total_pnl += pnl
    if pnl > 0:
        wins += 1
    elif pnl < 0:
        losses += 1

# Calculate win rate
win_rate = wins / (wins + losses) * 100 if (wins + losses) > 0 else 0

print(f"\n💰 P&L ANALYSIS")
print(f"Total realized P&L: ${total_pnl:,.2f}")
print(f"Winning markets: {wins}")
print(f"Losing markets: {losses}")
print(f"Open positions: {len([m for m in market_analysis if m['is_open']])}")
print(f"Win rate: {win_rate:.1f}%")

# Average position metrics
avg_position_size = statistics.mean([m['total_bought'] for m in market_analysis])
avg_entry_price = statistics.mean([m['avg_buy_price'] for m in market_analysis if m['avg_buy_price'] > 0])
avg_time_held = statistics.mean([m['time_held_hours'] for m in market_analysis])

print(f"\n📈 POSITION METRICS")
print(f"Average position size: ${avg_position_size:,.2f}")
print(f"Average entry price: {avg_entry_price:.4f}")
print(f"Average time held: {avg_time_held:.1f} hours ({avg_time_held/24:.1f} days)")

# Top winners and losers
sorted_by_pnl = sorted([m for m in market_analysis if not m['is_open']], key=lambda x: x['pnl'], reverse=True)

print(f"\n🏆 TOP 5 WINNING TRADES")
for i, m in enumerate(sorted_by_pnl[:5], 1):
    print(f"{i}. {m['title']}")
    print(f"   P&L: ${m['pnl']:,.2f} | Entry: {m['avg_buy_price']:.3f} | Exit: {m['avg_sell_price']:.3f}")
    print(f"   Position: ${m['total_bought']:,.0f} | Held: {m['time_held_hours']/24:.1f} days")

print(f"\n📉 TOP 5 LOSING TRADES")
for i, m in enumerate(sorted_by_pnl[-5:][::-1], 1):
    print(f"{i}. {m['title']}")
    print(f"   P&L: ${m['pnl']:,.2f} | Entry: {m['avg_buy_price']:.3f} | Exit: {m['avg_sell_price']:.3f}")
    print(f"   Position: ${m['total_bought']:,.0f} | Held: {m['time_held_hours']/24:.1f} days")

# Esports-specific analysis
esports_markets = [m for m in market_analysis if m['is_esports']]
esports_pnl = sum(m['pnl'] for m in esports_markets)
esports_wins = len([m for m in esports_markets if m['pnl'] > 0])
esports_losses = len([m for m in esports_markets if m['pnl'] < 0])
esports_wr = esports_wins / (esports_wins + esports_losses) * 100 if (esports_wins + esports_losses) > 0 else 0

print(f"\n🎮 ESPORTS-SPECIFIC ANALYSIS")
print(f"Esports markets traded: {len(esports_markets)}")
print(f"Esports P&L: ${esports_pnl:,.2f}")
print(f"Esports win rate: {esports_wr:.1f}% ({esports_wins}W/{esports_losses}L)")

# Game breakdown
game_counts = Counter()
game_pnl = defaultdict(float)

for m in esports_markets:
    title = m['title'].lower()
    if 'counter-strike' in title or 'cs2' in m['slug']:
        game = 'Counter-Strike 2'
    elif 'valorant' in title or 'val-' in m['slug']:
        game = 'Valorant'
    elif 'league of legends' in title or 'lol-' in m['slug']:
        game = 'League of Legends'
    elif 'dota' in title or 'dota2-' in m['slug']:
        game = 'Dota 2'
    else:
        game = 'Other'
    
    game_counts[game] += 1
    game_pnl[game] += m['pnl']

print(f"\n🕹️  GAMES BREAKDOWN")
for game in game_counts:
    print(f"{game}: {game_counts[game]} markets, P&L: ${game_pnl[game]:,.2f}")

# Save detailed analysis
output = {
    'wallet_address': '0x25e28169faea17421fcd4cc361f6436d1e449a09',
    'username': 'xdd07070',
    'analysis_date': datetime.now().isoformat(),
    'summary': {
        'total_trades': len(all_trades),
        'unique_markets': len(markets),
        'total_pnl': total_pnl,
        'win_rate': win_rate,
        'wins': wins,
        'losses': losses,
        'open_positions': len([m for m in market_analysis if m['is_open']]),
        'days_active': days_active,
        'avg_position_size': avg_position_size,
        'avg_entry_price': avg_entry_price,
        'avg_time_held_hours': avg_time_held,
    },
    'esports_summary': {
        'markets': len(esports_markets),
        'pnl': esports_pnl,
        'win_rate': esports_wr,
        'wins': esports_wins,
        'losses': esports_losses,
        'games_breakdown': dict(game_counts),
        'pnl_by_game': dict(game_pnl)
    },
    'markets': market_analysis,
    'top_wins': sorted_by_pnl[:10],
    'top_losses': sorted_by_pnl[-10:][::-1]
}

output_path = '/Users/andres/.openclaw/workspace/polymarket-watchlist-v1/data/wallet-research/xdd07070-analysis.json'
with open(output_path, 'w') as f:
    json.dump(output, f, indent=2, default=str)

print(f"\n✅ Full analysis saved to: {output_path}")
print(f"{'='*80}")
