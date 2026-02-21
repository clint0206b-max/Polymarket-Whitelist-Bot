import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate, resolveEntryPriceLimits, resolveMaxSpread } from "../src/strategy/stage1.mjs";

const cfg = {
  filters: {
    min_prob: 0.93, max_entry_price: 0.97, max_spread: 0.04, EPS: 1e-6,
    min_entry_price_nba: 0.98, max_entry_price_nba: 0.999,
  },
};

describe("resolveEntryPriceLimits — NBA", () => {
  it("returns nba-specific limits (0.98-0.999)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "nba");
    assert.equal(minProb, 0.98);
    assert.equal(maxEntry, 0.999);
  });
  it("nba uses default spread (0.04)", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "nba"), 0.04);
  });
});

describe("is_base_signal_candidate — NBA entry [0.98, 0.999]", () => {
  it("nba ask=0.99 spread=0.02 passes", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.99, spread: 0.02 }, cfg, "nba").pass, true);
  });
  it("nba ask=0.985 passes (inside range)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.985, spread: 0.02 }, cfg, "nba").pass, true);
  });
  it("nba ask=0.995 passes (inside range)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.995, spread: 0.02 }, cfg, "nba").pass, true);
  });
  it("nba ask=0.975 FAILS (below min)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.975, spread: 0.02 }, cfg, "nba").pass, false);
  });
  it("nba ask=0.97 FAILS (below min 0.98)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.97, spread: 0.02 }, cfg, "nba").pass, false);
  });
  it("nba ask=1.00 FAILS (above max 0.999)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 1.00, spread: 0.02 }, cfg, "nba").pass, false);
  });
  it("nba ask=0.9995 FAILS (above max 0.999)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.9995, spread: 0.02 }, cfg, "nba").pass, false);
  });
});

describe("NBA config values", () => {
  it("stop_loss_bid_nba=0.90", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.paper.stop_loss_bid_nba, 0.90);
  });
  it("min_entry_price_nba=0.98", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.min_entry_price_nba, 0.98);
  });
  it("max_entry_price_nba=0.999", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_entry_price_nba, 0.999);
  });
  it("context.enabled=false", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.context.enabled, false);
  });
});
