/**
 * Health Server Tests
 * 
 * Validates HTTP endpoint, staleness calculations, and alert thresholds.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildHealthResponse, startHealthServer } from "../src/runtime/health_server.mjs";

describe("buildHealthResponse", () => {
  it("includes all required top-level fields", () => {
    const state = { watchlist: {}, runtime: { runs: 10, last_run_ts: Date.now(), health: {} } };
    const startedMs = Date.now() - 60000; // 1 min uptime
    const response = buildHealthResponse(state, startedMs, "abc1234");

    assert.ok(response.status);
    assert.ok(response.timestamp);
    assert.ok(response.uptime_seconds);
    assert.ok(response.pid);
    assert.ok(response.build_commit);
    assert.ok(response.loop);
    assert.ok(response.http);
    assert.ok(response.staleness);
    assert.ok(response.persistence);
    assert.ok(response.watchlist);
  });

  it("computes uptime correctly", () => {
    const state = { watchlist: {}, runtime: { health: {} } };
    const startedMs = Date.now() - 120000; // 2 minutes ago
    const response = buildHealthResponse(state, startedMs, "test");

    assert.ok(response.uptime_seconds >= 119 && response.uptime_seconds <= 121);
  });

  it("includes build commit", () => {
    const state = { watchlist: {}, runtime: { health: {} } };
    const response = buildHealthResponse(state, Date.now(), "abc1234");

    assert.equal(response.build_commit, "abc1234");
  });

  it("computes status counts correctly", () => {
    const state = {
      watchlist: {
        id1: { status: "watching" },
        id2: { status: "watching" },
        id3: { status: "pending_signal" },
        id4: { status: "signaled" },
        id5: { status: "expired" }
      },
      runtime: { health: {} }
    };
    const response = buildHealthResponse(state, Date.now(), "test");

    assert.equal(response.watchlist.total, 5);
    assert.equal(response.watchlist.by_status.watching, 2);
    assert.equal(response.watchlist.by_status.pending_signal, 1);
    assert.equal(response.watchlist.by_status.signaled, 1);
    assert.equal(response.watchlist.by_status.expired, 1);
  });

  it("computes HTTP success rate correctly", () => {
    const state = {
      watchlist: {},
      runtime: {
        health: {
          http_fallback_success_count: 980,
          http_fallback_fail_count: 20
        }
      }
    };
    const response = buildHealthResponse(state, Date.now(), "test");

    assert.equal(response.http.success_rate_percent, 98);
    assert.equal(response.http.success_count, 980);
    assert.equal(response.http.fail_count, 20);
    assert.equal(response.http.total_count, 1000);
  });

  it("handles zero HTTP requests gracefully", () => {
    const state = { watchlist: {}, runtime: { health: {} } };
    const response = buildHealthResponse(state, Date.now(), "test");

    assert.equal(response.http.success_rate_percent, 100); // default to 100% when no data
    assert.equal(response.http.total_count, 0);
  });

  it("computes staleness for signaled markets", () => {
    const now = Date.now();
    const state = {
      watchlist: {
        id1: { status: "signaled", last_price: { updated_ts: now - 30000 } }, // 30s old (not stale)
        id2: { status: "signaled", last_price: { updated_ts: now - 120000 } }, // 2min old (stale)
        id3: { status: "signaled", last_price: { updated_ts: now - 180000 } }, // 3min old (stale)
        id4: { status: "watching", last_price: { updated_ts: now - 300000 } } // not signaled, ignored
      },
      runtime: { health: {} }
    };
    const response = buildHealthResponse(state, now, "test");

    assert.equal(response.staleness.signaled_count, 3);
    assert.equal(response.staleness.stale_count, 2);
    assert.ok(Math.abs(response.staleness.percent_stale_signaled - 66.67) < 0.1);
    assert.equal(response.staleness.max_stale_signaled_seconds, 180);
  });

  it("returns zero staleness when no signaled markets", () => {
    const state = {
      watchlist: {
        id1: { status: "watching" },
        id2: { status: "pending_signal" }
      },
      runtime: { health: {} }
    };
    const response = buildHealthResponse(state, Date.now(), "test");

    assert.equal(response.staleness.percent_stale_signaled, 0);
    assert.equal(response.staleness.max_stale_signaled_seconds, 0);
    assert.equal(response.staleness.stale_count, 0);
    assert.equal(response.staleness.signaled_count, 0);
  });

  it("computes persistence stats correctly", () => {
    const now = Date.now();
    const state = {
      watchlist: {},
      runtime: {
        last_state_write_ts: now - 3000, // 3s ago
        health: {
          state_write_count: 100,
          state_write_skipped_count: 50
        }
      }
    };
    const response = buildHealthResponse(state, now, "test");

    assert.equal(response.persistence.last_write_age_seconds, 3);
    assert.equal(response.persistence.write_success_count, 100);
    assert.equal(response.persistence.write_skipped_count, 50);
  });

  it("computes loop stats correctly", () => {
    const now = Date.now();
    const state = {
      watchlist: {},
      runtime: {
        runs: 500,
        last_run_ts: now - 2000, // 2s ago
        health: {}
      }
    };
    const response = buildHealthResponse(state, now, "test");

    assert.equal(response.loop.runs, 500);
    assert.equal(response.loop.last_cycle_age_seconds, 2);
  });
});

describe("startHealthServer (integration)", () => {
  const testPort = 13210; // Use non-standard port to avoid conflicts

  it("starts server and responds to GET /health", async () => {
    const state = {
      watchlist: { id1: { status: "watching" } },
      runtime: { runs: 1, last_run_ts: Date.now(), health: {} }
    };

    const server = startHealthServer(state, { port: testPort, host: "127.0.0.1", startedMs: Date.now(), buildCommit: "test" });

    try {
      // Wait for server to bind
      await new Promise(resolve => setTimeout(resolve, 100));

      const response = await fetch(`http://127.0.0.1:${testPort}/health`);
      assert.equal(response.status, 200);

      const json = await response.json();
      assert.equal(json.status, "ok");
      assert.equal(json.watchlist.total, 1);
    } finally {
      server.server.close();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });

  it("returns 404 for non-/health paths", async () => {
    const state = { watchlist: {}, runtime: { health: {} } };
    const server = startHealthServer(state, { port: testPort, host: "127.0.0.1" });

    try {
      await new Promise(resolve => setTimeout(resolve, 100));

      const response = await fetch(`http://127.0.0.1:${testPort}/notfound`);
      assert.equal(response.status, 404);

      const json = await response.json();
      assert.equal(json.error, "Not found");
    } finally {
      server.server.close();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });

  it("returns 404 for non-GET methods", async () => {
    const state = { watchlist: {}, runtime: { health: {} } };
    const server = startHealthServer(state, { port: testPort, host: "127.0.0.1" });

    try {
      await new Promise(resolve => setTimeout(resolve, 100));

      const response = await fetch(`http://127.0.0.1:${testPort}/health`, { method: "POST" });
      assert.equal(response.status, 404);
    } finally {
      server.server.close();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });

  it("reflects live state updates", async () => {
    const state = {
      watchlist: { id1: { status: "watching" } },
      runtime: { runs: 1, health: {} }
    };

    const server = startHealthServer(state, { port: testPort, host: "127.0.0.1" });

    try {
      await new Promise(resolve => setTimeout(resolve, 100));

      // First request
      let response = await fetch(`http://127.0.0.1:${testPort}/health`);
      let json = await response.json();
      assert.equal(json.watchlist.total, 1);
      assert.equal(json.loop.runs, 1);

      // Mutate state (simulates loop update)
      state.watchlist.id2 = { status: "signaled" };
      state.runtime.runs = 2;

      // Second request should reflect changes
      response = await fetch(`http://127.0.0.1:${testPort}/health`);
      json = await response.json();
      assert.equal(json.watchlist.total, 2);
      assert.equal(json.loop.runs, 2);
    } finally {
      server.server.close();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });
});
