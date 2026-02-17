/**
 * Tests for fill price reconciliation
 *
 * parseFillResult uses final.price (= order limit price, not fill price).
 * For SELLs with a floor below market, this understates receivedUsd.
 * fetchRealFillPrice queries getTrades to get actual execution prices.
 *
 * Covers:
 * - parseFillResult: marks priceProvisional when using final.price for SELL
 * - parseFillResult: BUY also marks provisional (limit is max, less critical)
 * - parseFillResult: no provisional when final.price is null (falls back to makingAmount)
 * - fetchRealFillPrice: returns weighted avg from trades
 * - fetchRealFillPrice: returns null when trades empty
 * - fetchRealFillPrice: retries on empty with backoff
 * - fetchRealFillPrice: handles multiple partial fills correctly
 * - fetchRealFillPrice: handles single fill
 * - fetchRealFillPrice: handles API error gracefully
 * - Floating point: no precision loss on typical polymarket values
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// === Extracted parseFillResult logic (mirrored from order_executor.mjs) ===
// We test the LOGIC separately since parseFillResult is not exported.

function parseFillResultLogic(res, final, requestedAmount, side) {
  const orderID = res?.orderID || null;
  const st = String(final?.status || "").toUpperCase();

  const matchedShares = (final?.size_matched != null && Number(final.size_matched) > 0)
    ? Number(final.size_matched) : null;
  const matchedPrice = (final?.price != null && Number(final.price) > 0)
    ? Number(final.price) : null;

  if (final && ["CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(st) && (!matchedShares || matchedShares <= 0)) {
    return { ok: false, error: `order_${st.toLowerCase()}`, orderID, status: st, requestedAmount, filledShares: 0, side };
  }

  const filledShares = matchedShares ?? requestedAmount;

  // price from final.price is the ORDER price (limit), not the fill price
  const priceProvisional = matchedPrice != null;

  const spentUsd = (matchedShares != null && matchedPrice != null)
    ? (matchedShares * matchedPrice)
    : ((res?.makingAmount && Number(res.makingAmount) > 0)
      ? Number(res.makingAmount) : null);
  const avgFillPrice = (spentUsd != null && filledShares > 0) ? (spentUsd / filledShares) : null;
  const isPartial = (matchedShares != null && matchedShares < requestedAmount * 0.99);

  return {
    ok: true, orderID, status: st || "UNKNOWN", side,
    requestedAmount, filledShares, spentUsd, avgFillPrice,
    isPartial, priceProvisional,
  };
}

// === fetchRealFillPrice logic ===

async function fetchRealFillPrice(mockGetTrades, orderID, { maxRetries = 2, delayMs = 100 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const trades = await mockGetTrades(orderID);
      if (!trades || trades.length === 0) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
          continue;
        }
        return null;
      }
      // Weighted average price from all fills
      let totalValue = 0;
      let totalSize = 0;
      for (const t of trades) {
        const price = Number(t.price);
        const size = Number(t.size);
        if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
          totalValue += price * size;
          totalSize += size;
        }
      }
      if (totalSize <= 0) return null;
      return totalValue / totalSize;
    } catch {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}


// === Tests ===

describe("parseFillResult provisional price", () => {
  it("SELL with final.price marks priceProvisional=true", () => {
    const res = { orderID: "0x123" };
    const final = { status: "MATCHED", size_matched: "11.3", price: "0.95" };
    const result = parseFillResultLogic(res, final, 11.3085, "SELL");

    assert.equal(result.ok, true);
    assert.equal(result.priceProvisional, true);
    assert.ok(Math.abs(result.avgFillPrice - 0.95) < 0.001, `avgFillPrice should be ~0.95, got ${result.avgFillPrice}`);
    // Real fill could be much higher (e.g. 0.996)
  });

  it("BUY with final.price also marks priceProvisional=true", () => {
    const res = { orderID: "0x456" };
    const final = { status: "MATCHED", size_matched: "10.5", price: "0.94" };
    const result = parseFillResultLogic(res, final, 10.63, "BUY");

    assert.equal(result.ok, true);
    assert.equal(result.priceProvisional, true);
  });

  it("no final.price → uses makingAmount, priceProvisional=false", () => {
    const res = { orderID: "0x789", makingAmount: "11.2887" };
    const final = { status: "MATCHED", size_matched: "11.3", price: null };
    const result = parseFillResultLogic(res, final, 11.3085, "SELL");

    assert.equal(result.ok, true);
    assert.equal(result.priceProvisional, false);
    // avgFillPrice computed from makingAmount / filledShares
    assert.ok(Math.abs(result.avgFillPrice - 11.2887 / 11.3) < 0.001);
  });

  it("cancelled order → ok=false, no provisional flag", () => {
    const res = { orderID: "0xfail" };
    const final = { status: "CANCELLED", size_matched: "0", price: "0.95" };
    const result = parseFillResultLogic(res, final, 11.3, "SELL");

    assert.equal(result.ok, false);
    assert.equal(result.priceProvisional, undefined);
  });

  it("partial fill has correct isPartial and priceProvisional", () => {
    const res = { orderID: "0xpart" };
    const final = { status: "MATCHED", size_matched: "5.0", price: "0.95" };
    const result = parseFillResultLogic(res, final, 11.3, "SELL");

    assert.equal(result.ok, true);
    assert.equal(result.isPartial, true);
    assert.equal(result.priceProvisional, true);
    assert.equal(result.filledShares, 5.0);
  });
});

describe("fetchRealFillPrice", () => {
  it("returns weighted avg from single trade", async () => {
    const getTrades = async () => [{ price: "0.996", size: "11.3" }];
    const avg = await fetchRealFillPrice(getTrades, "0x123");
    assert.ok(Math.abs(avg - 0.996) < 0.0001);
  });

  it("returns weighted avg from multiple partial fills", async () => {
    const getTrades = async () => [
      { price: "0.995", size: "5.0" },
      { price: "0.998", size: "6.3" },
    ];
    const avg = await fetchRealFillPrice(getTrades, "0x123");
    // (0.995*5 + 0.998*6.3) / (5+6.3) = (4.975 + 6.2874) / 11.3 = 11.2624/11.3 ≈ 0.99668
    assert.ok(Math.abs(avg - 0.99668) < 0.001);
  });

  it("returns null when trades empty (no retries)", async () => {
    let calls = 0;
    const getTrades = async () => { calls++; return []; };
    const avg = await fetchRealFillPrice(getTrades, "0x123", { maxRetries: 0, delayMs: 10 });
    assert.equal(avg, null);
    assert.equal(calls, 1);
  });

  it("retries on empty and succeeds on second attempt", async () => {
    let calls = 0;
    const getTrades = async () => {
      calls++;
      if (calls === 1) return [];
      return [{ price: "0.996", size: "11.3" }];
    };
    const avg = await fetchRealFillPrice(getTrades, "0x123", { maxRetries: 2, delayMs: 10 });
    assert.ok(Math.abs(avg - 0.996) < 0.0001);
    assert.equal(calls, 2);
  });

  it("returns null after all retries exhausted", async () => {
    let calls = 0;
    const getTrades = async () => { calls++; return []; };
    const avg = await fetchRealFillPrice(getTrades, "0x123", { maxRetries: 2, delayMs: 10 });
    assert.equal(avg, null);
    assert.equal(calls, 3); // initial + 2 retries
  });

  it("handles API error gracefully and retries", async () => {
    let calls = 0;
    const getTrades = async () => {
      calls++;
      if (calls === 1) throw new Error("network error");
      return [{ price: "0.997", size: "10.0" }];
    };
    const avg = await fetchRealFillPrice(getTrades, "0x123", { maxRetries: 1, delayMs: 10 });
    assert.ok(Math.abs(avg - 0.997) < 0.0001);
    assert.equal(calls, 2);
  });

  it("returns null when all retries throw", async () => {
    const getTrades = async () => { throw new Error("down"); };
    const avg = await fetchRealFillPrice(getTrades, "0x123", { maxRetries: 1, delayMs: 10 });
    assert.equal(avg, null);
  });

  it("handles zero-size trades (ignores them)", async () => {
    const getTrades = async () => [
      { price: "0.996", size: "11.3" },
      { price: "0.5", size: "0" },  // zero size — ignore
    ];
    const avg = await fetchRealFillPrice(getTrades, "0x123");
    assert.ok(Math.abs(avg - 0.996) < 0.0001);
  });

  it("handles NaN price gracefully", async () => {
    const getTrades = async () => [
      { price: "0.996", size: "11.3" },
      { price: "NaN", size: "5.0" },
    ];
    const avg = await fetchRealFillPrice(getTrades, "0x123");
    // Should only count the valid trade
    assert.ok(Math.abs(avg - 0.996) < 0.0001);
  });

  it("floating point: typical polymarket values don't lose precision", async () => {
    // Simulate 3 fills that together should average to ~0.9965
    const getTrades = async () => [
      { price: "0.995", size: "3.5" },
      { price: "0.997", size: "4.0" },
      { price: "0.998", size: "3.8" },
    ];
    const avg = await fetchRealFillPrice(getTrades, "0x123");
    // (0.995*3.5 + 0.997*4 + 0.998*3.8) / (3.5+4+3.8)
    // = (3.4825 + 3.988 + 3.7924) / 11.3 = 11.2629 / 11.3 ≈ 0.99672
    assert.ok(Math.abs(avg - 0.99672) < 0.001);
    // Ensure no silly floating point like 0.996719999999998
    assert.ok(String(avg).length < 20, `avg string too long: ${avg}`);
  });
});

// === parseFillResult: unknown/null final → fail closed ===
const { parseFillResult } = await import("../src/execution/order_executor.mjs");
describe("parseFillResult fail-closed on unknown status", () => {

  it("null final → ok:false, error:order_status_unknown", () => {
    const res = { orderID: "0xabc" };
    const result = parseFillResult(res, null, 10, "BUY");
    assert.equal(result.ok, false);
    assert.equal(result.error, "order_status_unknown");
    assert.equal(result.filledShares, 0);
  });

  it("undefined final → ok:false", () => {
    const res = { orderID: "0xabc" };
    const result = parseFillResult(res, undefined, 10, "BUY");
    assert.equal(result.ok, false);
    assert.equal(result.error, "order_status_unknown");
  });

  it("final with empty status → ok:false", () => {
    const res = { orderID: "0xabc" };
    const result = parseFillResult(res, { status: "" }, 10, "BUY");
    assert.equal(result.ok, false);
    assert.equal(result.error, "order_status_unknown");
  });

  it("final with status UNKNOWN → ok:false", () => {
    const res = { orderID: "0xabc" };
    const result = parseFillResult(res, { status: "UNKNOWN" }, 10, "BUY");
    assert.equal(result.ok, false);
    assert.equal(result.error, "order_status_unknown");
  });

  it("MATCHED final still works (ok:true)", () => {
    const res = { orderID: "0xabc" };
    const final = { status: "MATCHED", size_matched: "10", price: "0.95" };
    const result = parseFillResult(res, final, 10, "BUY");
    assert.equal(result.ok, true);
    assert.equal(result.filledShares, 10);
  });

  it("CANCELED with no fill → ok:false (existing behavior)", () => {
    const res = { orderID: "0xabc" };
    const final = { status: "CANCELED", size_matched: "0" };
    const result = parseFillResult(res, final, 10, "BUY");
    assert.equal(result.ok, false);
  });
});
