import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { is_base_signal_candidate } from "../src/strategy/stage1.mjs";

/**
 * Integration tests: verify that stage1 filters use cfg.filters.* values,
 * not hardcoded defaults. Tests pass a custom cfg to confirm the pipeline
 * respects the config it receives.
 */

describe("stage1 respects cfg.filters (not hardcoded)", () => {
  // Custom config matching local.json overrides
  // Current local.json config
  const cfg = {
    filters: {
      min_prob: 0.93,
      max_entry_price: 0.97,
      max_spread: 0.04,
      EPS: 1e-6,
    },
  };

  // Defaults config (from defaults.json)
  const cfgDefaults = {
    filters: {
      min_prob: 0.94,
      max_entry_price: 0.97,
      max_spread: 0.02,
      EPS: 1e-6,
    },
  };

  // --- max_spread ---
  it("spread 0.03 passes with max_spread=0.04", () => {
    const r = is_base_signal_candidate({ probAsk: 0.95, spread: 0.03 }, cfg);
    assert.equal(r.pass, true);
  });

  it("spread 0.03 FAILS with default max_spread=0.02", () => {
    const r = is_base_signal_candidate({ probAsk: 0.95, spread: 0.03 }, cfgDefaults);
    assert.equal(r.pass, false);
    assert.equal(r.reason, "spread_above_max");
  });

  it("spread 0.04 passes with max_spread=0.04 (exact boundary)", () => {
    const r = is_base_signal_candidate({ probAsk: 0.95, spread: 0.04 }, cfg);
    assert.equal(r.pass, true);
  });

  it("spread 0.041 FAILS with max_spread=0.04", () => {
    const r = is_base_signal_candidate({ probAsk: 0.95, spread: 0.041 }, cfg);
    assert.equal(r.pass, false);
    assert.equal(r.reason, "spread_above_max");
  });

  // --- min_prob ---
  it("probAsk 0.93 passes with min_prob=0.93", () => {
    const r = is_base_signal_candidate({ probAsk: 0.93, spread: 0.01 }, cfg);
    assert.equal(r.pass, true);
  });

  it("probAsk 0.93 FAILS with default min_prob=0.94", () => {
    const r = is_base_signal_candidate({ probAsk: 0.93, spread: 0.01 }, cfgDefaults);
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  // --- max_entry_price ---
  it("probAsk 0.97 passes with max_entry_price=0.97", () => {
    const r = is_base_signal_candidate({ probAsk: 0.97, spread: 0.01 }, cfg);
    assert.equal(r.pass, true);
  });

  it("probAsk 0.98 FAILS with max_entry_price=0.97", () => {
    const r = is_base_signal_candidate({ probAsk: 0.98, spread: 0.01 }, cfg);
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  it("probAsk 0.971 FAILS with max_entry_price=0.97", () => {
    const r = is_base_signal_candidate({ probAsk: 0.971, spread: 0.01 }, cfg);
    assert.equal(r.pass, false);
    assert.equal(r.reason, "price_out_of_range");
  });

  // --- Combined edge ---
  it("combined: 0.93 ask + 0.04 spread passes custom, fails defaults", () => {
    const quote = { probAsk: 0.93, spread: 0.04 };
    assert.equal(is_base_signal_candidate(quote, cfg).pass, true);
    assert.equal(is_base_signal_candidate(quote, cfgDefaults).pass, false);
  });
});

describe("config merge produces correct filter values", () => {
  it("deep merge: local.filters overrides defaults.filters per-field", () => {
    function deepMerge(a, b) {
      const isObj = x => x && typeof x === "object" && !Array.isArray(x);
      if (!isObj(a)) return b;
      if (!isObj(b)) return a;
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) {
        out[k] = isObj(v) ? deepMerge(a[k], v) : v;
      }
      return out;
    }

    const defaults = {
      filters: {
        EPS: 1e-6, min_prob: 0.94, max_entry_price: 0.97, max_spread: 0.02,
        near_spread_max: 0.015, min_exit_depth_usd_bid: 2000, min_entry_depth_usd_ask: 1000,
      },
    };
    const local = {
      filters: { min_prob: 0.93, max_entry_price: 0.97, max_spread: 0.04 },
    };

    const merged = deepMerge(defaults, local);

    // Overridden
    assert.equal(merged.filters.min_prob, 0.93);
    assert.equal(merged.filters.max_entry_price, 0.97);
    assert.equal(merged.filters.max_spread, 0.04);

    // Preserved from defaults
    assert.equal(merged.filters.EPS, 1e-6);
    assert.equal(merged.filters.near_spread_max, 0.015);
    assert.equal(merged.filters.min_exit_depth_usd_bid, 2000);
    assert.equal(merged.filters.min_entry_depth_usd_ask, 1000);
  });
});
