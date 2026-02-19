import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate, resolveEntryPriceLimits } from "../src/strategy/stage1.mjs";

/**
 * Tests for Dota2-specific entry price range and SL config.
 * Config: min_entry_price_dota2=0.86, max_entry_price_dota2=0.92
 * SL: stop_loss_bid_dota2=0.45, stop_loss_ask_dota2=0.50
 */

const cfg = {
  filters: {
    min_prob: 0.93,
    max_entry_price: 0.97,
    max_spread: 0.04,
    EPS: 1e-6,
    min_entry_price_dota2: 0.86,
    max_entry_price_dota2: 0.92,
  },
};

// ========== resolveEntryPriceLimits ==========

describe("resolveEntryPriceLimits", () => {
  it("returns dota2-specific limits for slugPrefix=dota2", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "dota2");
    assert.equal(minProb, 0.86);
    assert.equal(maxEntry, 0.92);
  });

  it("returns default limits for slugPrefix=cs2 (no sport-specific config)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "cs2");
    assert.equal(minProb, 0.93);
    assert.equal(maxEntry, 0.97);
  });

  it("returns default limits for slugPrefix=lol (no sport-specific config)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "lol");
    assert.equal(minProb, 0.93);
    assert.equal(maxEntry, 0.97);
  });

  it("returns default limits when slugPrefix is undefined", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, undefined);
    assert.equal(minProb, 0.93);
    assert.equal(maxEntry, 0.97);
  });
});

// ========== is_base_signal_candidate with dota2 ==========

describe("is_base_signal_candidate — dota2 entry range [0.86, 0.92]", () => {
  // PASS: inside dota2 range
  it("dota2 ask=0.88 passes (inside 0.86-0.92)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.88, spread: 0.02 }, cfg, "dota2");
    assert.equal(r.pass, true);
  });

  it("dota2 ask=0.86 passes (lower boundary)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.86, spread: 0.02 }, cfg, "dota2");
    assert.equal(r.pass, true);
  });

  it("dota2 ask=0.92 passes (upper boundary)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.92, spread: 0.02 }, cfg, "dota2");
    assert.equal(r.pass, true);
  });

  // FAIL: outside dota2 range
  it("dota2 ask=0.85 FAILS (below min 0.86)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.85, spread: 0.02 }, cfg, "dota2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("dota2 ask=0.93 FAILS (above max 0.92)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.93, spread: 0.02 }, cfg, "dota2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("dota2 ask=0.95 FAILS (well above max 0.92)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.95, spread: 0.02 }, cfg, "dota2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("dota2 ask=0.97 FAILS (would pass default but not dota2)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.97, spread: 0.02 }, cfg, "dota2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  // SPREAD still applies
  it("dota2 ask=0.88 spread=0.05 FAILS (spread too wide)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.88, spread: 0.05 }, cfg, "dota2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "spread_above_max");
  });
});

describe("is_base_signal_candidate — non-dota2 uses defaults", () => {
  it("cs2 ask=0.95 passes (default range 0.93-0.97)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.95, spread: 0.02 }, cfg, "cs2");
    assert.equal(r.pass, true);
  });

  it("cs2 ask=0.88 FAILS (below default min 0.93)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.88, spread: 0.02 }, cfg, "cs2");
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("lol ask=0.95 passes default, would fail dota2 range", () => {
    const r_lol = is_base_signal_candidate({ probAsk: 0.95, spread: 0.02 }, cfg, "lol");
    const r_dota2 = is_base_signal_candidate({ probAsk: 0.95, spread: 0.02 }, cfg, "dota2");
    assert.equal(r_lol.pass, true);
    assert.equal(r_dota2.pass, false);
  });

  // No slugPrefix = defaults
  it("no slugPrefix uses defaults", () => {
    const r = is_base_signal_candidate({ probAsk: 0.95, spread: 0.02 }, cfg);
    assert.equal(r.pass, true);
  });
});

// ========== SL config verification ==========

describe("Dota2 SL config values", () => {
  // Read from local.json to verify config values
  it("local.json has stop_loss_bid_dota2=0.45", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(cfg.paper.stop_loss_bid_dota2, 0.45);
  });

  it("local.json has stop_loss_ask_dota2=0.50", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(cfg.paper.stop_loss_ask_dota2, 0.50);
  });

  it("local.json has min_entry_price_dota2=0.86", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(cfg.filters.min_entry_price_dota2, 0.86);
  });

  it("local.json has max_entry_price_dota2=0.92", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(cfg.filters.max_entry_price_dota2, 0.92);
  });
});
