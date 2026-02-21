import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate, resolveEntryPriceLimits, resolveMaxSpread } from "../src/strategy/stage1.mjs";

const cfg = {
  filters: {
    min_prob: 0.93, max_entry_price: 0.97, max_spread: 0.04, EPS: 1e-6,
    min_entry_price_cwbb: 0.98, max_entry_price_cwbb: 0.99, max_spread_cwbb: 0.10,
  },
};

describe("resolveEntryPriceLimits — CWBB", () => {
  it("returns cwbb-specific limits (0.98-0.99)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "cwbb");
    assert.equal(minProb, 0.98);
    assert.equal(maxEntry, 0.99);
  });
  it("cwbb uses sport-specific spread (0.10)", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "cwbb"), 0.10);
  });
});

describe("is_base_signal_candidate — CWBB entry [0.98, 0.999] + spread ≤ 0.10", () => {
  it("cwbb ask=0.99 spread=0.05 passes", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.99, spread: 0.05 }, cfg, "cwbb").pass, true);
  });
  it("cwbb ask=0.985 passes (inside range)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.985, spread: 0.05 }, cfg, "cwbb").pass, true);
  });
  it("cwbb ask=0.985 passes (inside range)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.985, spread: 0.05 }, cfg, "cwbb").pass, true);
  });
  it("cwbb ask=0.975 FAILS (below min 0.98)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.975, spread: 0.05 }, cfg, "cwbb");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("cwbb ask=0.97 FAILS (below min 0.98)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.97, spread: 0.05 }, cfg, "cwbb");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("cwbb ask=1.00 FAILS (above max 0.99)", () => {
    const r = is_base_signal_candidate({ probAsk: 1.00, spread: 0.05 }, cfg, "cwbb");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("cwbb ask=0.99 spread=0.15 FAILS (spread > cwbb max 0.10)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.99, spread: 0.15 }, cfg, "cwbb");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "spread_above_max");
  });
});

describe("CWBB config values in local.json", () => {
  it("min_entry_price_cwbb=0.98", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.min_entry_price_cwbb, 0.98);
  });
  it("max_entry_price_cwbb=0.999", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_entry_price_cwbb, 0.99);
  });
  it("max_spread_cwbb=0.10", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_spread_cwbb, 0.10);
  });
  it("CWBB SL bid=0.90", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.paper.stop_loss_bid_cwbb, 0.90);
  });
  it("context.enabled=false", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.context.enabled, false);
  });
});
