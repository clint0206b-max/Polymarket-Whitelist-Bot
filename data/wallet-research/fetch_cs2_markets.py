#!/usr/bin/env python3
import json
import sys

markets = json.load(sys.stdin)
cs2_markets = [m for m in markets if 'cs2' in m.get('slug', '').lower() or 'counter' in m.get('slug', '').lower()]

print(f'Total esports markets: {len(markets)}')
print(f'CS2 markets found: {len(cs2_markets)}')
print()

for m in cs2_markets[:20]:
    print(f"{m.get('conditionId','')} | {m.get('slug','')} | vol=${m.get('volume',0)}")
