import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./src/core/config.js";
import { is_near_signal_margin } from "./src/strategy/stage1.mjs";
import { is_depth_sufficient } from "./src/strategy/stage2.mjs";

function fmtNum(x, digits = 3) {
  if (x == null || !Number.isFinite(Number(x))) return "n/a";
  const n = Number(x);
  return n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtUsd(x) {
  if (x == null || !Number.isFinite(Number(x))) return "n/a";
  const n = Number(x);
  if (n >= 1000) return `$${Math.round(n)}`;
  return `$${Math.round(n * 10) / 10}`;
}

function sumBuckets(node) {
  const out = {};
  const buckets = node?.buckets;
  if (!Array.isArray(buckets)) return out;
  for (const b of buckets) {
    const counts = b?.counts || {};
    for (const [k, v] of Object.entries(counts)) out[k] = (out[k] || 0) + Number(v || 0);
  }
  return out;
}

function pickTopCandidates(state, cfg, { limit, strictFreshness }) {
  const wl = state.watchlist || {};
  const now = Date.now();
  const evalSec = Number(cfg?.polling?.clob_eval_seconds || state?.polling?.clob_eval_seconds || 3);
  const freshnessMs = Math.max(5000, 2 * evalSec * 1000);
  const stage1WindowMs = 5 * 60 * 1000;

  let bestCompleteQuoteAgeMs = null;

  const rows = [];
  for (const m of Object.values(wl)) {
    if (!m) continue;
    if (!(m.status === "watching" || m.status === "pending_signal")) continue;
    if (m.status === "signaled") continue;

    const lp = m.last_price;
    if (!lp) continue;
    if (lp.yes_best_ask == null || lp.yes_best_bid == null) continue;
    if (lp.spread == null) continue;

    const ageMs = now - Number(lp.updated_ts || 0);
    if (ageMs >= 0) {
      bestCompleteQuoteAgeMs = bestCompleteQuoteAgeMs == null ? ageMs : Math.min(bestCompleteQuoteAgeMs, ageMs);
    }

    if (strictFreshness) {
      if (!(ageMs >= 0 && ageMs <= freshnessMs)) continue;
    }

    // stage1 seen recently (per-market)
    const s1ts = Number(m.stage1?.last_eval_ts || 0);
    if (!s1ts || (now - s1ts) > stage1WindowMs) continue;

    const probAsk = Number(lp.yes_best_ask);
    const probBid = Number(lp.yes_best_bid);
    const spread = Number(lp.spread);

    const liq = m.liquidity || {};
    const exitDepth = Number(liq.exit_depth_usd_bid || 0);
    const lastSeen = Number(m.last_seen_ts || 0);

    rows.push({
      slug: String(m.slug || ""),
      status: m.status,
      probAsk,
      probBid,
      spread,
      entryDepth: liq.entry_depth_usd_ask ?? null,
      exitDepth: liq.exit_depth_usd_bid ?? null,
      quoteAgeMs: ageMs,
      lastSeen,
      primaryRejectLast: m.last_reject?.reason || "-",
      stale: !strictFreshness
    });
  }

  // Deterministic ranking:
  // - probAsk desc
  // - spread asc
  // - exit_depth desc
  // - quote_age asc (fresher first)  [only relevant for stale list]
  // - last_seen desc (only as late tie-break)
  // - slug asc
  rows.sort((a, b) =>
    (b.probAsk - a.probAsk) ||
    (a.spread - b.spread) ||
    (b.exitDepth - a.exitDepth) ||
    (a.quoteAgeMs - b.quoteAgeMs) ||
    (b.lastSeen - a.lastSeen) ||
    a.slug.localeCompare(b.slug)
  );

  return {
    rows: rows.slice(0, limit),
    freshnessMs,
    bestCompleteQuoteAgeMs
  };
}

function epsCfg(cfg) {
  return Number(cfg?.filters?.EPS || 1e-6);
}

function inBaseRangeAsk(ask, cfg) {
  const EPS = epsCfg(cfg);
  const minProb = Number(cfg?.filters?.min_prob ?? 0.94);
  const maxEntry = Number(cfg?.filters?.max_entry_price ?? 0.97);
  return (Number(ask) + EPS) >= minProb && (Number(ask) - EPS) <= maxEntry;
}

function spreadPass(spread, cfg) {
  const EPS = epsCfg(cfg);
  const maxSpread = Number(cfg?.filters?.max_spread ?? 0.02);
  return (Number(spread) - EPS) <= maxSpread;
}

function funnelStats(rows, cfg) {
  const baseMin = Number(cfg?.filters?.min_prob ?? 0.94);
  const baseMax = Number(cfg?.filters?.max_entry_price ?? 0.97);
  const spreadMax = Number(cfg?.filters?.max_spread ?? 0.02);
  const nearMin = Number(cfg?.filters?.near_prob_min ?? 0.945);
  const nearSpreadMax = Number(cfg?.filters?.near_spread_max ?? 0.015);

  const inBaseRange = rows.filter(r => inBaseRangeAsk(r.probAsk, cfg)).length;
  const passSpreadN = rows.filter(r => spreadPass(r.spread, cfg)).length;
  const passNear = rows.filter(r => (Number(r.probAsk) + epsCfg(cfg)) >= nearMin || (Number(r.spread) - epsCfg(cfg)) <= nearSpreadMax).length;

  return { inBaseRange, passSpread: passSpreadN, passNear, baseMin, baseMax, spreadMax, nearMin, nearSpreadMax };
}

const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

function readArgValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const lastSignalsN = (() => {
  const raw = readArgValue("--last-signals");
  if (raw == null) return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : 5;
})();

const cfg = loadConfig();
const statePath = path.resolve(process.cwd(), "state", "watchlist.json");
if (!fs.existsSync(statePath)) {
  console.error(`state not found: ${statePath}`);
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const health = state?.runtime?.health || {};

const reject5 = sumBuckets(health?.buckets?.reject);
const health5 = sumBuckets(health?.buckets?.health);

const oneSided = Number(reject5.quote_incomplete_one_sided_book || 0);
const stage1Eval = Number(health5.stage1_evaluated || 0);
const denom = oneSided + stage1Eval;
const oneSidedRatio = denom ? (oneSided / denom) : null;

const strict = pickTopCandidates(state, cfg, { limit: verbose ? 20 : 10, strictFreshness: true });

console.log(`Top ${strict.rows.length} candidates (quote complete + fresh<=${strict.freshnessMs}ms + stage1_seen<=5min):`);
if (!strict.rows.length) {
  const bestAge = strict.bestCompleteQuoteAgeMs;
  console.log(`No fresh quotes in snapshot. Showing stale quotes. Freshness threshold: ${strict.freshnessMs}ms. Best quote age: ${bestAge == null ? "n/a" : `${Math.round(bestAge)}ms`}.`);

  const stale = pickTopCandidates(state, cfg, { limit: verbose ? 20 : 10, strictFreshness: false });
  if (!stale.rows.length) {
    console.log("(none)");
  } else {
    let i = 1;
    for (const r of stale.rows) {
      console.log(
        `${String(i).padStart(2, " ")}) ${r.slug} | ${r.status}` +
        ` | ask=${fmtNum(r.probAsk, 3)} bid=${fmtNum(r.probBid, 3)} spr=${fmtNum(r.spread, 3)}` +
        ` | entry=${fmtUsd(r.entryDepth)} exit=${fmtUsd(r.exitDepth)}` +
        ` | stale=true age_ms=${Math.round(r.quoteAgeMs)}` +
        ` | lastReject=${r.primaryRejectLast}`
      );
      i++;
    }
  }
} else {
  let i = 1;
  for (const r of strict.rows) {
    console.log(
      `${String(i).padStart(2, " ")}) ${r.slug} | ${r.status}` +
      ` | ask=${fmtNum(r.probAsk, 3)} bid=${fmtNum(r.probBid, 3)} spr=${fmtNum(r.spread, 3)}` +
      ` | entry=${fmtUsd(r.entryDepth)} exit=${fmtUsd(r.exitDepth)}` +
      ` | age=${Math.round(r.quoteAgeMs)}ms` +
      ` | lastReject=${r.primaryRejectLast}`
    );
    i++;
  }
}

if (verbose) {
  // Use whichever list is currently displayed
  const displayed = strict.rows.length ? strict.rows : pickTopCandidates(state, cfg, { limit: 20, strictFreshness: false }).rows;
  const f = funnelStats(displayed, cfg);
  console.log("\nVerbose funnel (within displayed top rows):");
  console.log(`- baseRange [${f.baseMin}, ${f.baseMax}] => ${f.inBaseRange}/${displayed.length}`);
  console.log(`- spread<=${f.spreadMax} => ${f.passSpread}/${displayed.length}`);
  console.log(`- near (ask>=${f.nearMin} OR spread<=${f.nearSpreadMax}) => ${f.passNear}/${displayed.length}`);

  console.log("\nOne-sided vs Stage1 (rolling last_5min buckets):");
  console.log(`- quote_incomplete_one_sided_book: ${oneSided}`);
  console.log(`- stage1_evaluated: ${stage1Eval}`);
  console.log(`- one_sided_ratio_last_5min: ${oneSidedRatio == null ? "n/a" : fmtNum(oneSidedRatio, 3)}`);

  // Global funnel (rolling last_5min buckets, no freshness gate)
  console.log(`\nGamma fetch health (runtime):`);
  console.log(`- gamma_fetch_count: ${Number(health.gamma_fetch_count || 0)}`);
  console.log(`- gamma_fetch_fail_count: ${Number(health.gamma_fetch_fail_count || 0)}`);
  console.log(`- gamma_fetch_timeout_count: ${Number(health.gamma_fetch_timeout_count || 0)}`);
  console.log(`- gamma_fetch_duration_ms_last: ${Number(health.gamma_fetch_duration_ms_last || 0)}`);

  console.log("\nGlobal funnel (rolling last_5min, engine-level, no freshness):");
  console.log(`- eval_ticks: ${Number(health5.eval_tick || 0)}`);
  console.log(`- state_writes: ${Number(health5.state_write || 0)}`);
  console.log(`- quote_update: ${Number(health5.quote_update || 0)}`);
  console.log(`- quote_complete: ${Number(health5.quote_complete || 0)}`);
  console.log(`- base_range_pass: ${Number(health5.base_range_pass || 0)}`);
  console.log(`- spread_pass: ${Number(health5.spread_pass || 0)}`);
  console.log(`- near_margin_pass: ${Number(health5.near_margin_pass || 0)}`);
  console.log(`- depth_pass: ${Number(health5.depth_pass || 0)}`);
  console.log(`- hot_candidate: ${Number(health5.hot_candidate || 0)}`);
  console.log(`- hot_candidate_relaxed: ${Number(health5.hot_candidate_relaxed || 0)}`);

  console.log("\nSignals by market_kind (rolling last_5min, esports-only; others counted as other):");
  console.log(`- pending_enter_match_series: ${Number(health5.pending_enter_match_series || 0)}`);
  console.log(`- pending_enter_map_specific: ${Number(health5.pending_enter_map_specific || 0)}`);
  console.log(`- pending_enter_other: ${Number(health5.pending_enter_other || 0)}`);
  console.log(`- signaled_match_series: ${Number(health5.signaled_match_series || 0)}`);
  console.log(`- signaled_map_specific: ${Number(health5.signaled_map_specific || 0)}`);
  console.log(`- signaled_other: ${Number(health5.signaled_other || 0)}`);

  console.log(`\nTP math (rolling last_5min, dry-run at candidate stage):`);
  console.log(`- tp_math_eval_candidates: ${Number(health5.tp_math_eval_candidates || 0)}`);
  console.log(`- tp_math_allowed_candidates: ${Number(health5.tp_math_allowed_candidates || 0)}`);
  console.log(`- tp_math_rejected_candidates: ${Number(health5.tp_math_rejected_candidates || 0)}`);

  console.log(`\n- context_cbb_decided_pass: ${Number(health5.context_cbb_decided_pass || 0)}`);
  console.log(`- context_nba_decided_pass: ${Number(health5.context_nba_decided_pass || 0)}`);
  console.log(`- signaled_and_context_decided: ${Number(health5.signaled_and_context_decided || 0)}`);
  console.log(`- signaled_and_context_cbb_decided: ${Number(health5.signaled_and_context_cbb_decided || 0)}`);
  console.log(`- signaled_and_context_nba_decided: ${Number(health5.signaled_and_context_nba_decided || 0)}`);

  console.log("\nContext CBB (rolling last_5min):");
  const ctxKeys = [
    "context_cbb_fetch_days_3",
    "context_cbb_fetch_ok",
    "context_cbb_fetch_fail",
    "context_cbb_fetch_empty_events",
    "context_cbb_fetch_parse_fail",

    "context_cbb_cache_hit",
    "context_cbb_cache_miss",
    "context_cbb_cache_hit_by_dateKey",
    "context_cbb_cache_miss_by_dateKey",

    "context_cbb_games_total",
    "context_cbb_games_unique",

    "context_cbb_tag_attempt",
    "context_cbb_tag_skipped_no_cache",
    "context_cbb_tag_skipped_missing_market_date",
    "context_cbb_tag_skipped_date_too_far",

    "context_cbb_match_teamsKey_exact",
    "context_cbb_match_legacy_exact",
    "context_cbb_match_legacy_alias",
    "context_cbb_match_exact",
    "context_cbb_match_alias",
    "context_cbb_match_no_match",
    "context_cbb_match_ambiguous",

    "context_cbb_tag_with_fresh_ctx",
    "context_cbb_tag_with_stale_ctx"
  ];
  for (const k of ctxKeys) console.log(`- ${k}: ${Number(health5[k] || 0)}`);

  console.log("\nContext NBA (rolling last_5min):");
  const nbaKeys = [
    "context_nba_fetch_days_3",
    "context_nba_fetch_ok",
    "context_nba_fetch_fail",
    "context_nba_fetch_empty_events",
    "context_nba_fetch_parse_fail",

    "context_nba_cache_hit",
    "context_nba_cache_miss",
    "context_nba_cache_hit_by_dateKey",
    "context_nba_cache_miss_by_dateKey",

    "context_nba_games_total",
    "context_nba_games_unique",

    "context_nba_tag_attempt",
    "context_nba_tag_skipped_no_cache",
    "context_nba_tag_skipped_missing_market_date",
    "context_nba_tag_skipped_date_too_far",

    "context_nba_match_teamsKey_exact",
    "context_nba_match_legacy_exact",
    "context_nba_match_legacy_alias",
    "context_nba_match_no_match",
    "context_nba_match_ambiguous",

    "context_nba_tag_with_fresh_ctx",
    "context_nba_tag_with_stale_ctx"
  ];
  for (const k of nbaKeys) console.log(`- ${k}: ${Number(health5[k] || 0)}`);
  console.log(`- cooldown_active_while_hot: ${Number(health5.cooldown_active_while_hot || 0)}`);
  console.log(`- pending_enter: ${Number(health5.pending_enter || 0)}`);
  console.log(`- pending_enter_microstructure: ${Number(health5.pending_enter_microstructure || 0)}`);
  console.log(`- pending_enter_highprob: ${Number(health5.pending_enter_highprob || 0)}`);
  console.log(`- pending_second_check: ${Number(health5.pending_second_check || 0)}`);
  console.log(`- pending_promoted: ${Number(health5.pending_promoted || 0)}`);
  console.log(`- pending_timeout: ${Number(health5.pending_timeout || 0)}`);
  console.log(`- pending_enter_then_timeout_same_tick: ${Number(health5.pending_enter_then_timeout_same_tick || 0)}`);
  console.log(`- pending_enter_with_deadline_in_past: ${Number(health5.pending_enter_with_deadline_in_past || 0)}`);
  console.log(`- pending_enter_with_null_since: ${Number(health5.pending_enter_with_null_since || 0)}`);

  const ageSum = Number(health5.pending_age_sum_ms || 0);
  const ageCnt = Number(health5.pending_age_count || 0);
  const avgAge = ageCnt ? (ageSum / ageCnt) : null;
  console.log(`- avg_pending_age_ms_at_eval: ${avgAge == null ? "n/a" : Math.round(avgAge)}`);

  console.log(`- signaled: ${Number(health5.signaled || 0)}`);
  console.log(`- signaled_microstructure: ${Number(health5.signaled_microstructure || 0)}`);
  console.log(`- signaled_highprob: ${Number(health5.signaled_highprob || 0)}`);

  console.log("\nRuntime tick/write timestamps:");
  console.log(`- runtime.last_eval_tick_ts: ${state?.runtime?.health?.last_eval_tick_ts || "n/a"}`);
  console.log(`- runtime.last_state_write_ts: ${state?.runtime?.last_state_write_ts || "n/a"}`);

  // Pending snapshots (persisted)
  console.log("\nRuntime snapshots:");
  console.log(`- last_pending_enter: ${state?.runtime?.last_pending_enter ? JSON.stringify(state.runtime.last_pending_enter) : "null"}`);
  console.log(`- last_pending_timeout: ${state?.runtime?.last_pending_timeout ? JSON.stringify(state.runtime.last_pending_timeout) : "null"}`);
  console.log(`- last_context_cbb_fetch: ${state?.runtime?.last_context_cbb_fetch ? JSON.stringify(state.runtime.last_context_cbb_fetch) : "null"}`);

  const nm = Array.isArray(state?.runtime?.last_context_cbb_no_match_examples) ? state.runtime.last_context_cbb_no_match_examples : [];
  console.log(`- last_context_cbb_no_match_examples_count: ${nm.length}`);

  const sigs = Array.isArray(state?.runtime?.last_signals) ? state.runtime.last_signals : [];
  console.log(`- last_signals_count: ${sigs.length}`);
  if (sigs.length) {
    console.log(`\nLast ${lastSignalsN} signals:`);
    // index watchlist by slug for context
    const bySlugForCtx = new Map();
    for (const m of Object.values(state.watchlist || {})) {
      if (!m?.slug) continue;
      const s = String(m.slug);
      const prev = bySlugForCtx.get(s);
      if (!prev || Number(m.last_seen_ts || 0) > Number(prev.last_seen_ts || 0)) bySlugForCtx.set(s, m);
    }

    for (const s of sigs.slice(-lastSignalsN).reverse()) {
      const ctx = s.ctx || null;
      let ctxStr = "ctx=none";
      if (ctx && ctx.provider === "espn" && (ctx.sport === "cbb" || ctx.sport === "nba")) {
        const sport = ctx.sport;
        if (ctx.fresh === false) ctxStr = `ctx=${sport}:stale ctx_age_ms=${ctx.ctx_age_ms == null ? "n/a" : Math.round(ctx.ctx_age_ms)}`;
        else if (ctx.decided_pass === true) ctxStr = `ctx=${sport}:decided margin=+${ctx.margin} min_left=${fmtNum(ctx.minutes_left, 1)} ctx_age_ms=${ctx.ctx_age_ms == null ? "n/a" : Math.round(ctx.ctx_age_ms)}`;
        else if (ctx.decided_pass === false) ctxStr = `ctx=${sport}:not_decided margin=+${ctx.margin} min_left=${fmtNum(ctx.minutes_left, 1)} ctx_age_ms=${ctx.ctx_age_ms == null ? "n/a" : Math.round(ctx.ctx_age_ms)}`;
        else ctxStr = `ctx=${sport}:unknown ctx_age_ms=${ctx.ctx_age_ms == null ? "n/a" : Math.round(ctx.ctx_age_ms)}`;
      }

      // esports ctx short string
      let eStr = "";
      if (s.esports && typeof s.esports === "object") {
        const e = s.esports;
        const bo = (e.series_format === "bo3" ? "bo3" : (e.series_format === "bo5" ? "bo5" : "bo?"));
        const sc = (e.maps_a != null && e.maps_b != null) ? `${e.maps_a}-${e.maps_b}` : "?-?";
        const gs = String(e.guard_status || "unknown");
        const gr = String(e.guard_reason || "unknown");
        eStr = ` | esports=${bo} score=${sc} guard=${gs}:${gr}`;
      }

      console.log(
        `- ts=${s.ts} ${s.slug}` +
        ` | type=${s.signal_type}` +
        ` | ask=${fmtNum(s.probAsk, 3)} spr=${fmtNum(s.spread, 3)}` +
        ` | entry=${fmtUsd(s.entryDepth)} exit=${fmtUsd(s.exitDepth)}` +
        ` | near_by=${s.near_by}` +
        ` | base_range_pass=${s.base_range_pass ? "true" : "false"}` +
        ` | kind=${s.market_kind || "-"}` +
        eStr +
        ` | ${ctxStr}`
      );
    }
  }

  // Triggered hot candidates snapshot (persisted in state)
  const hot = Array.isArray(state?.runtime?.last_hot_candidates) ? state.runtime.last_hot_candidates : [];
  console.log("\nTriggered snapshot: last_hot_candidates (max 5):");
  if (!hot.length) {
    console.log("(none)");
  } else {
    for (const r of hot) {
      console.log(
        `- ${r.slug} | ${r.status}` +
        ` | ask=${fmtNum(r.probAsk, 3)} spr=${fmtNum(r.spread, 3)}` +
        ` | entry=${fmtUsd(r.entry_depth_usd_ask)} exit=${fmtUsd(r.exit_depth_usd_bid)}` +
        ` | lastReject=${r.last_reject}`
      );
    }
  }

  // Block new: Top 5 hot candidates (relaxed price band)
  const hotRAll = Array.isArray(state?.runtime?.last_hot_candidates_relaxed) ? state.runtime.last_hot_candidates_relaxed : [];

  // index watchlist by slug for extra fields (pending/cooldown remaining)
  const bySlug = new Map();
  for (const m of Object.values(state.watchlist || {})) {
    if (!m?.slug) continue;
    const s = String(m.slug);
    const prev = bySlug.get(s);
    if (!prev || Number(m.last_seen_ts || 0) > Number(prev.last_seen_ts || 0)) bySlug.set(s, m);
  }

  const nowTs = Date.now();
  const pendingWinMs = Number(cfg?.polling?.pending_window_seconds || 6) * 1000;

  const maxAgeDisplayMs = 10 * 60 * 1000; // 10 min
  const hotRecent = hotRAll.filter(r => {
    const ts = Number(r?.ts || 0);
    if (!ts) return false;
    const age = nowTs - ts;
    return age >= 0 && age <= maxAgeDisplayMs;
  });

  console.log(`\nTriggered snapshot (relaxed). max_age_display_ms=${maxAgeDisplayMs}. showing ${hotRecent.length}/${hotRAll.length}.`);
  console.log("Top 5 hot candidates (relaxed price band; spread+near+depth):");
  if (!hotRecent.length) {
    console.log("(none)");
  } else {
    for (const r of hotRecent.slice(0, 5)) {
      const quoteAgeMs = r.quote_ts ? (nowTs - Number(r.quote_ts)) : null;
      const ts = Number(r.ts || 0);
      const ageSinceRecordedMs = ts ? (nowTs - ts) : null;

      const m = bySlug.get(String(r.slug)) || null;

      let pendingRem = null;
      if (m?.status === "pending_signal") {
        const dl = Number(m.pending_deadline_ts || 0);
        const ps = Number(m.pending_since_ts || 0);
        const deadline = (dl && Number.isFinite(dl)) ? dl : (ps ? (ps + pendingWinMs) : 0);
        if (deadline) pendingRem = Math.max(0, deadline - nowTs);
      }

      const cdUntil = Number(m?.cooldown_until_ts || 0);
      const cdRem = cdUntil ? Math.max(0, cdUntil - nowTs) : 0;
      const isBlocked = cdRem > 0;

      const EPS = Number(cfg?.filters?.EPS || 1e-6);
      const nearProbMin = Number(cfg?.filters?.near_prob_min ?? 0.945);
      const nearSpreadMax = Number(cfg?.filters?.near_spread_max ?? 0.015);
      const askOk = (Number(r.probAsk) + EPS) >= nearProbMin;
      const spreadOk = (Number(r.spread) - EPS) <= nearSpreadMax;
      const nearPass = askOk || spreadOk;
      const nearBy = (askOk && spreadOk) ? "both" : (askOk ? "ask" : (spreadOk ? "spread" : "none"));

      console.log(
        `- ${r.slug} | ${m?.status || r.status}` +
        ` | ask=${fmtNum(r.probAsk, 3)} bid=${fmtNum(r.probBid, 3)} spr=${fmtNum(r.spread, 3)}` +
        ` | entry=${fmtUsd(r.entry_depth_usd_ask)} exit=${fmtUsd(r.exit_depth_usd_bid)}` +
        ` | base_range_pass=${r.base_range_pass ? "true" : "false"}` +
        ` | near_pass=${nearPass ? "true" : "false"} near_by=${nearBy}` +
        ` | ts=${ts || "n/a"}` +
        ` | age_since_recorded_ms=${ageSinceRecordedMs == null ? "n/a" : Math.round(ageSinceRecordedMs)}` +
        ` | lastReject=${(m?.last_reject?.reason || r.last_reject)}` +
        ` | quote_age_ms=${quoteAgeMs == null ? "n/a" : Math.round(quoteAgeMs)}` +
        ` | pending_window_remaining_ms=${pendingRem == null ? "n/a" : Math.round(pendingRem)}` +
        ` | cooldown_remaining_ms=${Math.round(cdRem)}` +
        ` | is_blocked=${isBlocked ? "true" : "false"}`
      );
    }
  }

  // Pending confirm failure breakdown (rolling last_5min)
  const getH = (k) => Number(health5[k] || 0);
  const orderedPendingReasons = [
    "pending_confirm_fail:fail_http_fallback_failed",
    "pending_confirm_fail:fail_quote_incomplete",
    "pending_confirm_fail:fail_base_price_out_of_range",
    "pending_confirm_fail:fail_spread_above_max",
    "pending_confirm_fail:fail_near_margin",
    "pending_confirm_fail:fail_depth_bid_below_min",
    "pending_confirm_fail:fail_depth_ask_below_min",
    "pending_timeout"
  ];

  console.log("\nPending confirm fail (rolling last_5min, fixed order):");
  for (const k of orderedPendingReasons) {
    const label = k.startsWith("pending_confirm_fail:") ? k.replace("pending_confirm_fail:", "") : k;
    console.log(`- ${label}: ${getH(k)}`);
  }

  // Optional: top 2 non-zero (quick glance)
  const pendingFailPairs = orderedPendingReasons
    .filter(k => k.startsWith("pending_confirm_fail:"))
    .map(k => [k.replace("pending_confirm_fail:", ""), getH(k)])
    .filter(([,v]) => v > 0)
    .sort((a,b) => b[1]-a[1]);
  if (pendingFailPairs.length) {
    console.log("\nPending confirm fail (rolling last_5min, top 2 non-zero):");
    for (const [r, c] of pendingFailPairs.slice(0,2)) console.log(`- ${r}: ${c}`);
  }

  // ---- Advanced debug blocks (pure observability; no strategy changes) ----
  const now = Date.now();
  const stage1WindowMs = 5 * 60 * 1000;
  const minEntry = Number(cfg?.filters?.min_entry_depth_usd_ask || 1000);
  const minExit = Number(cfg?.filters?.min_exit_depth_usd_bid || 2000);

  const wl = state.watchlist || {};
  const baseRows = [];
  const depthFailRows = [];
  const oneStepRows = [];

  for (const m of Object.values(wl)) {
    if (!m) continue;
    if (!(m.status === "watching" || m.status === "pending_signal")) continue;
    if (m.status === "signaled") continue;

    const lp = m.last_price;
    if (!lp) continue;
    if (lp.yes_best_ask == null || lp.yes_best_bid == null || lp.spread == null) continue;

    const s1ts = Number(m.stage1?.last_eval_ts || 0);
    if (!s1ts || (now - s1ts) > stage1WindowMs) continue;

    const ask = Number(lp.yes_best_ask);
    const bid = Number(lp.yes_best_bid);
    const spread = Number(lp.spread);
    const age = now - Number(lp.updated_ts || 0);

    const baseRange = inBaseRangeAsk(ask, cfg);
    const sprPass = spreadPass(spread, cfg);
    const nearPass = !!is_near_signal_margin({ probAsk: ask, probBid: bid, spread }, cfg);

    const liq = m.liquidity || {};
    const metrics = {
      entry_depth_usd_ask: liq.entry_depth_usd_ask ?? 0,
      exit_depth_usd_bid: liq.exit_depth_usd_bid ?? 0
    };
    const hasDepth = liq.entry_depth_usd_ask != null && liq.exit_depth_usd_bid != null;
    const depthEval = hasDepth ? is_depth_sufficient(metrics, cfg) : { pass: false, reason: "no_depth_snapshot" };

    if (baseRange) {
      baseRows.push({
        slug: m.slug,
        ask,
        bid,
        spread,
        entry: liq.entry_depth_usd_ask ?? null,
        exit: liq.exit_depth_usd_bid ?? null,
        nearPass,
        depthPass: depthEval.pass,
        lastReject: m.last_reject?.reason || "-",
        age
      });
    }

    if (baseRange && sprPass && nearPass && hasDepth && !depthEval.pass) {
      depthFailRows.push({
        slug: m.slug,
        ask,
        spread,
        entry: liq.entry_depth_usd_ask ?? null,
        exit: liq.exit_depth_usd_bid ?? null,
        reason: depthEval.reason,
        age
      });
    }

    // "One step" means: would enter pending if re-evaluated now (passes Stage1 base+spread, near margin, and depth)
    if (m.status === "watching" && baseRange && sprPass && nearPass && hasDepth && depthEval.pass) {
      oneStepRows.push({
        slug: m.slug,
        ask,
        spread,
        entry: liq.entry_depth_usd_ask ?? null,
        exit: liq.exit_depth_usd_bid ?? null,
        lastReject: m.last_reject?.reason || "-",
        age
      });
    }
  }

  // Block A
  baseRows.sort((a, b) =>
    (b.ask - a.ask) ||
    (a.spread - b.spread) ||
    (Number(b.exit || 0) - Number(a.exit || 0)) ||
    (Number(b.entry || 0) - Number(a.entry || 0)) ||
    (a.age - b.age) ||
    String(a.slug).localeCompare(String(b.slug))
  );

  console.log("\nBlock A — Top 5 inside base range (quote complete):");
  for (const r of baseRows.slice(0, 5)) {
    console.log(
      `- ${r.slug}` +
      ` | ask=${fmtNum(r.ask, 3)} bid=${fmtNum(r.bid, 3)} spr=${fmtNum(r.spread, 3)}` +
      ` | entry=${fmtUsd(r.entry)} exit=${fmtUsd(r.exit)}` +
      ` | near=${r.nearPass ? "true" : "false"}` +
      ` | depth=${r.depthPass ? "true" : "false"}` +
      ` | age_ms=${Math.round(r.age)}` +
      ` | lastReject=${r.lastReject}`
    );
  }
  if (!baseRows.length) console.log("(none)");

  // Block B
  depthFailRows.sort((a, b) =>
    (Number(a.exit || 0) - Number(b.exit || 0)) ||
    (Number(a.entry || 0) - Number(b.entry || 0)) ||
    (b.ask - a.ask) ||
    (a.spread - b.spread) ||
    String(a.slug).localeCompare(String(b.slug))
  );

  console.log("\nBlock B — Top 5 depth fails (passed base+spread+near):");
  for (const r of depthFailRows.slice(0, 5)) {
    console.log(
      `- ${r.slug}` +
      ` | ask=${fmtNum(r.ask, 3)} spr=${fmtNum(r.spread, 3)}` +
      ` | entry=${fmtUsd(r.entry)}/${fmtUsd(minEntry)} exit=${fmtUsd(r.exit)}/${fmtUsd(minExit)}` +
      ` | fail=${r.reason}` +
      ` | age_ms=${Math.round(r.age)}`
    );
  }
  if (!depthFailRows.length) console.log("(none)");

  // Block C
  oneStepRows.sort((a, b) =>
    (b.ask - a.ask) ||
    (a.spread - b.spread) ||
    String(a.slug).localeCompare(String(b.slug))
  );

  console.log("\nBlock C — Top 5 one-step from pending (near+depth pass, status=watching):");
  for (const r of oneStepRows.slice(0, 5)) {
    console.log(
      `- ${r.slug}` +
      ` | ask=${fmtNum(r.ask, 3)} spr=${fmtNum(r.spread, 3)}` +
      ` | entry=${fmtUsd(r.entry)} exit=${fmtUsd(r.exit)}` +
      ` | age_ms=${Math.round(r.age)}` +
      ` | lastReject=${r.lastReject}`
    );
  }
  if (!oneStepRows.length) console.log("(none)");
}

