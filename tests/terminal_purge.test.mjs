// tests/terminal_purge.test.mjs
// Test terminal price purge logic

import { describe, test } from "node:test";
import assert from "node:assert";

// Simulate the terminal purge logic (extracted for testing)
function simulateTerminalPurge(watchlist, wsCache, openPaperSlugs, now, confirmMs = 30000) {
  const TERMINAL_THRESHOLD = 0.995;
  const purged = [];

  for (const [key, m] of Object.entries(watchlist)) {
    if (m.status !== "expired" && m.status !== "watching") continue;
    if (openPaperSlugs.has(m.slug)) continue;

    const yesToken = m.tokens?.yes_token_id;
    if (!yesToken) continue;

    const wsPrice = wsCache.get(yesToken);
    if (!wsPrice) continue;

    const isTerminal = (wsPrice.bestBid >= TERMINAL_THRESHOLD) || (wsPrice.bestAsk <= (1 - TERMINAL_THRESHOLD));
    if (!isTerminal) {
      if (m._terminal_first_seen_ts) delete m._terminal_first_seen_ts;
      continue;
    }

    if (!m._terminal_first_seen_ts) {
      m._terminal_first_seen_ts = now;
      continue;
    }

    const terminalAge = now - m._terminal_first_seen_ts;
    if (terminalAge < confirmMs) continue;

    purged.push(key);
    delete watchlist[key];
  }

  return purged;
}

describe("Terminal Price Purge", () => {
  const NOW = 1700000000000;

  function makeMarket(slug, status, yesTokenId, extras = {}) {
    return { slug, status, tokens: { yes_token_id: yesTokenId }, league: "esports", ...extras };
  }

  function makeWsCache(entries) {
    const cache = new Map();
    for (const [tokenId, bestBid, bestAsk] of entries) {
      cache.set(tokenId, { bestBid, bestAsk, lastUpdate: NOW });
    }
    return cache;
  }

  test("purges expired market with terminal bid ≥0.995 after confirmation", () => {
    const wl = { m1: makeMarket("cs2-test", "expired", "tok1", { _terminal_first_seen_ts: NOW - 31000 }) };
    const ws = makeWsCache([["tok1", 0.998, 1.0]]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, ["m1"]);
    assert.strictEqual(wl.m1, undefined);
  });

  test("purges watching market with terminal bid ≥0.995 after confirmation", () => {
    const wl = { m1: makeMarket("cs2-test", "watching", "tok1", { _terminal_first_seen_ts: NOW - 31000 }) };
    const ws = makeWsCache([["tok1", 0.999, 1.0]]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, ["m1"]);
  });

  test("purges market with terminal ask ≤0.005 (NO side won)", () => {
    const wl = { m1: makeMarket("cs2-test", "expired", "tok1", { _terminal_first_seen_ts: NOW - 31000 }) };
    const ws = makeWsCache([["tok1", 0.001, 0.003]]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, ["m1"]);
  });

  test("does NOT purge before confirmation window (anti-flicker)", () => {
    const wl = { m1: makeMarket("cs2-test", "expired", "tok1", { _terminal_first_seen_ts: NOW - 10000 }) };
    const ws = makeWsCache([["tok1", 0.998, 1.0]]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, []);
    assert.ok(wl.m1); // Still in watchlist
  });

  test("sets _terminal_first_seen_ts on first terminal detection", () => {
    const wl = { m1: makeMarket("cs2-test", "expired", "tok1") };
    const ws = makeWsCache([["tok1", 0.998, 1.0]]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, []);
    assert.strictEqual(wl.m1._terminal_first_seen_ts, NOW);
  });

  test("resets _terminal_first_seen_ts if price drops below terminal", () => {
    const wl = { m1: makeMarket("cs2-test", "expired", "tok1", { _terminal_first_seen_ts: NOW - 20000 }) };
    const ws = makeWsCache([["tok1", 0.90, 0.92]]); // Not terminal
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, []);
    assert.strictEqual(wl.m1._terminal_first_seen_ts, undefined); // Reset
  });

  test("NEVER purges if paper position is open (strict exclusion)", () => {
    const wl = { m1: makeMarket("cs2-test", "expired", "tok1", { _terminal_first_seen_ts: NOW - 60000 }) };
    const ws = makeWsCache([["tok1", 0.999, 1.0]]);
    const openPaperSlugs = new Set(["cs2-test"]);
    const purged = simulateTerminalPurge(wl, ws, openPaperSlugs, NOW);
    assert.deepStrictEqual(purged, []);
    assert.ok(wl.m1); // Still in watchlist
  });

  test("does NOT purge signaled markets (leave for resolution tracker)", () => {
    const wl = { m1: makeMarket("cs2-test", "signaled", "tok1", { _terminal_first_seen_ts: NOW - 60000 }) };
    const ws = makeWsCache([["tok1", 0.999, 1.0]]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, []);
  });

  test("does NOT purge pending_signal markets", () => {
    const wl = { m1: makeMarket("cs2-test", "pending_signal", "tok1", { _terminal_first_seen_ts: NOW - 60000 }) };
    const ws = makeWsCache([["tok1", 0.999, 1.0]]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, []);
  });

  test("skips market without yes_token_id", () => {
    const wl = { m1: { slug: "test", status: "expired", tokens: {} } };
    const ws = makeWsCache([]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, []);
  });

  test("skips market without WS price data (no cache)", () => {
    const wl = { m1: makeMarket("cs2-test", "expired", "tok1", { _terminal_first_seen_ts: NOW - 60000 }) };
    const ws = makeWsCache([]); // Empty cache
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, []);
  });

  test("purges multiple markets in same cycle", () => {
    const wl = {
      m1: makeMarket("cs2-a", "expired", "tok1", { _terminal_first_seen_ts: NOW - 40000 }),
      m2: makeMarket("cs2-b", "watching", "tok2", { _terminal_first_seen_ts: NOW - 35000 }),
      m3: makeMarket("cs2-c", "expired", "tok3"), // No confirmation yet
    };
    const ws = makeWsCache([["tok1", 0.999, 1.0], ["tok2", 0.996, 0.999], ["tok3", 0.998, 1.0]]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged.sort(), ["m1", "m2"]);
    assert.ok(wl.m3); // m3 just started confirmation
    assert.strictEqual(wl.m3._terminal_first_seen_ts, NOW);
  });

  test("exactly at threshold 0.995 is terminal", () => {
    const wl = { m1: makeMarket("cs2-test", "expired", "tok1", { _terminal_first_seen_ts: NOW - 31000 }) };
    const ws = makeWsCache([["tok1", 0.995, 0.998]]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, ["m1"]);
  });

  test("just below threshold 0.994 is NOT terminal", () => {
    const wl = { m1: makeMarket("cs2-test", "expired", "tok1", { _terminal_first_seen_ts: NOW - 31000 }) };
    const ws = makeWsCache([["tok1", 0.994, 0.998]]);
    const purged = simulateTerminalPurge(wl, ws, new Set(), NOW);
    assert.deepStrictEqual(purged, []);
    assert.strictEqual(wl.m1._terminal_first_seen_ts, undefined); // Reset because not terminal
  });
});
