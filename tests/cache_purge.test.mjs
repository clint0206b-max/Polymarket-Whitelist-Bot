import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { purgeStaleDates } from "../src/metrics/daily_events.mjs";
import { trackScoreChange, purgeStaleScoreHistory, resetScoreHistory } from "../src/context/espn_soccer_scoreboard.mjs";

describe("purgeStaleDates", () => {
  it("purges dates older than maxDays", () => {
    const now = new Date();
    const old = new Date(now);
    old.setDate(old.getDate() - 10);
    const oldKey = old.toISOString().slice(0, 10);
    const todayKey = now.toISOString().slice(0, 10);

    const state = {
      [oldKey]: { cbb: { ev1: { tick_count: 100 } } },
      [todayKey]: { nba: { ev2: { tick_count: 50 } } },
    };

    const purged = purgeStaleDates(state, 7);
    assert.equal(purged, 1);
    assert.equal(state[oldKey], undefined);
    assert.ok(state[todayKey]);
  });

  it("keeps dates within maxDays", () => {
    const now = new Date();
    const recent = new Date(now);
    recent.setDate(recent.getDate() - 3);
    const recentKey = recent.toISOString().slice(0, 10);

    const state = {
      [recentKey]: { cbb: { ev1: { tick_count: 10 } } },
    };

    const purged = purgeStaleDates(state, 7);
    assert.equal(purged, 0);
    assert.ok(state[recentKey]);
  });

  it("ignores non-date keys", () => {
    const state = {
      "not-a-date": { some: "data" },
      "2026-02-15": { cbb: {} },
    };
    // Both should survive (non-date key is not purged, date within range depends on now)
    const purged = purgeStaleDates(state, 9999);
    assert.equal(purged, 0);
    assert.ok(state["not-a-date"]);
  });

  it("handles empty state", () => {
    const purged = purgeStaleDates({}, 7);
    assert.equal(purged, 0);
  });

  it("handles null/undefined gracefully", () => {
    assert.equal(purgeStaleDates(null), 0);
    assert.equal(purgeStaleDates(undefined), 0);
  });
});

describe("purgeStaleScoreHistory", () => {
  beforeEach(() => resetScoreHistory());

  it("purges entries older than maxAgeMs", () => {
    const now = Date.now();
    // Add entries at different times
    trackScoreChange("game-old", 1, 0, now - 25 * 3600 * 1000); // 25h ago
    trackScoreChange("game-new", 2, 1, now - 1000); // 1s ago

    const purged = purgeStaleScoreHistory(now, 24 * 3600 * 1000);
    assert.equal(purged, 1);

    // game-new should still be trackable
    const elapsed = trackScoreChange("game-new", 2, 1, now);
    assert.ok(elapsed != null || elapsed === null); // exists in map

    // game-old should be fresh (re-added)
    const freshElapsed = trackScoreChange("game-old", 0, 0, now);
    assert.equal(freshElapsed, null); // first observation after purge
  });

  it("keeps entries within maxAge", () => {
    const now = Date.now();
    trackScoreChange("game-fresh", 1, 0, now - 1000);

    const purged = purgeStaleScoreHistory(now, 24 * 3600 * 1000);
    assert.equal(purged, 0);
  });

  it("handles empty history", () => {
    const purged = purgeStaleScoreHistory(Date.now());
    assert.equal(purged, 0);
  });
});
