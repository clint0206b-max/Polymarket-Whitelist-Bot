import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate, resolveEntryPriceLimits, resolveMaxSpread } from "../src/strategy/stage1.mjs";

const cfg = {
  filters: {
    min_prob: 0.93, max_entry_price: 0.97, max_spread: 0.04, EPS: 1e-6,
    min_entry_price_dota2: 0.86, max_entry_price_dota2: 0.92,
    min_entry_price_cs2: 0.87, max_entry_price_cs2: 0.93, max_spread_cs2: 0.02,
    min_entry_price_lol: 0.87, max_entry_price_lol: 0.89,
  },
};

describe("resolveEntryPriceLimits — LoL", () => {
  it("returns lol-specific limits (0.87-0.89)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "lol");
    assert.equal(minProb, 0.87);
    assert.equal(maxEntry, 0.89);
  });
  it("lol uses default spread (0.04)", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "lol"), 0.04);
  });
});

describe("is_base_signal_candidate — LoL entry [0.87, 0.89]", () => {
  it("lol ask=0.88 spread=0.02 passes", () => {
    const r = is_base_signal_candidate({ probAsk: 0.88, spread: 0.02 }, cfg, "lol");
    assert.equal(r.pass, true);
  });
  it("lol ask=0.87 passes (lower boundary)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.87, spread: 0.02 }, cfg, "lol");
    assert.equal(r.pass, true);
  });
  it("lol ask=0.89 passes (upper boundary)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.89, spread: 0.02 }, cfg, "lol");
    assert.equal(r.pass, true);
  });
  it("lol ask=0.86 FAILS (below min)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.86, spread: 0.02 }, cfg, "lol");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("lol ask=0.90 FAILS (above max 0.89)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.90, spread: 0.02 }, cfg, "lol");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });
  it("lol ask=0.95 FAILS (would pass default but not lol)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.95, spread: 0.02 }, cfg, "lol");
    assert.equal(r.pass, false);
  });
});

describe("LoL SL config values", () => {
  it("stop_loss_bid_lol=0.32", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.paper.stop_loss_bid_lol, 0.32);
  });
  it("min_entry_price_lol=0.80", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.min_entry_price_lol, 0.80);
  });
  it("max_entry_price_lol=0.89", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_entry_price_lol, 0.89);
  });
});
