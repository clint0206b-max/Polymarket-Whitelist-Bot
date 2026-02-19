import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate, resolveEntryPriceLimits, resolveMaxSpread } from "../src/strategy/stage1.mjs";

const cfg = {
  filters: {
    min_prob: 0.93, max_entry_price: 0.97, max_spread: 0.04, EPS: 1e-6,
    min_entry_price_val: 0.89, max_entry_price_val: 0.93,
  },
};

describe("resolveEntryPriceLimits — Val", () => {
  it("returns val-specific limits (0.89-0.93)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "val");
    assert.equal(minProb, 0.89);
    assert.equal(maxEntry, 0.93);
  });
  it("val uses default spread (0.04)", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "val"), 0.04);
  });
});

describe("is_base_signal_candidate — Val entry [0.89, 0.93]", () => {
  it("val ask=0.91 spread=0.02 passes", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.91, spread: 0.02 }, cfg, "val").pass, true);
  });
  it("val ask=0.89 passes (lower boundary)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.89, spread: 0.02 }, cfg, "val").pass, true);
  });
  it("val ask=0.93 passes (upper boundary)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.93, spread: 0.02 }, cfg, "val").pass, true);
  });
  it("val ask=0.88 FAILS (below min)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.88, spread: 0.02 }, cfg, "val");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("val ask=0.94 FAILS (above max 0.93)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.94, spread: 0.02 }, cfg, "val");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("val ask=0.95 FAILS (would pass default but not val)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.95, spread: 0.02 }, cfg, "val").pass, false);
  });
});

describe("Val SL config values", () => {
  it("stop_loss_bid_val=0.42", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.paper.stop_loss_bid_val, 0.42);
  });
  it("stop_loss_ask_val=0.47", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.paper.stop_loss_ask_val, 0.47);
  });
  it("min_entry_price_val=0.81", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.min_entry_price_val, 0.81);
  });
  it("max_entry_price_val=0.93", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_entry_price_val, 0.93);
  });
});
