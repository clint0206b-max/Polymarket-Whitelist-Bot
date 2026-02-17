/**
 * Daily event utilization tracker.
 *
 * Tracks per-league, per-day: how many live events existed,
 * how many had tradeable markets, how many generated signals,
 * and top reasons for missed events.
 *
 * State: state/daily_events.json
 * Keyed by date (YYYY-MM-DD) → league → event_id → metrics.
 */

import fs from "node:fs";
import { resolvePath } from "../core/state_store.js";

const STATE_PATH = resolvePath("state", "daily_events.json");

/** Load daily events state (or empty). */
export function loadDailyEvents() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Save daily events state. */
export function saveDailyEvents(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Purge date keys older than maxDays from daily events state.
 * @param {object} state - daily_events state
 * @param {number} maxDays - max age in days (default 7)
 * @returns {number} number of purged date keys
 */
export function purgeStaleDates(state, maxDays = 7) {
  if (!state || typeof state !== "object") return 0;
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - maxDays);
  let purged = 0;
  for (const dateKey of Object.keys(state)) {
    // Only purge keys that look like dates (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
    const d = new Date(dateKey + "T00:00:00Z");
    if (d < cutoff) {
      delete state[dateKey];
      purged++;
    }
  }
  return purged;
}

/**
 * Get or create event entry for today.
 * @param {object} state - daily_events state
 * @param {string} dateKey - YYYY-MM-DD
 * @param {string} league - cbb|nba|esports
 * @param {string} eventId - Gamma event_id or event_slug
 * @returns {object} reference to the event entry (mutate in place)
 */
function getEvent(state, dateKey, league, eventId) {
  if (!state[dateKey]) state[dateKey] = {};
  if (!state[dateKey][league]) state[dateKey][league] = {};
  if (!state[dateKey][league][eventId]) {
    state[dateKey][league][eventId] = {
      first_seen_ts: Date.now(),
      last_seen_ts: Date.now(),
      tick_count: 0,
      // Highest watermark per market in this event
      markets_seen: 0,
      had_quote: false,
      had_two_sided: false,
      had_tradeable: false,    // passed base+spread+depth
      had_signal: false,       // generated a signal
      had_context_entry: false, // context entry gate evaluated
      context_entry_allowed: false,
      // Reject reason tallies (across all markets in event)
      reject_reasons: {},
      // Market slugs seen (for dedup)
      market_slugs: [],
      // Price tracking per market slug: { slug: { max_bid, max_bid_ts, first_cross_ts, first_cross_price } }
      market_prices: {},
    };
  }
  return state[dateKey][league][eventId];
}

/**
 * Record a market evaluation tick for an event.
 * Call once per market per eval cycle from loop_eval.
 *
 * @param {object} state - daily_events state
 * @param {string} dateKey - YYYY-MM-DD
 * @param {object} info - { league, event_id, slug, had_quote, had_two_sided,
 *   had_tradeable, had_signal, reject_reason, context_entry_evaluated,
 *   context_entry_allowed }
 */
export function recordMarketTick(state, dateKey, info) {
  const {
    league, event_id, slug,
    had_quote = false,
    had_two_sided = false,
    had_tradeable = false,
    had_signal = false,
    reject_reason = null,
    context_entry_evaluated = false,
    context_entry_allowed = false,
    yes_best_bid = null,
    entry_threshold = 0.93,
  } = info;

  if (!league || !event_id) return;

  const ev = getEvent(state, dateKey, league, String(event_id));
  ev.last_seen_ts = Date.now();
  ev.tick_count++;

  // Track unique market slugs
  if (slug && !ev.market_slugs.includes(slug)) {
    ev.market_slugs.push(slug);
    ev.markets_seen = ev.market_slugs.length;
  }

  // Watermarks (once true, stays true)
  if (had_quote) ev.had_quote = true;
  if (had_two_sided) ev.had_two_sided = true;
  if (had_tradeable) ev.had_tradeable = true;
  if (had_signal) ev.had_signal = true;
  if (context_entry_evaluated) ev.had_context_entry = true;
  if (context_entry_allowed) ev.context_entry_allowed = true;

  // Reject reasons (increment)
  if (reject_reason) {
    ev.reject_reasons[reject_reason] = (ev.reject_reasons[reject_reason] || 0) + 1;
  }

  // Price tracking per market slug
  if (slug && yes_best_bid != null && Number.isFinite(yes_best_bid)) {
    if (!ev.market_prices) ev.market_prices = {};
    const mp = ev.market_prices[slug] || { max_bid: 0, max_bid_ts: null, first_cross_ts: null, first_cross_price: null };
    const now = Date.now();
    
    if (yes_best_bid > mp.max_bid) {
      mp.max_bid = yes_best_bid;
      mp.max_bid_ts = now;
    }
    
    // Track first time bid crosses entry threshold
    if (yes_best_bid >= entry_threshold && !mp.first_cross_ts) {
      mp.first_cross_ts = now;
      mp.first_cross_price = yes_best_bid;
    }
    
    ev.market_prices[slug] = mp;
  }
}

