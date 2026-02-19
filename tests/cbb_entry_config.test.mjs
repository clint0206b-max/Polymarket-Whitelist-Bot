import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate, resolveEntryPriceLimits, resolveMaxSpread } from "../src/strategy/stage1.mjs";

const cfg = {
  filters: {
    min_prob: 0.93, max_entry_price: 0.97, max_spread: 0.04, EPS: 1e-6,
    min_entry_price_cbb: 0.90, max_entry_price_cbb: 0.93, max_spread_cbb: 0.02,
  },
};

describe("resolveEntryPriceLimits — CBB", () => {
  it("returns cbb-specific limits (0.90-0.93)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "cbb");
    assert.equal(minProb, 0.90);
    assert.equal(maxEntry, 0.93);
  });
  it("cbb uses sport-specific spread (0.02)", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "cbb"), 0.02);
  });
});

describe("is_base_signal_candidate — CBB entry [0.90, 0.93] + spread ≤ 0.02", () => {
  it("cbb ask=0.91 spread=0.01 passes", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.91, spread: 0.01 }, cfg, "cbb").pass, true);
  });
  it("cbb ask=0.90 passes (lower boundary)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.90, spread: 0.02 }, cfg, "cbb").pass, true);
  });
  it("cbb ask=0.93 passes (upper boundary)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.93, spread: 0.02 }, cfg, "cbb").pass, true);
  });
  it("cbb ask=0.89 FAILS (below min 0.90)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.89, spread: 0.01 }, cfg, "cbb");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("cbb ask=0.94 FAILS (above max 0.93)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.94, spread: 0.01 }, cfg, "cbb");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("cbb ask=0.91 spread=0.03 FAILS (spread > cbb max 0.02)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.91, spread: 0.03 }, cfg, "cbb");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "spread_above_max");
  });
});

describe("CBB config values in local.json", () => {
  it("min_entry_price_cbb=0.90", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.min_entry_price_cbb, 0.90);
  });
  it("max_entry_price_cbb=0.93", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_entry_price_cbb, 0.93);
  });
  it("max_spread_cbb=0.02", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_spread_cbb, 0.02);
  });
  it("max_minutes_left_cbb=10", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.context.entry_rules.max_minutes_left_cbb, 10);
  });
  it("CBB SL bid=0.45", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.paper.stop_loss_bid_cbb, 0.45);
  });
});
