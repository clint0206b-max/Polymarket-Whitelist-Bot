import { describe, test } from "node:test";
import assert from "node:assert";
import { SLBreachTracker } from "../src/clob/sl_breach_tracker.mjs";

describe("SLBreachTracker", () => {
  test("ignores tokens without positions", () => {
    const t = new SLBreachTracker();
    t.onPriceUpdate("tok1", 0.30, 0.35, true);
    assert.strictEqual(t.episodes.size, 0);
  });

  test("opens episode when SL breached (bid <= slBid, spread ok)", () => {
    const t = new SLBreachTracker();
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.50, emergencyBid: 0.15, slug: "test" }]);
    t.onPriceUpdate("tok1", 0.35, 0.40, true);
    assert.strictEqual(t.episodes.size, 1);
    assert.strictEqual(t.stats.episodes_opened, 1);
    const ep = t.episodes.get("tok1");
    assert.strictEqual(ep.breachBid, 0.35);
    assert.strictEqual(ep.wsHealthy, true);
  });

  test("does NOT open episode when bid > slBid", () => {
    const t = new SLBreachTracker();
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.50, emergencyBid: 0.15, slug: "test" }]);
    t.onPriceUpdate("tok1", 0.45, 0.50, true);
    assert.strictEqual(t.episodes.size, 0);
  });

  test("does NOT open episode when spread too wide and not emergency", () => {
    const t = new SLBreachTracker();
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.10, emergencyBid: 0.15, slug: "test" }]);
    // bid=0.35, ask=0.80, spread=0.45 > 0.10, but bid=0.35 > emergency=0.15
    t.onPriceUpdate("tok1", 0.35, 0.80, true);
    assert.strictEqual(t.episodes.size, 0);
  });

  test("opens episode via emergency (spread wide but bid <= emergencyBid)", () => {
    const t = new SLBreachTracker();
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.10, emergencyBid: 0.15, slug: "test" }]);
    t.onPriceUpdate("tok1", 0.10, 0.90, true);
    assert.strictEqual(t.episodes.size, 1);
  });

  test("closes episode as recovered when price goes back above SL", () => {
    const t = new SLBreachTracker();
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.50, emergencyBid: 0.15, slug: "test" }]);
    t.onPriceUpdate("tok1", 0.35, 0.40, true);
    assert.strictEqual(t.episodes.size, 1);
    // Price recovers
    t.onPriceUpdate("tok1", 0.45, 0.50, true);
    assert.strictEqual(t.episodes.size, 0);
    assert.strictEqual(t.stats.episodes_recovered, 1);
  });

  test("onLoopSLDetected returns delta and closes episode", () => {
    const t = new SLBreachTracker();
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.50, emergencyBid: 0.15, slug: "test" }]);
    t.onPriceUpdate("tok1", 0.35, 0.40, true);
    // Simulate loop detecting 50ms later
    const delta = t.onLoopSLDetected("tok1");
    assert.ok(delta != null);
    assert.ok(delta >= 0);
    assert.strictEqual(t.stats.episodes_acted, 1);
    assert.strictEqual(t.episodes.size, 0);
    assert.strictEqual(t.stats.deltas_ms.length, 1);
  });

  test("onLoopSLDetected returns null if no episode", () => {
    const t = new SLBreachTracker();
    assert.strictEqual(t.onLoopSLDetected("tok1"), null);
  });

  test("cooldown prevents re-opening episode within 2s", () => {
    const t = new SLBreachTracker();
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.50, emergencyBid: 0.15, slug: "test" }]);
    t.onPriceUpdate("tok1", 0.35, 0.40, true);
    t.onLoopSLDetected("tok1"); // closes episode, sets cooldown
    // Try to re-open immediately
    t.onPriceUpdate("tok1", 0.35, 0.40, true);
    assert.strictEqual(t.episodes.size, 0); // blocked by cooldown
  });

  test("first breach wins (no overwrite of breachTs)", () => {
    const t = new SLBreachTracker();
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.50, emergencyBid: 0.15, slug: "test" }]);
    t.onPriceUpdate("tok1", 0.38, 0.43, true);
    const firstTs = t.episodes.get("tok1").breachTs;
    const firstBid = t.episodes.get("tok1").breachBid;
    // Another breach at lower bid — should NOT overwrite
    t.onPriceUpdate("tok1", 0.30, 0.35, true);
    assert.strictEqual(t.episodes.get("tok1").breachTs, firstTs);
    assert.strictEqual(t.episodes.get("tok1").breachBid, firstBid);
    assert.strictEqual(t.stats.episodes_opened, 1); // still 1
  });

  test("configure cleans up episodes for removed positions", () => {
    const t = new SLBreachTracker();
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.50, emergencyBid: 0.15, slug: "test" }]);
    t.onPriceUpdate("tok1", 0.35, 0.40, true);
    assert.strictEqual(t.episodes.size, 1);
    // Reconfigure without tok1
    t.configure([]);
    assert.strictEqual(t.episodes.size, 0);
  });

  test("getStats returns correct percentiles", () => {
    const t = new SLBreachTracker();
    // Manually inject deltas
    t.stats.deltas_ms = [100, 200, 500, 1000, 2000, 3000, 4000, 5000, 6000, 10000];
    t.stats.episodes_opened = 10;
    t.stats.episodes_acted = 10;
    const s = t.getStats();
    assert.strictEqual(s.episodes_opened, 10);
    assert.strictEqual(s.sample_count, 10);
    assert.ok(s.delta_p50_ms != null);
    assert.ok(s.delta_p95_ms != null);
    assert.strictEqual(s.delta_max_ms, 10000);
  });

  test("getStats with no data", () => {
    const t = new SLBreachTracker();
    const s = t.getStats();
    assert.strictEqual(s.delta_p50_ms, null);
    assert.strictEqual(s.delta_p95_ms, null);
    assert.strictEqual(s.sample_count, 0);
  });

  test("tracks wsHealthy flag in episode", () => {
    const t = new SLBreachTracker();
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.50, emergencyBid: 0.15, slug: "test" }]);
    t.onPriceUpdate("tok1", 0.35, 0.40, false); // unhealthy
    assert.strictEqual(t.episodes.get("tok1").wsHealthy, false);
  });

  test("multiple tokens tracked independently", () => {
    const t = new SLBreachTracker();
    t.configure([
      { tokenId: "tok1", slBid: 0.40, spreadMax: 0.50, emergencyBid: 0.15, slug: "slug1" },
      { tokenId: "tok2", slBid: 0.35, spreadMax: 0.50, emergencyBid: 0.15, slug: "slug2" },
    ]);
    t.onPriceUpdate("tok1", 0.38, 0.43, true); // breach
    t.onPriceUpdate("tok2", 0.50, 0.55, true); // no breach
    assert.strictEqual(t.episodes.size, 1);
    assert.ok(t.episodes.has("tok1"));
    assert.ok(!t.episodes.has("tok2"));
  });

  test("deltas_ms capped at 200", () => {
    const t = new SLBreachTracker();
    t.stats.deltas_ms = Array.from({ length: 200 }, (_, i) => i);
    t.configure([{ tokenId: "tok1", slBid: 0.40, spreadMax: 0.50, emergencyBid: 0.15, slug: "test" }]);
    t.onPriceUpdate("tok1", 0.35, 0.40, true);
    t.onLoopSLDetected("tok1");
    assert.strictEqual(t.stats.deltas_ms.length, 200); // still 200, oldest dropped
  });
});