/**
 * Get summary for a date + league.
 * @param {object} state
 * @param {string} dateKey
 * @param {string} league
 * @returns {object} { total, with_quote, with_two_sided, with_tradeable, with_signal,
 *   with_context_entry, with_context_allowed, missed, top_miss_reasons }
 */
export function getSummary(state, dateKey, league) {
  const events = state?.[dateKey]?.[league] || {};
  const entries = Object.values(events);
  const total = entries.length;

  const with_quote = entries.filter(e => e.had_quote).length;
  const with_two_sided = entries.filter(e => e.had_two_sided).length;
  const with_tradeable = entries.filter(e => e.had_tradeable).length;
  const with_signal = entries.filter(e => e.had_signal).length;
  const with_context_entry = entries.filter(e => e.had_context_entry).length;
  const with_context_allowed = entries.filter(e => e.context_entry_allowed).length;

  // Missed = had some evaluation but no signal
  const missed = total - with_signal;

  // Aggregate reject reasons across missed events (by tick count)
  const reasonCounts = {};
  for (const ev of entries) {
    if (ev.had_signal) continue; // not missed
    for (const [reason, count] of Object.entries(ev.reject_reasons || {})) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + count;
    }
  }
  const top_miss_reasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  // Top reason PER EVENT (1 vote per missed event = its dominant reason)
  const eventReasonCounts = {};
  for (const ev of entries) {
    if (ev.had_signal) continue;
    const reasons = Object.entries(ev.reject_reasons || {});
    if (!reasons.length) continue;
    // Dominant = highest count within this event
    reasons.sort((a, b) => b[1] - a[1]);
    const dominant = reasons[0][0];
    eventReasonCounts[dominant] = (eventReasonCounts[dominant] || 0) + 1;
  }
  const top_event_miss_reasons = Object.entries(eventReasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, events]) => ({ reason, events }));

  // Capture analysis: how many markets crossed the entry threshold?
  let markets_crossed_threshold = 0;
  let markets_crossed_and_entered = 0;
  let markets_crossed_not_entered = 0;
  const missed_opportunities = []; // markets that crossed but we didn't enter
  
  for (const ev of entries) {
    const prices = ev.market_prices || {};
    for (const [slug, mp] of Object.entries(prices)) {
      if (mp.first_cross_ts) {
        markets_crossed_threshold++;
        if (ev.had_signal) {
          markets_crossed_and_entered++;
        } else {
          markets_crossed_not_entered++;
          // Find dominant reject reason for this event
          const reasons = Object.entries(ev.reject_reasons || {});
          reasons.sort((a, b) => b[1] - a[1]);
          missed_opportunities.push({
            slug,
            max_bid: mp.max_bid,
            first_cross_price: mp.first_cross_price,
            dominant_reject: reasons[0]?.[0] || "unknown",
          });
        }
      }
    }
  }

  return {
    total, with_quote, with_two_sided, with_tradeable, with_signal,
    with_context_entry, with_context_allowed,
    missed, top_miss_reasons, top_event_miss_reasons,
    // Capture metrics
    capture: {
      markets_crossed_threshold,
      markets_entered: markets_crossed_and_entered,
      markets_missed: markets_crossed_not_entered,
      capture_rate: markets_crossed_threshold > 0 
        ? (markets_crossed_and_entered / markets_crossed_threshold * 100).toFixed(1) + "%" 
        : "n/a",
      missed_opportunities: missed_opportunities.slice(0, 10), // Top 10
    }
  };
}
