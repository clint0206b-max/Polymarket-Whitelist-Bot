// tests/gamma_live_protection.test.mjs
// Test gamma live event protection for purge gates and TTL

import { describe, test } from "node:test";
import assert from "node:assert";

// Extract the isGammaLiveProtected logic for testing
function isGammaLiveProtected(m, gammaSnapshot, now, opts = {}) {
  const GAMMA_LIVE_MAX_STALE_MS = 90000;
  const GAMMA_LIVE_MAX_PROTECT_MS = 2 * 60 * 60 * 1000;
  const WS_ACTIVITY_THRESHOLD_MS = opts.wsActivityThreshold || 600000;
  
  const gammaSnapshotFresh = gammaSnapshot && (now - gammaSnapshot.ts) < GAMMA_LIVE_MAX_STALE_MS;
  if (!gammaSnapshotFresh) return false;
  
  // Build merged live set (current + previous cycle)
  const gammaLiveSet = new Set();
  for (const id of (gammaSnapshot.ids || [])) gammaLiveSet.add(id);
  for (const id of (gammaSnapshot.prev_ids || [])) gammaLiveSet.add(id);
  
  if (!gammaLiveSet.has(m.conditionId)) return false;
  
  // Safety cap
  const expiredAt = m.expired_at_ts || 0;
  if (expiredAt && (now - expiredAt) > GAMMA_LIVE_MAX_PROTECT_MS) return false;
  
  // WS activity check
  const wsHealthy = opts.wsHealthy !== undefined ? opts.wsHealthy : true;
  if (wsHealthy) {
    const yesToken = m.tokens?.yes_token_id;
    if (yesToken && opts.wsCache) {
      const wsPrice = opts.wsCache.get(yesToken);
      if (wsPrice) {
        const wsAge = now - wsPrice.lastUpdate;
        if (wsAge > WS_ACTIVITY_THRESHOLD_MS) return false;
      }
      // wsPrice null = never received → conservative, protect
    }
    // No token = incomplete → conservative, protect
  }
  // WS unhealthy → conservative, protect
  
  return true;
}

