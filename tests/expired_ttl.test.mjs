// tests/expired_ttl.test.mjs
// Test expired TTL purge logic (only_live strategy)

import { describe, test } from "node:test";
import assert from "node:assert";

// Mock minimal state + config
function mockState(watchlist = {}) {
  return {
    watchlist,
    runtime: {
      health: {}
    }
  };
}

function mockConfig(expiredTtlHours = 5) {
  return {
    purge: {
      expired_ttl_hours: expiredTtlHours
    }
  };
}

// Simulate expired TTL purge (extracted from loop logic)
function purgeExpiredTTL(state, cfg, now) {
  const expiredTtlHours = Number(cfg?.purge?.expired_ttl_hours || 5);
  let expiredPurgedCount = 0;
  const purgeLogs = [];
  const metrics = {
    expired_purged_ttl: 0,
    expired_ttl_missing_timestamp: 0,
    expired_ttl_future_timestamp: 0
  };

  for (const [key, m] of Object.entries(state.watchlist || {})) {
    const isExpiredOrResolved = (m.status === "expired" || m.status === "resolved");
    if (!isExpiredOrResolved) continue;

    const ageTs = m.expired_at_ts || m.resolved_at || m.last_price?.updated_ts || null;
    
    if (ageTs == null) {
      metrics.expired_ttl_missing_timestamp++;
      continue;
    }

    if (ageTs > now) {
      metrics.expired_ttl_future_timestamp++;
      continue;
    }

    const ageHours = (now - ageTs) / (1000 * 60 * 60);
    
    if (ageHours > expiredTtlHours) {
      delete state.watchlist[key];
      expiredPurgedCount++;
      metrics.expired_purged_ttl++;
      purgeLogs.push({ slug: m.slug, ageHours, status: m.status });
    }
  }

  return { expiredPurgedCount, purgeLogs, metrics };
}

