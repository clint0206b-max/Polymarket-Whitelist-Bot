// tests/purge_gates.test.mjs
// Test purge gates logic: book stale, quote incomplete, tradeability degraded

import { describe, test } from "node:test";
import assert from "node:assert";

// Mock minimal loop context for testing gate tracking
function mockMarket(overrides = {}) {
  return {
    slug: "test-market",
    league: "cbb",
    status: "watching",
    purge_gates: null,
    last_price: null,
    liquidity: null,
    ...overrides
  };
}

function mockConfig(overrides = {}) {
  return {
    purge: {
      stale_book_minutes: 15,
      stale_quote_incomplete_minutes: 10,
      stale_tradeability_minutes: 12,
      ...overrides.purge
    },
    filters: {
      EPS: 1e-6,
      min_prob: 0.94,
      max_entry_price: 0.97,
      max_spread: 0.02,
      min_exit_depth_usd_bid: 2000,
      min_entry_depth_usd_ask: 1000,
      ...overrides.filters
    }
  };
}

// Simulate gate initialization when book is successfully fetched
function initPurgeGates(m, tNow) {
  if (!m.purge_gates) {
    m.purge_gates = {
      first_incomplete_quote_ts: null,
      first_bad_tradeability_ts: null,
      last_book_update_ts: tNow
    };
  }
  m.purge_gates.last_book_update_ts = tNow;
}

// Simulate quote complete path (reset incomplete gate)
function trackQuoteComplete(m, tNow) {
  initPurgeGates(m, tNow);
  m.purge_gates.first_incomplete_quote_ts = null;
}

// Simulate quote incomplete path (track gate)
function trackQuoteIncomplete(m, tNow) {
  if (!m.purge_gates) {
    m.purge_gates = {
      first_incomplete_quote_ts: tNow,
      first_bad_tradeability_ts: null,
      last_book_update_ts: tNow
    };
  } else if (m.purge_gates.first_incomplete_quote_ts == null) {
    m.purge_gates.first_incomplete_quote_ts = tNow;
  }
}

// Simulate tradeability gate tracking (spread+depth)
function trackTradeability(m, tNow, spreadPass, depthPass) {
  if (!spreadPass && !depthPass) {
    // Both fail: track first occurrence
    if (!m.purge_gates) {
      m.purge_gates = {
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: tNow,
        last_book_update_ts: tNow
      };
    } else if (m.purge_gates.first_bad_tradeability_ts == null) {
      m.purge_gates.first_bad_tradeability_ts = tNow;
    }
  } else if (spreadPass || depthPass) {
    // At least one passes: reset gate
    if (m.purge_gates) {
      m.purge_gates.first_bad_tradeability_ts = null;
    }
  }
}

// Simulate purge check (returns purgeReason or null)
function checkPurgeGates(m, tNow, cfg) {
  if (m.status !== "watching" || !m.purge_gates) {
    return null;
  }

  const gates = m.purge_gates;
  const staleBookMin = Number(cfg?.purge?.stale_book_minutes || 15);
  const staleQuoteMin = Number(cfg?.purge?.stale_quote_incomplete_minutes || 10);
  const staleTradeMin = Number(cfg?.purge?.stale_tradeability_minutes || 12);

  const bookStaleSec = gates.last_book_update_ts ? (tNow - gates.last_book_update_ts) / 1000 : null;
  const quoteStaleSec = gates.first_incomplete_quote_ts ? (tNow - gates.first_incomplete_quote_ts) / 1000 : null;
  const tradeStaleSec = gates.first_bad_tradeability_ts ? (tNow - gates.first_bad_tradeability_ts) / 1000 : null;

  // Rule A: Book stale
  if (bookStaleSec != null && bookStaleSec > staleBookMin * 60) {
    return "purge_book_stale";
  }
  // Rule B: Quote incomplete
  if (quoteStaleSec != null && quoteStaleSec > staleQuoteMin * 60) {
    return "purge_quote_incomplete";
  }
  // Rule C: Tradeability degraded
  if (tradeStaleSec != null && tradeStaleSec > staleTradeMin * 60) {
    return "purge_tradeability_degraded";
  }

  return null;
}

describe("Purge Gates - Initialization", () => {
  test("initPurgeGates creates gates object", () => {
    const m = mockMarket();
    const tNow = Date.now();
    initPurgeGates(m, tNow);
    
    assert.ok(m.purge_gates);
    assert.strictEqual(m.purge_gates.last_book_update_ts, tNow);
    assert.strictEqual(m.purge_gates.first_incomplete_quote_ts, null);
    assert.strictEqual(m.purge_gates.first_bad_tradeability_ts, null);
  });

  test("initPurgeGates updates last_book_update_ts if gates exist", () => {
    const m = mockMarket({
      purge_gates: {
        last_book_update_ts: 1000,
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: null
      }
    });
    const tNow = Date.now();
    initPurgeGates(m, tNow);
    
    assert.strictEqual(m.purge_gates.last_book_update_ts, tNow);
  });
});