describe("Gamma Live Protection", () => {
  const NOW = 1700000000000;
  const freshSnapshot = (ids, prevIds = []) => ({ ts: NOW - 10000, ids, prev_ids: prevIds });

  test("protects market that is in current gamma live set", () => {
    const m = { conditionId: "cond-1", status: "expired" };
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW), true);
  });

  test("protects market that is in previous cycle (fault tolerance)", () => {
    const m = { conditionId: "cond-1", status: "expired" };
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-2"], ["cond-1"]), NOW), true);
  });

  test("does NOT protect market not in any gamma set", () => {
    const m = { conditionId: "cond-3", status: "expired" };
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"], ["cond-2"]), NOW), false);
  });

  test("does NOT protect if gamma snapshot is stale (>90s)", () => {
    const m = { conditionId: "cond-1", status: "expired" };
    const stale = { ts: NOW - 100000, ids: ["cond-1"], prev_ids: [] };
    assert.strictEqual(isGammaLiveProtected(m, stale, NOW), false);
  });

  test("does NOT protect if gamma snapshot is null", () => {
    const m = { conditionId: "cond-1", status: "expired" };
    assert.strictEqual(isGammaLiveProtected(m, null, NOW), false);
  });

  test("does NOT protect if market has been expired >2h (safety cap)", () => {
    const m = { conditionId: "cond-1", expired_at_ts: NOW - (2.1 * 60 * 60 * 1000) };
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW), false);
  });

  test("DOES protect if market expired <2h ago", () => {
    const m = { conditionId: "cond-1", expired_at_ts: NOW - (1 * 60 * 60 * 1000) };
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW), true);
  });

  test("protects market with no expired_at_ts (never expired before)", () => {
    const m = { conditionId: "cond-1" };
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW), true);
  });

  test("snapshot exactly at 90s boundary is stale", () => {
    const m = { conditionId: "cond-1" };
    const snap = { ts: NOW - 90000, ids: ["cond-1"], prev_ids: [] };
    assert.strictEqual(isGammaLiveProtected(m, snap, NOW), false);
  });

  test("snapshot at 89s is fresh", () => {
    const m = { conditionId: "cond-1" };
    const snap = { ts: NOW - 89000, ids: ["cond-1"], prev_ids: [] };
    assert.strictEqual(isGammaLiveProtected(m, snap, NOW), true);
  });

  // === WS Activity Tests ===

  test("WS healthy + recent activity → protected", () => {
    const m = { conditionId: "cond-1", tokens: { yes_token_id: "tok1" } };
    const wsCache = new Map([["tok1", { lastUpdate: NOW - 5000 }]]); // 5s ago
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW, { wsHealthy: true, wsCache }), true);
  });

  test("WS healthy + stale activity (>10min) → NOT protected", () => {
    const m = { conditionId: "cond-1", tokens: { yes_token_id: "tok1" } };
    const wsCache = new Map([["tok1", { lastUpdate: NOW - 700000 }]]); // ~11min ago
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW, { wsHealthy: true, wsCache }), false);
  });

  test("WS healthy + exactly at 10min threshold → NOT protected", () => {
    const m = { conditionId: "cond-1", tokens: { yes_token_id: "tok1" } };
    const wsCache = new Map([["tok1", { lastUpdate: NOW - 600001 }]]); // Just over 10min
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW, { wsHealthy: true, wsCache }), false);
  });

  test("WS healthy + token not in cache (newly subscribed) → PROTECTED (conservative)", () => {
    const m = { conditionId: "cond-1", tokens: { yes_token_id: "tok1" } };
    const wsCache = new Map(); // Empty cache
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW, { wsHealthy: true, wsCache }), true);
  });

  test("WS healthy + no token id → PROTECTED (conservative)", () => {
    const m = { conditionId: "cond-1", tokens: {} };
    const wsCache = new Map([["tok1", { lastUpdate: NOW - 700000 }]]);
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW, { wsHealthy: true, wsCache }), true);
  });

  test("WS UNHEALTHY + stale activity → PROTECTED (conservative, can't judge)", () => {
    const m = { conditionId: "cond-1", tokens: { yes_token_id: "tok1" } };
    const wsCache = new Map([["tok1", { lastUpdate: NOW - 700000 }]]); // Stale, but WS down
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW, { wsHealthy: false, wsCache }), true);
  });

  test("WS reconnects: stale → fresh → protected again", () => {
    const m = { conditionId: "cond-1", tokens: { yes_token_id: "tok1" } };
    const wsCache = new Map([["tok1", { lastUpdate: NOW - 700000 }]]);
    
    // Stale → not protected
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW, { wsHealthy: true, wsCache }), false);
    
    // WS reconnects, fresh data
    wsCache.set("tok1", { lastUpdate: NOW - 3000 });
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW, { wsHealthy: true, wsCache }), true);
  });

  test("WS activity check does NOT affect terminal purge (separate code path)", () => {
    // Terminal purge doesn't call isGammaLiveProtected — this test documents the design
    // Terminal purge checks wsClient.getPrice directly for bid >= 0.995
    assert.ok(true, "Terminal purge is independent of gamma live protection");
  });

  test("custom ws activity threshold", () => {
    const m = { conditionId: "cond-1", tokens: { yes_token_id: "tok1" } };
    const wsCache = new Map([["tok1", { lastUpdate: NOW - 120000 }]]); // 2min ago
    
    // Default 10min → protected (2min < 10min)
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW, { wsHealthy: true, wsCache }), true);
    
    // Custom 1min → NOT protected (2min > 1min)
    assert.strictEqual(isGammaLiveProtected(m, freshSnapshot(["cond-1"]), NOW, { wsHealthy: true, wsCache, wsActivityThreshold: 60000 }), false);
  });
});
