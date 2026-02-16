/**
 * Complementary Pricing Tests
 * 
 * Tests for binary market complementary pricing logic.
 * In binary markets: YES price + NO price = 1.00
 * 
 * Key rules:
 * - yes_best_ask = min(yes_book.asks[0], 1 - no_book.bids[0])  ← cheapest way to buy YES
 * - yes_best_bid = max(yes_book.bids[0], 1 - no_book.asks[0])  ← best way to sell YES
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Helper: compute complementary pricing
function computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk) {
  const yesSyntheticAsk = noBookBid != null ? (1 - noBookBid) : null;
  const yesSyntheticBid = noBookAsk != null ? (1 - noBookAsk) : null;

  let bestAsk = null;
  if (yesBookAsk != null && yesSyntheticAsk != null) {
    bestAsk = Math.min(yesBookAsk, yesSyntheticAsk);
  } else {
    bestAsk = yesBookAsk ?? yesSyntheticAsk;
  }

  let bestBid = null;
  if (yesBookBid != null && yesSyntheticBid != null) {
    bestBid = Math.max(yesBookBid, yesSyntheticBid);
  } else {
    bestBid = yesBookBid ?? yesSyntheticBid;
  }

  return { bestAsk, bestBid };
}

describe("Complementary Pricing", () => {
  it("Test 1: YES book empty, NO book has bids → synthetic ask from NO", () => {
    // Real case: cs2-faze-prv-2026-02-16-game1
    // yes_book.asks: [0.999, 0.998, 0.997]  ← what we should get
    // yes_book.bids: []
    // no_book.bids: [0.001, 0.002, 0.003]
    // no_book.asks: []
    
    const yesBookAsk = null;  // YES book has no asks (empty side)
    const yesBookBid = null;
    const noBookBid = 0.001;  // NO book best bid
    const noBookAsk = null;

    const { bestAsk, bestBid } = computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk);

    // Expected: bestAsk = 1 - 0.001 = 0.999 (synthetic from NO)
    assert.equal(bestAsk, 0.999);
    assert.equal(bestBid, null);
  });

  it("Test 2: YES book has bid, NO book has ask → synthetic bid from NO", () => {
    // yes_book.bids: [0.45]
    // yes_book.asks: []
    // no_book.asks: [0.52]
    // no_book.bids: []
    
    const yesBookAsk = null;
    const yesBookBid = 0.45;
    const noBookBid = null;
    const noBookAsk = 0.52;

    const { bestAsk, bestBid } = computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk);

    // Expected: bestBid = max(0.45, 1 - 0.52 = 0.48) = 0.48 (synthetic is better)
    assert.equal(bestAsk, null);
    assert.equal(bestBid, 0.48);
  });

  it("Test 3: Both books have liquidity → choose best prices", () => {
    // yes_book.asks: [0.60]
    // yes_book.bids: [0.55]
    // no_book.bids: [0.35]  → synthetic ask = 1 - 0.35 = 0.65
    // no_book.asks: [0.42]  → synthetic bid = 1 - 0.42 = 0.58
    
    const yesBookAsk = 0.60;
    const yesBookBid = 0.55;
    const noBookBid = 0.35;
    const noBookAsk = 0.42;

    const { bestAsk, bestBid } = computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk);

    // Expected: bestAsk = min(0.60, 0.65) = 0.60 (direct is better)
    //           bestBid = max(0.55, 0.58) = 0.58 (synthetic is better)
    assert.equal(bestAsk, 0.60);
    assert.ok(Math.abs(bestBid - 0.58) < 0.0001); // floating point tolerance
  });

  it("Test 4: Terminal market (99.95%) → synthetic should match", () => {
    // Real case: esports game market after game finished
    // yes_book.asks: [0.9995]
    // yes_book.bids: []
    // no_book.bids: [0.0005]
    // no_book.asks: []
    
    const yesBookAsk = 0.9995;
    const yesBookBid = null;
    const noBookBid = 0.0005;
    const noBookAsk = null;

    const { bestAsk, bestBid } = computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk);

    // Expected: bestAsk = min(0.9995, 1 - 0.0005 = 0.9995) = 0.9995
    assert.equal(bestAsk, 0.9995);
    assert.equal(bestBid, null);
  });

  it("Test 5: Only YES book exists (NO book unavailable) → use YES only", () => {
    // yes_book.asks: [0.75]
    // yes_book.bids: [0.70]
    // no_book: unavailable (all nulls)
    
    const yesBookAsk = 0.75;
    const yesBookBid = 0.70;
    const noBookBid = null;
    const noBookAsk = null;

    const { bestAsk, bestBid } = computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk);

    // Expected: use YES book directly (no complement available)
    assert.equal(bestAsk, 0.75);
    assert.equal(bestBid, 0.70);
  });

  it("Test 6: Only NO book exists (YES book unavailable) → use synthetic", () => {
    // yes_book: unavailable (all nulls)
    // no_book.bids: [0.30]
    // no_book.asks: [0.35]
    
    const yesBookAsk = null;
    const yesBookBid = null;
    const noBookBid = 0.30;
    const noBookAsk = 0.35;

    const { bestAsk, bestBid } = computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk);

    // Expected: bestAsk = 1 - 0.30 = 0.70
    //           bestBid = 1 - 0.35 = 0.65
    assert.equal(bestAsk, 0.70);
    assert.equal(bestBid, 0.65);
  });

  it("Test 7: Neither book exists → both null", () => {
    const yesBookAsk = null;
    const yesBookBid = null;
    const noBookBid = null;
    const noBookAsk = null;

    const { bestAsk, bestBid } = computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk);

    assert.equal(bestAsk, null);
    assert.equal(bestBid, null);
  });

  it("Test 8: Synthetic ask is worse than direct ask → choose direct", () => {
    // yes_book.asks: [0.55]
    // no_book.bids: [0.40]  → synthetic = 1 - 0.40 = 0.60
    
    const yesBookAsk = 0.55;
    const yesBookBid = null;
    const noBookBid = 0.40;
    const noBookAsk = null;

    const { bestAsk, bestBid } = computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk);

    // Expected: choose direct (0.55 < 0.60)
    assert.equal(bestAsk, 0.55);
  });

  it("Test 9: Synthetic bid is worse than direct bid → choose direct", () => {
    // yes_book.bids: [0.60]
    // no_book.asks: [0.45]  → synthetic = 1 - 0.45 = 0.55
    
    const yesBookAsk = null;
    const yesBookBid = 0.60;
    const noBookBid = null;
    const noBookAsk = 0.45;

    const { bestAsk, bestBid } = computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk);

    // Expected: choose direct (0.60 > 0.55)
    assert.equal(bestBid, 0.60);
  });

  it("Test 10: Complementary math identity (ask + bid ≈ 1.00)", () => {
    // When we have perfect two-sided complement:
    // no_book.bids: [0.30]  → yes_ask = 0.70
    // no_book.asks: [0.30]  → yes_bid = 0.70
    
    const yesBookAsk = null;
    const yesBookBid = null;
    const noBookBid = 0.30;
    const noBookAsk = 0.30;

    const { bestAsk, bestBid } = computeComplementaryPrice(yesBookAsk, yesBookBid, noBookBid, noBookAsk);

    assert.equal(bestAsk, 0.70);
    assert.equal(bestBid, 0.70);
    // In this case: ask + bid = 0.70 + 0.70 = 1.40 (spread is 0, which is fine)
    // The complement rule holds: 1 - no_bid = yes_ask, 1 - no_ask = yes_bid
  });
});