describe("Purge Gates - Quote Incomplete Tracking", () => {
  test("trackQuoteIncomplete sets first_incomplete_quote_ts on first occurrence", () => {
    const m = mockMarket();
    const tNow = Date.now();
    trackQuoteIncomplete(m, tNow);
    
    assert.strictEqual(m.purge_gates.first_incomplete_quote_ts, tNow);
  });

  test("trackQuoteIncomplete does NOT update timestamp if already set", () => {
    const tFirst = Date.now() - 5000;
    const m = mockMarket({
      purge_gates: {
        first_incomplete_quote_ts: tFirst,
        first_bad_tradeability_ts: null,
        last_book_update_ts: tFirst
      }
    });
    const tNow = Date.now();
    trackQuoteIncomplete(m, tNow);
    
    // Should still be tFirst, not tNow
    assert.strictEqual(m.purge_gates.first_incomplete_quote_ts, tFirst);
  });

  test("trackQuoteComplete resets first_incomplete_quote_ts", () => {
    const tFirst = Date.now() - 5000;
    const m = mockMarket({
      purge_gates: {
        first_incomplete_quote_ts: tFirst,
        first_bad_tradeability_ts: null,
        last_book_update_ts: tFirst
      }
    });
    const tNow = Date.now();
    trackQuoteComplete(m, tNow);
    
    assert.strictEqual(m.purge_gates.first_incomplete_quote_ts, null);
    assert.strictEqual(m.purge_gates.last_book_update_ts, tNow);
  });
});

describe("Purge Gates - Tradeability Tracking", () => {
  test("trackTradeability sets first_bad_tradeability_ts when both fail", () => {
    const m = mockMarket();
    const tNow = Date.now();
    trackTradeability(m, tNow, false, false); // spreadPass=false, depthPass=false
    
    assert.strictEqual(m.purge_gates.first_bad_tradeability_ts, tNow);
  });

  test("trackTradeability does NOT update timestamp if already set (both still failing)", () => {
    const tFirst = Date.now() - 5000;
    const m = mockMarket({
      purge_gates: {
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: tFirst,
        last_book_update_ts: tFirst
      }
    });
    const tNow = Date.now();
    trackTradeability(m, tNow, false, false);
    
    // Should still be tFirst
    assert.strictEqual(m.purge_gates.first_bad_tradeability_ts, tFirst);
  });

  test("trackTradeability resets when spread passes (depth still fails)", () => {
    const tFirst = Date.now() - 5000;
    const m = mockMarket({
      purge_gates: {
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: tFirst,
        last_book_update_ts: tFirst
      }
    });
    const tNow = Date.now();
    trackTradeability(m, tNow, true, false); // spreadPass=true, depthPass=false
    
    // Reset because at least one passes
    assert.strictEqual(m.purge_gates.first_bad_tradeability_ts, null);
  });

  test("trackTradeability resets when depth passes (spread still fails)", () => {
    const tFirst = Date.now() - 5000;
    const m = mockMarket({
      purge_gates: {
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: tFirst,
        last_book_update_ts: tFirst
      }
    });
    const tNow = Date.now();
    trackTradeability(m, tNow, false, true); // spreadPass=false, depthPass=true
    
    // Reset because at least one passes
    assert.strictEqual(m.purge_gates.first_bad_tradeability_ts, null);
  });

  test("trackTradeability resets when both pass", () => {
    const tFirst = Date.now() - 5000;
    const m = mockMarket({
      purge_gates: {
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: tFirst,
        last_book_update_ts: tFirst
      }
    });
    const tNow = Date.now();
    trackTradeability(m, tNow, true, true); // both pass
    
    assert.strictEqual(m.purge_gates.first_bad_tradeability_ts, null);
  });

  test("trackTradeability does NOT set gate when only spread fails (depth passes)", () => {
    const tFirst = Date.now() - 1000;
    const m = mockMarket({
      purge_gates: {
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: null,
        last_book_update_ts: tFirst
      }
    });
    const tNow = Date.now();
    trackTradeability(m, tNow, false, true); // spreadPass=false, depthPass=true
    
    // Gate should NOT be set (only one failing, reset triggers)
    assert.strictEqual(m.purge_gates.first_bad_tradeability_ts, null);
  });

  test("trackTradeability does NOT set gate when only depth fails (spread passes)", () => {
    const tFirst = Date.now() - 1000;
    const m = mockMarket({
      purge_gates: {
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: null,
        last_book_update_ts: tFirst
      }
    });
    const tNow = Date.now();
    trackTradeability(m, tNow, true, false); // spreadPass=true, depthPass=false
    
    // Gate should NOT be set (only one failing, reset triggers)
    assert.strictEqual(m.purge_gates.first_bad_tradeability_ts, null);
  });
});

