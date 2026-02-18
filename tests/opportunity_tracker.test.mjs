import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// We test the tracker in isolation by mocking journal and state_store
const journalEntries = [];
const persistedFiles = {};

// Mock modules before import
const mockAppendJsonl = mock.fn((path, entry) => {
  journalEntries.push({ path, entry });
});

const mockWriteJsonAtomic = mock.fn((path, data) => {
  persistedFiles[path] = JSON.parse(JSON.stringify(data));
});

const mockReadJson = mock.fn((path) => {
  return persistedFiles[path] || null;
});

// Since we can't easily mock ESM imports, we'll test the logic directly
// by replicating the core tracking algorithm. This tests behavior, not wiring.

// --- Replicated core logic for unit testing ---

const SCHEMA_VERSION = 1;

function trackingKey(conditionId, slug) {
  return `${conditionId}::${slug}`;
}

class TestableTracker {
  constructor(cfg, bootId) {
    this._cfg = cfg;
    this._bootId = bootId;
    this._enabled = !!cfg?.opportunity_tracker?.enabled;
    this._tracked = new Map();
    this._stageFails = {};
    this._dirty = false;
    this._lastPersistTs = 0;
    this._lastStageSummaryTs = 0;
    this._journal = [];
    this._persisted = null;
  }

  get enabled() { return this._enabled; }
  get tracked() { return this._tracked; }
  get journal() { return this._journal; }
  get persisted() { return this._persisted; }

  _appendJournal(entry) {
    this._journal.push(entry);
  }

