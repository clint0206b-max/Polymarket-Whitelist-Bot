import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate, resolveEntryPriceLimits, resolveMaxSpread } from "../src/strategy/stage1.mjs";

/**
 * Tests for CS2-specific entry price range, spread, and SL config.
 * Config: min_entry_price_cs2=0.82, max_entry_price_cs2=0.93, max_spread_cs2=0.02
 * SL: stop_loss_bid_cs2=0.50, stop_loss_ask_cs2=0.40
 */

const cfg = {
  filters: {
    min_prob: 0.93,
    max_entry_price: 0.97,
    max_spread: 0.04,
    EPS: 1e-6,
    min_entry_price_dota2: 0.86,
    max_entry_price_dota2: 0.92,
    min_entry_price_cs2: 0.87,
    max_entry_price_cs2: 0.93,
    max_spread_cs2: 0.02,
  },
};

// ========== resolveEntryPriceLimits ==========

describe("resolveEntryPriceLimits — CS2", () => {
  it("returns cs2-specific limits", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "cs2");
    assert.equal(minProb, 0.87);
    assert.equal(maxEntry, 0.93);
  });

  it("dota2 still uses dota2 limits", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "dota2");
    assert.equal(minProb, 0.86);
    assert.equal(maxEntry, 0.92);
  });

  it("lol uses defaults (no sport-specific)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "lol");
    assert.equal(minProb, 0.93);
    assert.equal(maxEntry, 0.97);
  });
});

// ========== resolveMaxSpread ==========

describe("resolveMaxSpread", () => {
  it("returns cs2-specific spread (0.02)", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "cs2"), 0.02);
  });

  it("returns default spread (0.04) for dota2", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "dota2"), 0.04);
  });

  it("returns default spread (0.04) for lol", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "lol"), 0.04);
  });

  it("returns default when slugPrefix is undefined", () => {
    assert.equal(resolveMaxSpread(cfg.filters, undefined), 0.04);
  });
});

// ========== is_base_signal_candidate — CS2 ==========

describe("is_base_signal_candidate — CS2 entry [0.87, 0.93] + spread ≤ 0.02", () => {
  it("cs2 ask=0.90 spread=0.01 passes", () => {
    const r = is_base_signal_candidate({ probAsk: 0.90, spread: 0.01 }, cfg, "cs2");
    assert.equal(r.pass, true);
  });

  it("cs2 ask=0.87 spread=0.02 passes (lower boundary)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.87, spread: 0.02 }, cfg, "cs2");
    assert.equal(r.pass, true);
  });

  it("cs2 ask=0.93 spread=0.02 passes (upper boundary)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.93, spread: 0.02 }, cfg, "cs2");
    assert.equal(r.pass, true);
  });

  it("cs2 ask=0.86 FAILS (below min 0.87)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.86, spread: 0.01 }, cfg, "cs2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("cs2 ask=0.94 FAILS (above max 0.93)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.94, spread: 0.01 }, cfg, "cs2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("cs2 ask=0.95 FAILS (would pass default but not cs2)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.95, spread: 0.01 }, cfg, "cs2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("cs2 ask=0.90 spread=0.03 FAILS (spread > cs2 max 0.02)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.90, spread: 0.03 }, cfg, "cs2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "spread_above_max");
  });

  it("cs2 ask=0.90 spread=0.04 FAILS (spread > cs2 max 0.02)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.90, spread: 0.04 }, cfg, "cs2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "spread_above_max");
  });

  it("dota2 ask=0.90 spread=0.04 PASSES (dota2 uses default spread 0.04)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.90, spread: 0.04 }, cfg, "dota2");
    assert.equal(r.pass, true);
  });
});

// ========== SL config verification ==========

describe("CS2 SL config values in local.json", () => {
  it("stop_loss_bid_cs2=0.74", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.paper.stop_loss_bid_cs2, 0.74);
  });

  it("min_entry_price_cs2=0.82", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.min_entry_price_cs2, 0.82);
  });

  it("max_entry_price_cs2=0.93", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_entry_price_cs2, 0.93);
  });

  it("max_spread_cs2=0.02", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_spread_cs2, 0.02);
  });
});
