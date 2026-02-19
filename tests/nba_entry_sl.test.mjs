import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate, resolveEntryPriceLimits, resolveMaxSpread } from "../src/strategy/stage1.mjs";

const cfg = {
  filters: {
    min_prob: 0.93, max_entry_price: 0.97, max_spread: 0.04, EPS: 1e-6,
    min_entry_price_nba: 0.83, max_entry_price_nba: 0.87,
  },
};

describe("resolveEntryPriceLimits — NBA", () => {
  it("returns nba-specific limits (0.83-0.87)", () => {
    const { minProb, maxEntry } = resolveEntryPriceLimits(cfg.filters, "nba");
    assert.equal(minProb, 0.83);
    assert.equal(maxEntry, 0.87);
  });
  it("nba uses default spread (0.04)", () => {
    assert.equal(resolveMaxSpread(cfg.filters, "nba"), 0.04);
  });
});

describe("is_base_signal_candidate — NBA entry [0.83, 0.87]", () => {
  it("nba ask=0.85 spread=0.02 passes", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.85, spread: 0.02 }, cfg, "nba").pass, true);
  });
  it("nba ask=0.83 passes (lower boundary)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.83, spread: 0.02 }, cfg, "nba").pass, true);
  });
  it("nba ask=0.87 passes (upper boundary)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.87, spread: 0.02 }, cfg, "nba").pass, true);
  });
  it("nba ask=0.82 FAILS (below min)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.82, spread: 0.02 }, cfg, "nba").pass, false);
  });
  it("nba ask=0.88 FAILS (above max)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.88, spread: 0.02 }, cfg, "nba").pass, false);
  });
  it("nba ask=0.95 FAILS (would pass default but not nba)", () => {
    assert.equal(is_base_signal_candidate({ probAsk: 0.95, spread: 0.02 }, cfg, "nba").pass, false);
  });
});

describe("NBA config values", () => {
  it("stop_loss_bid_nba=0.45", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.paper.stop_loss_bid_nba, 0.45);
  });
  it("min_entry_price_nba=0.83", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.min_entry_price_nba, 0.83);
  });
  it("max_entry_price_nba=0.87", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.filters.max_entry_price_nba, 0.87);
  });
  it("max_minutes_left_nba=10", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.context.entry_rules.max_minutes_left_nba, 10);
  });
  it("min_win_prob_nba=0 (disabled)", async () => {
    const { readFileSync } = await import("node:fs");
    const c = JSON.parse(readFileSync("src/config/local.json", "utf8"));
    assert.equal(c.context.entry_rules.min_win_prob_nba, 0);
  });
});
