import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate, resolveEntryPriceLimits, resolveMaxSpread } from "../src/strategy/stage1.mjs";

const cfg = {
  filters: {
    min_prob: 0.93, max_entry_price: 0.97, max_spread: 0.04, EPS: 1e-6,
    min_entry_price_cwbb: 0.86, max_entry_price_cwbb: 0.90, max_spread_cwbb: 0.02,
  },
};

describe("resolveEntryPriceLimits — CWBB", () => {
  it("returns cwbb-specific limits (0.86-0.90)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "cwbb");
    assert.equal(minProb, 0.86);
    assert.equal(maxEntry, 0.90);
  });
  it("cwbb uses sport-specific spread (0.02)", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "cwbb"), 0.02);
  });
});

describe("is_base_signal_candidate — CWBB entry [0.86, 0.90] + spread ≤ 0.02", () => {
  it("cwbb ask=0.88 spread=0.01 passes", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.88, spread: 0.01 }, cfg, "cwbb").pass, true);
  });
  it("cwbb ask=0.86 passes (lower boundary)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.86, spread: 0.02 }, cfg, "cwbb").pass, true);
  });
  it("cwbb ask=0.90 passes (upper boundary)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.90, spread: 0.02 }, cfg, "cwbb").pass, true);
  });
  it("cwbb ask=0.85 FAILS (below min 0.86)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.85, spread: 0.01 }, cfg, "cwbb");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("cwbb ask=0.91 FAILS (above max 0.90)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.91, spread: 0.01 }, cfg, "cwbb");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("cwbb ask=0.88 spread=0.03 FAILS (spread > cwbb max 0.02)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.88, spread: 0.03 }, cfg, "cwbb");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "spread_above_max");
  });
});

describe("CWBB config values in local.json", () => {
  it("min_entry_price_cwbb=0.80", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.min_entry_price_cwbb, 0.80);
  });
  it("max_entry_price_cwbb=0.90", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_entry_price_cwbb, 0.90);
  });
  it("max_spread_cwbb=0.02", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_spread_cwbb, 0.02);
  });
  it("max_minutes_left_cwbb=10", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.context.entry_rules.max_minutes_left_cwbb, 10);
  });
  it("CWBB SL bid=0.40, ask=0.45", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.paper.stop_loss_bid_cwbb, 0.40);
    assert.equal(c.paper.stop_loss_ask_cwbb, 0.45);
  });
});