describe("Purge Gates - Purge Decisions", () => {
  test("purge_book_stale triggers after 15 min", () => {
    const tFirst = Date.now() - (15.5 * 60 * 1000); // 15.5 minutes ago
    const m = mockMarket({
      purge_gates: {
        last_book_update_ts: tFirst,
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: null
      }
    });
    const cfg = mockConfig();
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    assert.strictEqual(reason, "purge_book_stale");
  });

  test("purge_book_stale does NOT trigger before 15 min", () => {
    const tFirst = Date.now() - (14.5 * 60 * 1000); // 14.5 minutes ago
    const m = mockMarket({
      purge_gates: {
        last_book_update_ts: tFirst,
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: null
      }
    });
    const cfg = mockConfig();
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    assert.strictEqual(reason, null);
  });

  test("purge_quote_incomplete triggers after 10 min", () => {
    const tFirst = Date.now() - (10.5 * 60 * 1000); // 10.5 minutes ago
    const m = mockMarket({
      purge_gates: {
        last_book_update_ts: Date.now() - 1000, // book updated recently
        first_incomplete_quote_ts: tFirst,
        first_bad_tradeability_ts: null
      }
    });
    const cfg = mockConfig();
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    assert.strictEqual(reason, "purge_quote_incomplete");
  });

  test("purge_quote_incomplete does NOT trigger before 10 min", () => {
    const tFirst = Date.now() - (9.5 * 60 * 1000); // 9.5 minutes ago
    const m = mockMarket({
      purge_gates: {
        last_book_update_ts: Date.now() - 1000,
        first_incomplete_quote_ts: tFirst,
        first_bad_tradeability_ts: null
      }
    });
    const cfg = mockConfig();
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    assert.strictEqual(reason, null);
  });

  test("purge_tradeability_degraded triggers after 12 min", () => {
    const tFirst = Date.now() - (12.5 * 60 * 1000); // 12.5 minutes ago
    const m = mockMarket({
      purge_gates: {
        last_book_update_ts: Date.now() - 1000,
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: tFirst
      }
    });
    const cfg = mockConfig();
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    assert.strictEqual(reason, "purge_tradeability_degraded");
  });

  test("purge_tradeability_degraded does NOT trigger before 12 min", () => {
    const tFirst = Date.now() - (11.5 * 60 * 1000); // 11.5 minutes ago
    const m = mockMarket({
      purge_gates: {
        last_book_update_ts: Date.now() - 1000,
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: tFirst
      }
    });
    const cfg = mockConfig();
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    assert.strictEqual(reason, null);
  });

  test("purge respects custom config thresholds", () => {
    const tFirst = Date.now() - (6 * 60 * 1000); // 6 minutes ago
    const m = mockMarket({
      purge_gates: {
        last_book_update_ts: tFirst,
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: null
      }
    });
    const cfg = mockConfig({
      purge: {
        stale_book_minutes: 5, // custom: 5 min instead of 15
        stale_quote_incomplete_minutes: 10,
        stale_tradeability_minutes: 12
      }
    });
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    // Should trigger with custom 5 min threshold
    assert.strictEqual(reason, "purge_book_stale");
  });

  test("purge does NOT trigger for non-watching status", () => {
    const tFirst = Date.now() - (20 * 60 * 1000); // 20 minutes ago
    const m = mockMarket({
      status: "pending_signal", // not watching
      purge_gates: {
        last_book_update_ts: tFirst,
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: null
      }
    });
    const cfg = mockConfig();
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    assert.strictEqual(reason, null);
  });

  test("purge priority: book stale > quote incomplete > tradeability", () => {
    const tBook = Date.now() - (16 * 60 * 1000); // 16 min
    const tQuote = Date.now() - (11 * 60 * 1000); // 11 min
    const tTrade = Date.now() - (13 * 60 * 1000); // 13 min
    const m = mockMarket({
      purge_gates: {
        last_book_update_ts: tBook,
        first_incomplete_quote_ts: tQuote,
        first_bad_tradeability_ts: tTrade
      }
    });
    const cfg = mockConfig();
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    // Book stale should win (highest priority)
    assert.strictEqual(reason, "purge_book_stale");
  });
});

describe("Purge Gates - Edge Cases", () => {
  test("no purge gates object → no purge", () => {
    const m = mockMarket({ purge_gates: null });
    const cfg = mockConfig();
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    assert.strictEqual(reason, null);
  });

  test("all gates null → no purge", () => {
    const m = mockMarket({
      purge_gates: {
        last_book_update_ts: null,
        first_incomplete_quote_ts: null,
        first_bad_tradeability_ts: null
      }
    });
    const cfg = mockConfig();
    const tNow = Date.now();
    const reason = checkPurgeGates(m, tNow, cfg);
    
    assert.strictEqual(reason, null);
  });

  test("trackTradeability handles missing purge_gates gracefully", () => {
    const m = mockMarket({ purge_gates: null });
    const tNow = Date.now();
    
    // Should create purge_gates when both fail
    trackTradeability(m, tNow, false, false);
    assert.ok(m.purge_gates);
    assert.strictEqual(m.purge_gates.first_bad_tradeability_ts, tNow);
  });

  test("trackTradeability resets on null purge_gates when at least one passes", () => {
    const m = mockMarket({ purge_gates: null });
    const tNow = Date.now();
    
    // Should NOT create purge_gates when at least one passes
    trackTradeability(m, tNow, true, false);
    assert.strictEqual(m.purge_gates, null);
  });
});
