/**
 * Tests for watchlist sort order (closest to entry on top).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Extract the sort logic from health_server.mjs
const statusOrder = { signaled: 0, pending_signal: 1, pending_entered: 1, watching: 2, expired: 3 };

function sortWatchlist(items) {
  return [...items].sort((a, b) => {
    const sa = statusOrder[a.status] ?? 9;
    const sb = statusOrder[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    const askA = Number(a.last_price?.yes_best_ask ?? 0);
    const askB = Number(b.last_price?.yes_best_ask ?? 0);
    return askB - askA;
  });
}

describe("watchlist sort", () => {
  it("signaled comes before watching", () => {
    const items = [
      { slug: "w", status: "watching", last_price: { yes_best_ask: 0.99 } },
      { slug: "s", status: "signaled", last_price: { yes_best_ask: 0.50 } },
    ];
    const sorted = sortWatchlist(items);
    assert.equal(sorted[0].slug, "s");
    assert.equal(sorted[1].slug, "w");
  });

  it("signaled comes before expired", () => {
    const items = [
      { slug: "e", status: "expired", last_price: { yes_best_ask: 0.99 } },
      { slug: "s", status: "signaled", last_price: { yes_best_ask: 0.50 } },
    ];
    const sorted = sortWatchlist(items);
    assert.equal(sorted[0].slug, "s");
  });

  it("pending_signal comes before watching", () => {
    const items = [
      { slug: "w", status: "watching", last_price: { yes_best_ask: 0.99 } },
      { slug: "p", status: "pending_signal", last_price: { yes_best_ask: 0.50 } },
    ];
    const sorted = sortWatchlist(items);
    assert.equal(sorted[0].slug, "p");
  });

  it("watching sorted by ask descending (highest ask first)", () => {
    const items = [
      { slug: "low", status: "watching", last_price: { yes_best_ask: 0.70 } },
      { slug: "high", status: "watching", last_price: { yes_best_ask: 0.92 } },
      { slug: "mid", status: "watching", last_price: { yes_best_ask: 0.85 } },
    ];
    const sorted = sortWatchlist(items);
    assert.equal(sorted[0].slug, "high");
    assert.equal(sorted[1].slug, "mid");
    assert.equal(sorted[2].slug, "low");
  });

  it("expired sorted by ask descending", () => {
    const items = [
      { slug: "e1", status: "expired", last_price: { yes_best_ask: 0.30 } },
      { slug: "e2", status: "expired", last_price: { yes_best_ask: 0.80 } },
    ];
    const sorted = sortWatchlist(items);
    assert.equal(sorted[0].slug, "e2");
  });

  it("missing ask treated as 0 (goes to bottom)", () => {
    const items = [
      { slug: "no-ask", status: "watching", last_price: {} },
      { slug: "has-ask", status: "watching", last_price: { yes_best_ask: 0.85 } },
    ];
    const sorted = sortWatchlist(items);
    assert.equal(sorted[0].slug, "has-ask");
    assert.equal(sorted[1].slug, "no-ask");
  });

  it("null last_price treated as ask=0", () => {
    const items = [
      { slug: "null", status: "watching", last_price: null },
      { slug: "ok", status: "watching", last_price: { yes_best_ask: 0.90 } },
    ];
    const sorted = sortWatchlist(items);
    assert.equal(sorted[0].slug, "ok");
  });

  it("unknown status goes to bottom", () => {
    const items = [
      { slug: "weird", status: "unknown_status", last_price: { yes_best_ask: 0.99 } },
      { slug: "w", status: "watching", last_price: { yes_best_ask: 0.50 } },
    ];
    const sorted = sortWatchlist(items);
    assert.equal(sorted[0].slug, "w");
    assert.equal(sorted[1].slug, "weird");
  });

  it("full mixed scenario: signaled > pending > watching(by ask) > expired", () => {
    const items = [
      { slug: "exp", status: "expired", last_price: { yes_best_ask: 0.99 } },
      { slug: "w-low", status: "watching", last_price: { yes_best_ask: 0.60 } },
      { slug: "sig", status: "signaled", last_price: { yes_best_ask: 0.95 } },
      { slug: "w-high", status: "watching", last_price: { yes_best_ask: 0.91 } },
      { slug: "pend", status: "pending_signal", last_price: { yes_best_ask: 0.94 } },
    ];
    const sorted = sortWatchlist(items);
    assert.equal(sorted[0].slug, "sig");
    assert.equal(sorted[1].slug, "pend");
    assert.equal(sorted[2].slug, "w-high");
    assert.equal(sorted[3].slug, "w-low");
    assert.equal(sorted[4].slug, "exp");
  });

  it("stable sort: same status and ask keeps original order", () => {
    const items = [
      { slug: "a", status: "watching", last_price: { yes_best_ask: 0.90 } },
      { slug: "b", status: "watching", last_price: { yes_best_ask: 0.90 } },
    ];
    const sorted = sortWatchlist(items);
    assert.equal(sorted[0].slug, "a");
    assert.equal(sorted[1].slug, "b");
  });
});
