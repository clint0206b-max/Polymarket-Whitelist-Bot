#!/usr/bin/env node

// Esports signal monitor (infra/observability)
// Reads state/watchlist.json runtime.last_signals ring buffer and tracks new esports signals over time.
// Persists progress to state/esports-monitor.json.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, "state", "watchlist.json");
const MON_PATH = path.join(ROOT, "state", "esports-monitor.json");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function isEsportsSignal(s) {
  if (!s) return false;
  if (String(s.league || "") === "esports") return true;
  const slug = String(s.slug || "");
  return /^(lol|cs2|csgo|val|dota2|dota)-/i.test(slug);
}

function keyOf(s) {
  return `${Number(s.ts || 0)}|${String(s.slug || "")}`;
}

function fmtKind(k) {
  const v = String(k || "-");
  if (v === "match_series" || v === "map_specific" || v === "other") return v;
  return "-";
}

function fmtType(t) {
  const v = String(t || "-");
  if (v === "microstructure" || v === "highprob") return v;
  return "-";
}

function tallyInc(obj, k, by = 1) {
  obj[k] = (obj[k] || 0) + by;
}

const state = fs.existsSync(STATE_PATH) ? readJson(STATE_PATH) : null;
if (!state) {
  console.log("NO_STATE");
  process.exit(0);
}

const sigs = Array.isArray(state?.runtime?.last_signals) ? state.runtime.last_signals.slice() : [];
const esports = sigs.filter(isEsportsSignal).sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

const mon = fs.existsSync(MON_PATH)
  ? readJson(MON_PATH)
  : {
      version: 1,
      created_ts: Date.now(),
      last_ts: 0,
      seen_keys: [],
      total_new: 0,
      totals_by_kind: {},
      totals_by_type: {},
      last_new: []
    };

const lastTs = Number(mon.last_ts || 0);
const seen = new Set(Array.isArray(mon.seen_keys) ? mon.seen_keys : []);

const fresh = [];
for (const s of esports) {
  const ts = Number(s.ts || 0);
  if (!ts) continue;
  const k = keyOf(s);
  if (ts > lastTs && !seen.has(k)) fresh.push(s);
}

if (!fresh.length) {
  console.log("NO_NEW");
  process.exit(0);
}

// update monitor
for (const s of fresh) {
  const k = keyOf(s);
  seen.add(k);
  tallyInc(mon.totals_by_kind, fmtKind(s.market_kind), 1);
  tallyInc(mon.totals_by_type, fmtType(s.signal_type), 1);
}

const maxTs = Math.max(lastTs, ...fresh.map(s => Number(s.ts || 0)));
mon.last_ts = maxTs;

mon.total_new = Number(mon.total_new || 0) + fresh.length;
mon.seen_keys = Array.from(seen).slice(-500); // cap to avoid bloat

mon.last_new = fresh.slice(-10).map(s => ({
  ts: Number(s.ts || 0),
  slug: String(s.slug || ""),
  type: fmtType(s.signal_type),
  kind: fmtKind(s.market_kind),
  near_by: String(s.near_by || "-"),
  ask: Number(s.probAsk ?? null),
  spr: Number(s.spread ?? null)
}));

writeJson(MON_PATH, mon);

const kinds = Object.entries(mon.totals_by_kind || {}).sort((a, b) => b[1] - a[1]);
const types = Object.entries(mon.totals_by_type || {}).sort((a, b) => b[1] - a[1]);

console.log(
  `NEW_ESPORTS_SIGNALS n=${fresh.length} total_collected=${mon.total_new} ` +
    `kinds=${JSON.stringify(Object.fromEntries(kinds))} ` +
    `types=${JSON.stringify(Object.fromEntries(types))}`
);
for (const row of mon.last_new) console.log(`- ${row.ts} ${row.slug} | type=${row.type} kind=${row.kind} near_by=${row.near_by} ask=${row.ask} spr=${row.spr}`);
