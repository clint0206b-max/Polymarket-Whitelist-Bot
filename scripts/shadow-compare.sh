#!/bin/bash
# Compare prod vs shadow runner performance
# Usage: ./scripts/shadow-compare.sh <shadow-id>

set -euo pipefail

SHADOW_ID="${1:-}"

if [ -z "$SHADOW_ID" ]; then
  echo "Usage: $0 <shadow-id>"
  exit 1
fi

cd "$(dirname "$0")/.."

node -e "
const fs = require('fs');

function loadSignals(dir) {
  const p = dir + '/journal/signals.jsonl';
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function analyze(signals, label) {
  const opens = signals.filter(s => s.type === 'signal_open');
  const closes = signals.filter(s => s.type === 'signal_close');
  const timeouts = signals.filter(s => s.type === 'signal_timeout');
  const toResolved = signals.filter(s => s.type === 'timeout_resolved');
  
  const wins = closes.filter(s => s.win === true);
  const losses = closes.filter(s => s.win === false);
  const totalPnl = closes.reduce((sum, s) => sum + (s.pnl_usd || 0), 0);
  const wr = (wins.length + losses.length) > 0 
    ? ((wins.length / (wins.length + losses.length)) * 100).toFixed(1)
    : 'n/a';
  
  const avgEntry = opens.length > 0
    ? (opens.reduce((s, o) => s + (o.entry_price || 0), 0) / opens.length).toFixed(3)
    : 'n/a';

  const savedUs = toResolved.filter(s => s.verdict === 'filter_saved_us').length;
  const costUs = toResolved.filter(s => s.verdict === 'filter_cost_us').length;

  return {
    label, opens: opens.length, closes: closes.length,
    wins: wins.length, losses: losses.length, wr,
    totalPnl: totalPnl.toFixed(2), avgEntry,
    timeouts: timeouts.length, toResolved: toResolved.length,
    savedUs, costUs,
    openPositions: opens.length - closes.length,
  };
}

const prodSignals = loadSignals('state');
const shadowSignals = loadSignals('state-${SHADOW_ID}');

const prod = analyze(prodSignals, 'prod');
const shadow = analyze(shadowSignals, '${SHADOW_ID}');

// Load config snapshots
let prodCfg = {}, shadowCfg = {};
try { prodCfg = JSON.parse(fs.readFileSync('state/config-snapshot.json','utf8')); } catch {}
try { shadowCfg = JSON.parse(fs.readFileSync('state-${SHADOW_ID}/config-snapshot.json','utf8')); } catch {}

console.log('=== Runner Comparison: prod vs ${SHADOW_ID} ===');
console.log('');

// Config diff
const diffKeys = ['strategy.min_prob', 'polling.pending_window_seconds', 'strategy.max_prob'];
console.log('Config differences:');
for (const k of diffKeys) {
  const parts = k.split('.');
  const pv = parts.reduce((o, p) => o?.[p], prodCfg) ?? '-';
  const sv = parts.reduce((o, p) => o?.[p], shadowCfg) ?? '-';
  if (pv !== sv) console.log('  ' + k + ': ' + pv + ' → ' + sv);
}
console.log('');

console.log('Metric'.padEnd(25) + 'prod'.padStart(10) + '${SHADOW_ID}'.padStart(15));
console.log('-'.repeat(50));
for (const key of ['opens', 'closes', 'wins', 'losses', 'wr', 'totalPnl', 'avgEntry', 'openPositions', 'timeouts', 'savedUs', 'costUs']) {
  const pv = String(prod[key] ?? '-');
  const sv = String(shadow[key] ?? '-');
  console.log(key.padEnd(25) + pv.padStart(10) + sv.padStart(15));
}
console.log('');

// Per-slug detail for shadow
if (shadowSignals.length > 0) {
  const closedShadow = shadowSignals.filter(s => s.type === 'signal_close');
  if (closedShadow.length > 0) {
    console.log('Shadow trades (detail):');
    for (const c of closedShadow.slice(-10)) {
      const pnl = (c.pnl_usd || 0) >= 0 ? '+\$' + (c.pnl_usd || 0).toFixed(2) : '-\$' + Math.abs(c.pnl_usd || 0).toFixed(2);
      console.log('  ' + (c.win ? 'W' : 'L') + ' ' + pnl + ' | ' + (c.slug || '?'));
    }
  }
}
" 2>&1
