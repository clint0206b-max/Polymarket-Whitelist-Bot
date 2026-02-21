import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate, resolveEntryPriceLimits, resolveMaxSpread } from "../src/strategy/stage1.mjs";

/**
 * Tests for CS2-specific entry price range, spread, and SL config.
 * Config: min_entry_price_cs2=0.98, max_entry_price_cs2=0.999, max_spread_cs2=0.10
 * SL: stop_loss_bid_cs2=0.90
 */

const cfg = {
  filters: {
    min_prob: 0.93,
    max_entry_price: 0.97,
    max_spread: 0.04,
    EPS: 1e-6,
    min_entry_price_dota2: 0.98,
    max_entry_price_dota2: 0.99,
    min_entry_price_cs2: 0.98,
    max_entry_price_cs2: 0.99,
    max_spread_cs2: 0.10,
  },
};

// ========== resolveEntryPriceLimits ==========

describe("resolveEntryPriceLimits — CS2", () => {
  it("returns cs2-specific limits", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "cs2");
    assert.equal(minProb, 0.98);
    assert.equal(maxEntry, 0.99);
  });

  it("dota2 still uses dota2 limits", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "dota2");
    assert.equal(minProb, 0.98);
    assert.equal(maxEntry, 0.99);
  });

  it("lol uses defaults (no sport-specific)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "lol");
    assert.equal(minProb, 0.93);
    assert.equal(maxEntry, 0.97);
  });
});

// ========== resolveMaxSpread ==========

describe("resolveMaxSpread", () => {
  it("returns cs2-specific spread (0.10)", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "cs2"), 0.10);
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

describe("is_base_signal_candidate — CS2 entry [0.98, 0.999] + spread ≤ 0.10", () => {
  it("cs2 ask=0.99 spread=0.05 passes", () => {
    const r = is_base_signal_candidate({ probAsk: 0.99, spread: 0.05 }, cfg, "cs2");
    assert.equal(r.pass, true);
  });

  it("cs2 ask=0.985 spread=0.05 passes (inside range)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.985, spread: 0.05 }, cfg, "cs2");
    assert.equal(r.pass, true);
  });

  it("cs2 ask=0.985 spread=0.05 passes (inside range)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.985, spread: 0.05 }, cfg, "cs2");
    assert.equal(r.pass, true);
  });

  it("cs2 ask=0.975 FAILS (below min 0.98)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.975, spread: 0.05 }, cfg, "cs2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("cs2 ask=0.97 FAILS (below min 0.98)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.97, spread: 0.05 }, cfg, "cs2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("cs2 ask=1.00 FAILS (above max 0.99)", () => {
    const r = is_base_signal_candidate({ probAsk: 1.00, spread: 0.05 }, cfg, "cs2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("cs2 ask=0.99 spread=0.15 FAILS (spread > cs2 max 0.10)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.99, spread: 0.15 }, cfg, "cs2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "spread_above_max");
  });

  it("cs2 ask=0.99 spread=0.05 PASSES (spread < cs2 max 0.10)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.99, spread: 0.05 }, cfg, "cs2");
    assert.equal(r.pass, true);
  });

  it("dota2 ask=0.99 spread=0.04 PASSES (dota2 uses default spread 0.04)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.99, spread: 0.04 }, cfg, "dota2");
    assert.equal(r.pass, true);
  });
});

// ========== SL config verification ==========

describe("CS2 SL config values in local.json", () => {
  it("stop_loss_bid_cs2=0.90", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.paper.stop_loss_bid_cs2, 0.90);
  });

  it("min_entry_price_cs2=0.98", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.min_entry_price_cs2, 0.98);
  });

  it("max_entry_price_cs2=0.999", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_entry_price_cs2, 0.99);
  });

  it("max_spread_cs2=0.10", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_spread_cs2, 0.10);
  });
});