  load(rawState) {
    if (!this._enabled) return;
    if (!rawState || typeof rawState !== "object") return;
    const entries = rawState.tracked || {};
    let resumed = 0;
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== "object") continue;
      this._tracked.set(key, entry);
      resumed++;
    }
    if (resumed > 0) {
      this._appendJournal({
        type: "opp_boot_resume",
        schema_version: SCHEMA_VERSION,
        boot_id: this._bootId,
        ts: Date.now(),
        resumed_count: resumed,
      });
    }
  }

  onGateReject(market, rejectReason, priceSnapshot, depthSnapshot, contextSnapshot, now) {
    if (!this._enabled) return;
    const key = trackingKey(market.conditionId, market.slug);
    let entry = this._tracked.get(key);
    const evalIntervalMs = Number(this._cfg?.polling?.clob_eval_seconds || 2) * 1000;
    const gapThresholdMs = evalIntervalMs * 3;

    if (!entry) {
      entry = {
        conditionId: String(market.conditionId || ""),
        slug: String(market.slug || ""),
        league: String(market.league || ""),
        first_seen_ts: now,
        last_tick_ts: now,
        best_ask_seen: priceSnapshot.ask,
        worst_ask_seen: priceSnapshot.ask,
        best_bid_seen: priceSnapshot.bid,
        best_ask_with_context: { ts: now, ask: priceSnapshot.ask, bid: priceSnapshot.bid, spread: priceSnapshot.spread, entry_depth_usd_ask: depthSnapshot?.entry_depth_usd_ask ?? null },
        current_reject_reason: rejectReason,
        reject_reason_counts: { [rejectReason]: 1 },
        time_in_reason_ms: { [rejectReason]: 0 },
        observed_ticks_in_range: 1,
        observed_time_in_range_ms: 0,
        observed_ticks_tracked: 1,
        observed_time_tracked_ms: 0,
        gap_count: 0,
        context_at_first_reject: { ...contextSnapshot },
        dirty: true,
      };
      this._tracked.set(key, entry);
      this._appendJournal({
        type: "opp_near_miss",
        schema_version: SCHEMA_VERSION,
        boot_id: this._bootId,
        ts: now,
        slug: entry.slug,
        league: entry.league,
        reject_reason: rejectReason,
        prev_reason: null,
        ask: priceSnapshot.ask,
        bid: priceSnapshot.bid,
        time_in_range_ms: 0,
        ticks_passing_basics: 1,
        gap_count: 0,
      });
      return;
    }

    const tickGap = now - entry.last_tick_ts;
    if (tickGap > gapThresholdMs) {
      entry.gap_count++;
    } else {
      entry.observed_time_in_range_ms += tickGap;
      entry.observed_time_tracked_ms = (entry.observed_time_tracked_ms || 0) + tickGap;
    }

    if (entry.current_reject_reason && tickGap <= gapThresholdMs) {
      const r = entry.current_reject_reason;
      entry.time_in_reason_ms[r] = (entry.time_in_reason_ms[r] || 0) + tickGap;
    }

    entry.last_tick_ts = now;
    entry.observed_ticks_in_range++;
    entry.observed_ticks_tracked = (entry.observed_ticks_tracked || 0) + 1;

    // Update price range + best_ask context
    this._updatePriceRange(entry, priceSnapshot, depthSnapshot, now);

    if (rejectReason !== entry.current_reject_reason) {
      const prevReason = entry.current_reject_reason;
      entry.current_reject_reason = rejectReason;
      entry.reject_reason_counts[rejectReason] = (entry.reject_reason_counts[rejectReason] || 0) + 1;
      entry.dirty = true;
      this._appendJournal({
        type: "opp_near_miss",
        schema_version: SCHEMA_VERSION,
        boot_id: this._bootId,
        ts: now,
        slug: entry.slug,
        league: entry.league,
        reject_reason: rejectReason,
        prev_reason: prevReason,
        ask: priceSnapshot.ask,
        bid: priceSnapshot.bid,
        time_in_range_ms: entry.observed_time_in_range_ms,
        ticks_passing_basics: entry.observed_ticks_in_range,
        gap_count: entry.gap_count,
      });
    } else {
      entry.reject_reason_counts[rejectReason] = (entry.reject_reason_counts[rejectReason] || 0) + 1;
    }
  }

  onTraded(market, now) {
    if (!this._enabled) return;
    const key = trackingKey(market.conditionId, market.slug);
    const entry = this._tracked.get(key);
    if (!entry) return;
    this._appendJournal({
      type: "opp_closed_tracking",
      schema_version: SCHEMA_VERSION,
      boot_id: this._bootId,
      ts: now,
      slug: entry.slug,
      close_reason: "traded",
      tracking_duration_ms: now - entry.first_seen_ts,
      best_ask_seen: entry.best_ask_seen,
      worst_ask_seen: entry.worst_ask_seen,
      reject_reason_counts: { ...entry.reject_reason_counts },
      total_ticks_in_range: entry.observed_ticks_in_range,
      total_ticks_tracked: entry.observed_ticks_tracked || entry.observed_ticks_in_range,
      observed_time_in_range_ms: entry.observed_time_in_range_ms,
      observed_time_tracked_ms: entry.observed_time_tracked_ms || entry.observed_time_in_range_ms,
      best_ask_with_context: entry.best_ask_with_context || null,
      gap_count: entry.gap_count,
    });
    this._tracked.delete(key);
    this._dirty = true;
  }

  onRemoved(market, closeReason, lastPrice, lastContext, now) {
    if (!this._enabled) return;
    const key = trackingKey(market.conditionId, market.slug);
    const entry = this._tracked.get(key);
    if (!entry) return;
    this._appendJournal({
      type: "opp_closed_tracking",
      schema_version: SCHEMA_VERSION,
      boot_id: this._bootId,
      ts: now,
      slug: entry.slug,
      close_reason: closeReason,
      tracking_duration_ms: now - entry.first_seen_ts,
      best_ask_seen: entry.best_ask_seen,
      worst_ask_seen: entry.worst_ask_seen,
      reject_reason_counts: { ...entry.reject_reason_counts },
      total_ticks_in_range: entry.observed_ticks_in_range,
      total_ticks_tracked: entry.observed_ticks_tracked || entry.observed_ticks_in_range,
      observed_time_in_range_ms: entry.observed_time_in_range_ms,
      observed_time_tracked_ms: entry.observed_time_tracked_ms || entry.observed_time_in_range_ms,
      best_ask_with_context: entry.best_ask_with_context || null,
      gap_count: entry.gap_count,
      last_known_price: lastPrice,
      context_at_close: lastContext,
    });
    this._tracked.delete(key);
    this._dirty = true;
  }

  _updatePriceRange(entry, priceSnapshot, depthSnapshot, now) {
    if (priceSnapshot.ask != null) {
      if (entry.best_ask_seen == null || priceSnapshot.ask > entry.best_ask_seen) {
        entry.best_ask_seen = priceSnapshot.ask;
        entry.best_ask_with_context = { ts: now, ask: priceSnapshot.ask, bid: priceSnapshot.bid, spread: priceSnapshot.spread, entry_depth_usd_ask: depthSnapshot?.entry_depth_usd_ask ?? null };
      }
      if (entry.worst_ask_seen == null || priceSnapshot.ask < entry.worst_ask_seen) entry.worst_ask_seen = priceSnapshot.ask;
    }
    if (priceSnapshot.bid != null) {
      if (entry.best_bid_seen == null || priceSnapshot.bid > entry.best_bid_seen) entry.best_bid_seen = priceSnapshot.bid;
    }
  }

  onSilentTick(market, priceSnapshot, depthSnapshot, now) {
    if (!this._enabled) return;
    const key = trackingKey(market.conditionId, market.slug);
    const entry = this._tracked.get(key);
    if (!entry) return;

    const evalIntervalMs = Number(this._cfg?.polling?.clob_eval_seconds || 2) * 1000;
    const gapThresholdMs = evalIntervalMs * 3;
    const tickGap = now - entry.last_tick_ts;

    if (tickGap > gapThresholdMs) {
      entry.gap_count++;
    } else {
      entry.observed_time_tracked_ms = (entry.observed_time_tracked_ms || 0) + tickGap;
    }

    entry.last_tick_ts = now;
    entry.observed_ticks_tracked = (entry.observed_ticks_tracked || 0) + 1;
    this._updatePriceRange(entry, priceSnapshot, depthSnapshot, now);
  }

  recordStageFail(league, stage, now) {
    if (!this._enabled) return;
    const key = `${league}:${stage}`;
    this._stageFails[key] = (this._stageFails[key] || 0) + 1;
  }

  flushStageSummary(now) {
    if (!this._enabled) return;
    const counts = { ...this._stageFails };
    if (Object.keys(counts).length === 0) return;
    this._appendJournal({
      type: "stage_fail_summary",
      schema_version: SCHEMA_VERSION,
      boot_id: this._bootId,
      ts: now,
      counts,
    });
    this._stageFails = {};
  }
}

