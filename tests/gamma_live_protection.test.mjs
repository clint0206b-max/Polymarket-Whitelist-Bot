// tests/gamma_live_protection.test.mjs
// Test gamma live event protection for purge gates and TTL

import { describe, test } from "node:test";
import assert from "node:assert";

// Extract the isGammaLiveProtected logic for testing
function isGammaLiveProtected(m, gammaSnapshot, now) {
  const GAMMA_LIVE_MAX_STALE_MS = 90000;
  const GAMMA_LIVE_MAX_PROTECT_MS = 2 * 60 * 60 * 1000;
  
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
  
  return true;
}

describe("Gamma Live Protection", () => {
  const NOW = 1700000000000;

  test("protects market that is in current gamma live set", () => {
    const m = { conditionId: "cond-1", status: "expired" };
    const snapshot = { ts: NOW - 10000, ids: ["cond-1", "cond-2"], prev_ids: [] };
    assert.strictEqual(isGammaLiveProtected(m, snapshot, NOW), true);
  });

  test("protects market that is in previous cycle (fault tolerance)", () => {
    const m = { conditionId: "cond-1", status: "expired" };
    const snapshot = { ts: NOW - 10000, ids: ["cond-2"], prev_ids: ["cond-1"] };
    assert.strictEqual(isGammaLiveProtected(m, snapshot, NOW), true);
  });

  test("does NOT protect market not in any gamma set", () => {
    const m = { conditionId: "cond-3", status: "expired" };
    const snapshot = { ts: NOW - 10000, ids: ["cond-1"], prev_ids: ["cond-2"] };
    assert.strictEqual(isGammaLiveProtected(m, snapshot, NOW), false);
  });

  test("does NOT protect if gamma snapshot is stale (>90s)", () => {
    const m = { conditionId: "cond-1", status: "expired" };
    const snapshot = { ts: NOW - 100000, ids: ["cond-1"], prev_ids: [] }; // 100s old
    assert.strictEqual(isGammaLiveProtected(m, snapshot, NOW), false);
  });

  test("does NOT protect if gamma snapshot is null", () => {
    const m = { conditionId: "cond-1", status: "expired" };
    assert.strictEqual(isGammaLiveProtected(m, null, NOW), false);
  });

  test("does NOT protect if market has been expired >2h (safety cap)", () => {
    const m = { conditionId: "cond-1", expired_at_ts: NOW - (2.1 * 60 * 60 * 1000) };
    const snapshot = { ts: NOW - 10000, ids: ["cond-1"], prev_ids: [] };
    assert.strictEqual(isGammaLiveProtected(m, snapshot, NOW), false);
  });

  test("DOES protect if market expired <2h ago", () => {
    const m = { conditionId: "cond-1", expired_at_ts: NOW - (1 * 60 * 60 * 1000) };
    const snapshot = { ts: NOW - 10000, ids: ["cond-1"], prev_ids: [] };
    assert.strictEqual(isGammaLiveProtected(m, snapshot, NOW), true);
  });

  test("protects market with no expired_at_ts (never expired before)", () => {
    const m = { conditionId: "cond-1" }; // No expired_at_ts
    const snapshot = { ts: NOW - 10000, ids: ["cond-1"], prev_ids: [] };
    assert.strictEqual(isGammaLiveProtected(m, snapshot, NOW), true);
  });

  test("snapshot exactly at 90s boundary is stale", () => {
    const m = { conditionId: "cond-1" };
    const snapshot = { ts: NOW - 90000, ids: ["cond-1"], prev_ids: [] };
    assert.strictEqual(isGammaLiveProtected(m, snapshot, NOW), false);
  });

  test("snapshot at 89s is fresh", () => {
    const m = { conditionId: "cond-1" };
    const snapshot = { ts: NOW - 89000, ids: ["cond-1"], prev_ids: [] };
    assert.strictEqual(isGammaLiveProtected(m, snapshot, NOW), true);
  });
});