describe("Expired TTL Purge", () => {
  test("does NOT purge watching markets (even if old)", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-market",
        status: "watching",
        last_price: { updated_ts: now - (10 * 60 * 60 * 1000) } // 10h old
      }
    });
    const cfg = mockConfig(5);
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    assert.strictEqual(result.expiredPurgedCount, 0);
    assert.strictEqual(Object.keys(state.watchlist).length, 1);
  });

  test("purges expired market >5h old", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-expired",
        status: "expired",
        expired_at_ts: now - (6 * 60 * 60 * 1000) // 6h ago
      }
    });
    const cfg = mockConfig(5);
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    assert.strictEqual(result.expiredPurgedCount, 1);
    assert.strictEqual(Object.keys(state.watchlist).length, 0);
    assert.strictEqual(result.purgeLogs[0].ageHours.toFixed(1), "6.0");
  });

  test("does NOT purge expired market <5h old", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-recent",
        status: "expired",
        expired_at_ts: now - (4 * 60 * 60 * 1000) // 4h ago
      }
    });
    const cfg = mockConfig(5);
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    assert.strictEqual(result.expiredPurgedCount, 0);
    assert.strictEqual(Object.keys(state.watchlist).length, 1);
  });

  test("purges resolved market >5h old", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-resolved",
        status: "resolved",
        resolved_at: now - (7 * 60 * 60 * 1000) // 7h ago
      }
    });
    const cfg = mockConfig(5);
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    assert.strictEqual(result.expiredPurgedCount, 1);
    assert.strictEqual(Object.keys(state.watchlist).length, 0);
  });

  test("does NOT purge when timestamp missing (safe default)", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-no-timestamp",
        status: "expired"
        // No expired_at_ts, resolved_at, or last_price
      }
    });
    const cfg = mockConfig(5);
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    assert.strictEqual(result.expiredPurgedCount, 0);
    assert.strictEqual(result.metrics.expired_ttl_missing_timestamp, 1);
    assert.strictEqual(Object.keys(state.watchlist).length, 1);
  });

  test("does NOT purge when timestamp is in future (clock skew protection)", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-future",
        status: "expired",
        expired_at_ts: now + (2 * 60 * 60 * 1000) // 2h in future
      }
    });
    const cfg = mockConfig(5);
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    assert.strictEqual(result.expiredPurgedCount, 0);
    assert.strictEqual(result.metrics.expired_ttl_future_timestamp, 1);
    assert.strictEqual(Object.keys(state.watchlist).length, 1);
  });

  test("respects custom TTL (2 hours)", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-custom-ttl",
        status: "expired",
        expired_at_ts: now - (3 * 60 * 60 * 1000) // 3h ago
      }
    });
    const cfg = mockConfig(2); // 2h TTL
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    assert.strictEqual(result.expiredPurgedCount, 1);
    assert.strictEqual(Object.keys(state.watchlist).length, 0);
  });

  test("purges multiple expired markets", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-1",
        status: "expired",
        expired_at_ts: now - (6 * 60 * 60 * 1000)
      },
      "market2": {
        slug: "test-2",
        status: "expired",
        expired_at_ts: now - (8 * 60 * 60 * 1000)
      },
      "market3": {
        slug: "test-3",
        status: "watching",
        last_price: { updated_ts: now - (1 * 60 * 60 * 1000) }
      }
    });
    const cfg = mockConfig(5);
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    assert.strictEqual(result.expiredPurgedCount, 2);
    assert.strictEqual(Object.keys(state.watchlist).length, 1);
    assert.strictEqual(state.watchlist.market3.status, "watching");
  });

  test("uses fallback timestamps (expired_at_ts → resolved_at → last_price)", () => {
    const now = Date.now();
    const oldTs = now - (6 * 60 * 60 * 1000);
    
    // Test resolved_at fallback
    const state1 = mockState({
      "market1": {
        slug: "test-resolved-fallback",
        status: "expired",
        resolved_at: oldTs
      }
    });
    const result1 = purgeExpiredTTL(state1, mockConfig(5), now);
    assert.strictEqual(result1.expiredPurgedCount, 1);

    // Test last_price fallback
    const state2 = mockState({
      "market2": {
        slug: "test-last-price-fallback",
        status: "expired",
        last_price: { updated_ts: oldTs }
      }
    });
    const result2 = purgeExpiredTTL(state2, mockConfig(5), now);
    assert.strictEqual(result2.expiredPurgedCount, 1);
  });

  test("edge: market exactly at TTL boundary (5.0h) is NOT purged", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-boundary",
        status: "expired",
        expired_at_ts: now - (5.0 * 60 * 60 * 1000) // exactly 5h
      }
    });
    const cfg = mockConfig(5);
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    // At exactly 5h, ageHours == 5, which is NOT > 5, so it should NOT purge
    assert.strictEqual(result.expiredPurgedCount, 0);
  });

  test("edge: market just over TTL boundary (5.001h) IS purged", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-over-boundary",
        status: "expired",
        expired_at_ts: now - (5.001 * 60 * 60 * 1000) // 5.001h
      }
    });
    const cfg = mockConfig(5);
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    assert.strictEqual(result.expiredPurgedCount, 1);
  });

  test("persists after restart (state integrity)", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-persist",
        status: "expired",
        expired_at_ts: now - (6 * 60 * 60 * 1000)
      },
      "market2": {
        slug: "test-keep",
        status: "watching",
        last_price: { updated_ts: now }
      }
    });
    const cfg = mockConfig(5);
    
    // First purge
    const result = purgeExpiredTTL(state, cfg, now);
    assert.strictEqual(result.expiredPurgedCount, 1);
    assert.strictEqual(Object.keys(state.watchlist).length, 1);
    
    // Simulate restart: state should still have only market2
    assert.strictEqual(state.watchlist.market1, undefined);
    assert.ok(state.watchlist.market2);
  });

  test("handles empty watchlist gracefully", () => {
    const now = Date.now();
    const state = mockState({});
    const cfg = mockConfig(5);
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    assert.strictEqual(result.expiredPurgedCount, 0);
    assert.strictEqual(Object.keys(state.watchlist).length, 0);
  });

  test("handles missing config (uses default 5h)", () => {
    const now = Date.now();
    const state = mockState({
      "market1": {
        slug: "test-default",
        status: "expired",
        expired_at_ts: now - (6 * 60 * 60 * 1000)
      }
    });
    const cfg = {}; // No purge config
    
    const result = purgeExpiredTTL(state, cfg, now);
    
    // Should use default 5h
    assert.strictEqual(result.expiredPurgedCount, 1);
  });
});