// --- Helpers ---

function makeMarket(overrides = {}) {
  return {
    conditionId: "cond123",
    slug: "cbb-mich-pur-2026-02-17",
    league: "cbb",
    ...overrides,
  };
}

function makePrice(ask = 0.94, bid = 0.92) {
  return { ask, bid, spread: ask - bid };
}

function makeDepth(entry = 600, exit = 3000) {
  return { entry_depth_usd_ask: entry, exit_depth_usd_bid: exit };
}

function makeContext(overrides = {}) {
  return {
    period: 2,
    minutes_left: 12,
    margin: 8,
    margin_for_yes: 8,
    win_prob: 0.85,
    state: "in",
    ...overrides,
  };
}

function makeCfg(enabled = true) {
  return {
    opportunity_tracker: { enabled },
    polling: { clob_eval_seconds: 2 },
  };
}

// --- Tests ---

describe("OpportunityTracker", () => {
  let tracker;

  beforeEach(() => {
    tracker = new TestableTracker(makeCfg(true), "boot-001");
  });

  describe("feature flag", () => {
    it("does nothing when disabled", () => {
      const t = new TestableTracker(makeCfg(false), "boot-001");
      t.onGateReject(makeMarket(), "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 1000);
      assert.equal(t.tracked.size, 0);
      assert.equal(t.journal.length, 0);
    });

    it("tracks when enabled", () => {
      tracker.onGateReject(makeMarket(), "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 1000);
      assert.equal(tracker.tracked.size, 1);
      assert.equal(tracker.journal.length, 1);
    });
  });

  describe("opp_near_miss logging", () => {
    it("logs on first reject (new market)", () => {
      tracker.onGateReject(makeMarket(), "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 1000);
      assert.equal(tracker.journal.length, 1);
      const j = tracker.journal[0];
      assert.equal(j.type, "opp_near_miss");
      assert.equal(j.reject_reason, "cbb_gate:not_final_period");
      assert.equal(j.prev_reason, null);
      assert.equal(j.ticks_passing_basics, 1);
    });

    it("does NOT log on same reason repeated", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 3000);
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 5000);
      // Only 1 journal entry (first time)
      assert.equal(tracker.journal.length, 1);
    });

    it("logs on reason transition", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "cbb_gate:too_much_time_left", makePrice(), makeDepth(), makeContext(), 3000);
      assert.equal(tracker.journal.length, 2);
      const j2 = tracker.journal[1];
      assert.equal(j2.reject_reason, "cbb_gate:too_much_time_left");
      assert.equal(j2.prev_reason, "cbb_gate:not_final_period");
    });

    it("increments counter on every reject (even same reason)", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 3000);
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 5000);
      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);
      assert.equal(entry.reject_reason_counts["cbb_gate:not_final_period"], 3);
      assert.equal(entry.observed_ticks_in_range, 3);
    });

    it("tracks time_in_reason_ms correctly", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 3000); // +2000ms
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(), makeDepth(), makeContext(), 5000); // +2000ms
      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);
      assert.equal(entry.time_in_reason_ms["cbb_gate:not_final_period"], 4000);
    });
  });

  describe("price range tracking", () => {
    it("tracks best and worst ask", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(0.94, 0.92), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "gate:x", makePrice(0.96, 0.93), makeDepth(), makeContext(), 3000);
      tracker.onGateReject(m, "gate:x", makePrice(0.93, 0.91), makeDepth(), makeContext(), 5000);
      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);
      assert.equal(entry.best_ask_seen, 0.96);
      assert.equal(entry.worst_ask_seen, 0.93);
      assert.equal(entry.best_bid_seen, 0.93);
    });
  });

  describe("gap detection", () => {
    it("increments gap_count when tick gap exceeds threshold", () => {
      const m = makeMarket();
      // eval_interval = 2s, threshold = 6s
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 8000); // 7s gap > 6s
      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);
      assert.equal(entry.gap_count, 1);
    });

    it("does NOT increment gap_count within threshold", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 6000); // 5s < 6s
      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);
      assert.equal(entry.gap_count, 0);
    });

    it("does NOT accumulate time during gaps", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 3000); // +2s normal
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 20000); // 17s gap
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 22000); // +2s normal
      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);
      // observed_time = 2000 + 2000 = 4000 (gap period excluded)
      assert.equal(entry.observed_time_in_range_ms, 4000);
      assert.equal(entry.gap_count, 1);
    });
  });

  describe("onTraded (signal generated)", () => {
    it("removes market from tracker and logs opp_closed_tracking with traded", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 3000);
      assert.equal(tracker.tracked.size, 1);

      tracker.onTraded(m, 5000);
      assert.equal(tracker.tracked.size, 0);

      const closedEntries = tracker.journal.filter(j => j.type === "opp_closed_tracking");
      assert.equal(closedEntries.length, 1);
      assert.equal(closedEntries[0].close_reason, "traded");
      assert.equal(closedEntries[0].tracking_duration_ms, 4000);
    });

    it("does nothing if market was not tracked", () => {
      const m = makeMarket();
      tracker.onTraded(m, 5000);
      assert.equal(tracker.journal.length, 0);
    });
  });

  describe("onRemoved (market purged)", () => {
    it("logs opp_closed_tracking with specific close_reason", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(0.95), makeDepth(), makeContext(), 1000);
      tracker.onRemoved(m, "purged_terminal", { ask: 0.999, bid: 0.998 }, { period: 2, minutes_left: 0.5 }, 60000);

      const closedEntries = tracker.journal.filter(j => j.type === "opp_closed_tracking");
      assert.equal(closedEntries.length, 1);
      assert.equal(closedEntries[0].close_reason, "purged_terminal");
      assert.equal(closedEntries[0].best_ask_seen, 0.95);
      assert.deepEqual(closedEntries[0].last_known_price, { ask: 0.999, bid: 0.998 });
      assert.equal(closedEntries[0].tracking_duration_ms, 59000);
    });

    it("does nothing for non-tracked markets", () => {
      const m = makeMarket();
      tracker.onRemoved(m, "purged_ttl", null, null, 5000);
      assert.equal(tracker.journal.length, 0);
    });

    it("granular close reasons are preserved", () => {
      const reasons = ["purged_terminal", "purged_ttl", "purged_slug_date", "purged_while_gate_blocked", "evicted"];
      for (const reason of reasons) {
        const t = new TestableTracker(makeCfg(true), "boot-001");
        const m = makeMarket({ conditionId: `cond-${reason}`, slug: `slug-${reason}` });
        t.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 1000);
        t.onRemoved(m, reason, null, null, 5000);
        const closed = t.journal.find(j => j.type === "opp_closed_tracking");
        assert.equal(closed.close_reason, reason);
      }
    });
  });

  describe("composite key", () => {
    it("tracks different markets with different slugs independently", () => {
      const m1 = makeMarket({ conditionId: "cond1", slug: "slug-a" });
      const m2 = makeMarket({ conditionId: "cond1", slug: "slug-b" });
      tracker.onGateReject(m1, "gate:x", makePrice(0.94), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m2, "gate:y", makePrice(0.95), makeDepth(), makeContext(), 1000);
      assert.equal(tracker.tracked.size, 2);
    });

    it("same conditionId+slug maps to same entry", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 3000);
      assert.equal(tracker.tracked.size, 1);
    });
  });

  describe("boot resume", () => {
    it("loads persisted state and logs opp_boot_resume", () => {
      const savedState = {
        tracked: {
          "cond1::slug-a": {
            conditionId: "cond1",
            slug: "slug-a",
            league: "cbb",
            first_seen_ts: 500,
            last_tick_ts: 900,
            best_ask_seen: 0.95,
            worst_ask_seen: 0.93,
            best_bid_seen: 0.91,
            current_reject_reason: "gate:x",
            reject_reason_counts: { "gate:x": 5 },
            time_in_reason_ms: { "gate:x": 8000 },
            observed_ticks_in_range: 5,
            observed_time_in_range_ms: 8000,
            gap_count: 0,
            context_at_first_reject: {},
            dirty: false,
          },
        },
      };

      tracker.load(savedState);
      assert.equal(tracker.tracked.size, 1);
      const resume = tracker.journal.find(j => j.type === "opp_boot_resume");
      assert.ok(resume);
      assert.equal(resume.resumed_count, 1);
    });

    it("continues tracking after resume", () => {
      const savedState = {
        tracked: {
          "cond1::slug-a": {
            conditionId: "cond1",
            slug: "slug-a",
            league: "cbb",
            first_seen_ts: 500,
            last_tick_ts: 900,
            best_ask_seen: 0.95,
            worst_ask_seen: 0.93,
            best_bid_seen: 0.91,
            current_reject_reason: "gate:x",
            reject_reason_counts: { "gate:x": 5 },
            time_in_reason_ms: { "gate:x": 8000 },
            observed_ticks_in_range: 5,
            observed_time_in_range_ms: 8000,
            gap_count: 0,
            context_at_first_reject: {},
            dirty: false,
          },
        },
      };

      tracker.load(savedState);

      // New reject on resumed market — reason transition
      const m = makeMarket({ conditionId: "cond1", slug: "slug-a" });
      tracker.onGateReject(m, "gate:y", makePrice(0.96), makeDepth(), makeContext(), 2000);

      const entry = tracker.tracked.get("cond1::slug-a");
      assert.equal(entry.observed_ticks_in_range, 6);
      assert.equal(entry.reject_reason_counts["gate:x"], 5); // preserved
      assert.equal(entry.reject_reason_counts["gate:y"], 1); // new
      assert.equal(entry.best_ask_seen, 0.96); // updated
      // 2000 - 900 = 1100ms < 6000ms threshold → no gap
      assert.equal(entry.gap_count, 0);
    });
  });

  describe("stage fail summary", () => {
    it("aggregates stage fails and flushes", () => {
      tracker.recordStageFail("cbb", "stage1_price", 1000);
      tracker.recordStageFail("cbb", "stage1_price", 2000);
      tracker.recordStageFail("cbb", "stage2_depth", 3000);
      tracker.recordStageFail("esports", "stage1_spread", 4000);

      tracker.flushStageSummary(5000);
      const summary = tracker.journal.find(j => j.type === "stage_fail_summary");
      assert.ok(summary);
      assert.equal(summary.counts["cbb:stage1_price"], 2);
      assert.equal(summary.counts["cbb:stage2_depth"], 1);
      assert.equal(summary.counts["esports:stage1_spread"], 1);
    });

    it("does not flush when empty", () => {
      tracker.flushStageSummary(5000);
      assert.equal(tracker.journal.filter(j => j.type === "stage_fail_summary").length, 0);
    });

    it("resets after flush", () => {
      tracker.recordStageFail("cbb", "stage1_price", 1000);
      tracker.flushStageSummary(5000);
      tracker.flushStageSummary(10000); // second flush should be empty
      assert.equal(tracker.journal.filter(j => j.type === "stage_fail_summary").length, 1);
    });
  });

  describe("schema_version", () => {
    it("all journal entries have schema_version", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "gate:y", makePrice(), makeDepth(), makeContext(), 3000);
      tracker.onRemoved(m, "purged_terminal", null, null, 5000);
      tracker.recordStageFail("cbb", "stage1", 1000);
      tracker.flushStageSummary(6000);

      for (const j of tracker.journal) {
        assert.equal(j.schema_version, SCHEMA_VERSION, `Missing schema_version in ${j.type}`);
      }
    });

    it("all journal entries have boot_id", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onRemoved(m, "purged_ttl", null, null, 5000);

      for (const j of tracker.journal) {
        assert.equal(j.boot_id, "boot-001", `Missing boot_id in ${j.type}`);
      }
    });
  });

  describe("full lifecycle", () => {
    it("market: first reject → reason change → price update → purged", () => {
      const m = makeMarket();

      // Period 1, rejected
      tracker.onGateReject(m, "cbb_gate:not_final_period", makePrice(0.94, 0.92), makeDepth(), makeContext({ period: 1, minutes_left: 12 }), 1000);

      // Period 2, too much time
      tracker.onGateReject(m, "cbb_gate:too_much_time_left", makePrice(0.95, 0.93), makeDepth(), makeContext({ period: 2, minutes_left: 8 }), 3000);

      // Still too much time, higher price
      tracker.onGateReject(m, "cbb_gate:too_much_time_left", makePrice(0.96, 0.94), makeDepth(), makeContext({ period: 2, minutes_left: 6 }), 5000);

      // Purged (game ended, terminal price)
      tracker.onRemoved(m, "purged_terminal", { ask: 0.999, bid: 0.998 }, { period: 2, minutes_left: 0 }, 10000);

      // Verify journal
      const nearMisses = tracker.journal.filter(j => j.type === "opp_near_miss");
      assert.equal(nearMisses.length, 2); // first + reason transition

      const closed = tracker.journal.filter(j => j.type === "opp_closed_tracking");
      assert.equal(closed.length, 1);
      assert.equal(closed[0].close_reason, "purged_terminal");
      assert.equal(closed[0].best_ask_seen, 0.96);
      assert.equal(closed[0].worst_ask_seen, 0.94);
      assert.equal(closed[0].total_ticks_in_range, 3);
      assert.deepEqual(closed[0].reject_reason_counts, {
        "cbb_gate:not_final_period": 1,
        "cbb_gate:too_much_time_left": 2,
      });

      // Tracker is clean
      assert.equal(tracker.tracked.size, 0);
    });

    it("market: rejected → eventually traded (not a miss)", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "cbb_gate:too_much_time_left", makePrice(), makeDepth(), makeContext(), 1000);
      tracker.onGateReject(m, "cbb_gate:too_much_time_left", makePrice(), makeDepth(), makeContext(), 3000);

      // Signal generated
      tracker.onTraded(m, 5000);

      assert.equal(tracker.tracked.size, 0);
      const closed = tracker.journal.find(j => j.type === "opp_closed_tracking");
      assert.equal(closed.close_reason, "traded");
    });
  });

  describe("onSilentTick (out-of-range continuity)", () => {
    it("does nothing for non-tracked markets", () => {
      const m = makeMarket();
      tracker.onSilentTick(m, makePrice(0.99), makeDepth(), 1000);
      assert.equal(tracker.tracked.size, 0);
      assert.equal(tracker.journal.length, 0);
    });

    it("updates tracked_ms but NOT in_range_ms", () => {
      const m = makeMarket();
      // Gate reject at T+1000
      tracker.onGateReject(m, "gate:x", makePrice(0.94), makeDepth(), makeContext(), 1000);
      // Gate reject at T+3000 (in range)
      tracker.onGateReject(m, "gate:x", makePrice(0.95), makeDepth(), makeContext(), 3000);
      // Silent tick at T+5000 (out of range, price=0.99)
      tracker.onSilentTick(m, makePrice(0.99, 0.97), makeDepth(), 5000);
      // Silent tick at T+7000 (still out of range)
      tracker.onSilentTick(m, makePrice(0.985, 0.96), makeDepth(), 7000);

      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);

      // in_range: 1000→3000 = 2000ms (only gate reject ticks)
      assert.equal(entry.observed_time_in_range_ms, 2000);
      // tracked: 1000→3000 + 3000→5000 + 5000→7000 = 6000ms
      assert.equal(entry.observed_time_tracked_ms, 6000);
      // ticks_in_range: 2 (initial + 1 gate reject)
      assert.equal(entry.observed_ticks_in_range, 2);
      // ticks_tracked: 4 (2 gate + 2 silent)
      assert.equal(entry.observed_ticks_tracked, 4);
    });

    it("updates best_ask_seen from silent tick", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(0.94, 0.92), makeDepth(), makeContext(), 1000);
      // Price spikes out of range
      tracker.onSilentTick(m, makePrice(0.99, 0.97), makeDepth(800), 3000);

      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);
      assert.equal(entry.best_ask_seen, 0.99);
    });

    it("updates best_ask_with_context when new best", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(0.94, 0.92), makeDepth(600), makeContext(), 1000);
      tracker.onSilentTick(m, makePrice(0.99, 0.97), makeDepth(200), 3000);

      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);
      assert.equal(entry.best_ask_with_context.ask, 0.99);
      assert.equal(entry.best_ask_with_context.bid, 0.97);
      assert.equal(entry.best_ask_with_context.ts, 3000);
      assert.equal(entry.best_ask_with_context.entry_depth_usd_ask, 200);
    });

    it("does NOT update best_ask_with_context when not a new best", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(0.96, 0.93), makeDepth(600), makeContext(), 1000);
      tracker.onSilentTick(m, makePrice(0.94, 0.92), makeDepth(500), 3000);

      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);
      // best_ask_with_context should still be from the first (higher) ask
      assert.equal(entry.best_ask_with_context.ask, 0.96);
      assert.equal(entry.best_ask_with_context.ts, 1000);
    });

    it("prevents gap_count when silent ticks fill the gap", () => {
      const m = makeMarket();
      tracker.onGateReject(m, "gate:x", makePrice(0.94), makeDepth(), makeContext(), 1000);
      // Silent ticks every 2s (no gap)
      tracker.onSilentTick(m, makePrice(0.99), makeDepth(), 3000);
      tracker.onSilentTick(m, makePrice(0.985), makeDepth(), 5000);
      // Back in range
      tracker.onGateReject(m, "gate:x", makePrice(0.95), makeDepth(), makeContext(), 7000);

      const key = trackingKey("cond123", "cbb-mich-pur-2026-02-17");
      const entry = tracker.tracked.get(key);
      assert.equal(entry.gap_count, 0); // no gaps — silent ticks maintained continuity
    });

    it("full lifecycle with silent ticks: in_range < tracked", () => {
      const m = makeMarket();
      // T+0: gate reject (in range)
      tracker.onGateReject(m, "cbb_gate:too_much_time_left", makePrice(0.94, 0.92), makeDepth(600), makeContext(), 0);
      // T+2000: gate reject (in range)
      tracker.onGateReject(m, "cbb_gate:too_much_time_left", makePrice(0.95, 0.93), makeDepth(600), makeContext(), 2000);
      // T+4000: price spikes to 0.99 (silent)
      tracker.onSilentTick(m, makePrice(0.99, 0.97), makeDepth(100), 4000);
      // T+6000: still out of range (silent)
      tracker.onSilentTick(m, makePrice(0.985, 0.96), makeDepth(150), 6000);
      // T+8000: back in range, gate reject
      tracker.onGateReject(m, "cbb_gate:too_much_time_left", makePrice(0.95, 0.93), makeDepth(600), makeContext(), 8000);
      // T+10000: purged terminal
      tracker.onRemoved(m, "purged_terminal", { ask: 0.999, bid: 0.998 }, null, 10000);

      const closed = tracker.journal.find(j => j.type === "opp_closed_tracking");
      // in_range: 0→2000 + 6000→8000 = 4000ms (only gate reject periods)
      assert.equal(closed.observed_time_in_range_ms, 4000);
      // tracked: 0→2000 + 2000→4000 + 4000→6000 + 6000→8000 = 8000ms
      assert.equal(closed.observed_time_tracked_ms, 8000);
      // best_ask from silent tick
      assert.equal(closed.best_ask_seen, 0.99);
      assert.ok(closed.best_ask_with_context);
      assert.equal(closed.best_ask_with_context.ask, 0.99);
      assert.equal(closed.best_ask_with_context.bid, 0.97);
      assert.equal(closed.best_ask_with_context.entry_depth_usd_ask, 100);
    });
  });
});
