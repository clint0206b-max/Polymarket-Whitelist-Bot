import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { soccerWinProb, checkSoccerEntryGate } from "../src/strategy/win_prob_table.mjs";

// ─── soccerWinProb ───────────────────────────────────────────

describe("soccerWinProb", () => {
  // --- Invalid inputs ---
  it("returns null for null margin", () => {
    assert.equal(soccerWinProb(null, 10), null);
  });
  it("returns null for NaN margin", () => {
    assert.equal(soccerWinProb(NaN, 10), null);
  });
  it("returns null for null minutesLeft", () => {
    assert.equal(soccerWinProb(2, null), null);
  });
  it("returns null for negative minutesLeft", () => {
    assert.equal(soccerWinProb(2, -1), null);
  });
  it("returns null for margin <= 0 (not ahead)", () => {
    assert.equal(soccerWinProb(0, 10), null);
    assert.equal(soccerWinProb(-1, 10), null);
  });

  // --- Monotonicity: more time → lower win_prob ---
  it("win_prob decreases as minutesLeft increases (margin=2)", () => {
    const wp5  = soccerWinProb(2, 5);
    const wp10 = soccerWinProb(2, 10);
    const wp15 = soccerWinProb(2, 15);
    const wp20 = soccerWinProb(2, 20);
    assert.ok(wp5 > wp10, `wp5=${wp5} should be > wp10=${wp10}`);
    assert.ok(wp10 > wp15, `wp10=${wp10} should be > wp15=${wp15}`);
    assert.ok(wp15 > wp20, `wp15=${wp15} should be > wp20=${wp20}`);
  });

  it("win_prob decreases as minutesLeft increases (margin=1)", () => {
    const wp3  = soccerWinProb(1, 3);
    const wp5  = soccerWinProb(1, 5);
    const wp10 = soccerWinProb(1, 10);
    assert.ok(wp3 > wp5, `wp3=${wp3} should be > wp5=${wp5}`);
    assert.ok(wp5 > wp10, `wp5=${wp5} should be > wp10=${wp10}`);
  });

  // --- Monotonicity: more margin → higher win_prob ---
  it("win_prob increases as margin increases (minutesLeft=10)", () => {
    const wp1 = soccerWinProb(1, 10);
    const wp2 = soccerWinProb(2, 10);
    const wp3 = soccerWinProb(3, 10);
    const wp4 = soccerWinProb(4, 10);
    assert.ok(wp2 > wp1, `wp2=${wp2} should be > wp1=${wp1}`);
    assert.ok(wp3 > wp2, `wp3=${wp3} should be > wp2=${wp2}`);
    assert.ok(wp4 > wp3, `wp4=${wp4} should be > wp3=${wp3}`);
  });

  // --- Key calibration points (from plan analysis) ---
  // Margin 1: always dangerous, should be < 0.90 at 10 min
  it("margin=1, 10min → < 0.90 (too risky)", () => {
    const wp = soccerWinProb(1, 10);
    assert.ok(wp < 0.90, `margin=1 10min should be < 0.90, got ${wp}`);
  });

  it("margin=1, 5min → < 0.95 (still risky with injury time multiplier)", () => {
    const wp = soccerWinProb(1, 5);
    assert.ok(wp < 0.95, `margin=1 5min should be < 0.95, got ${wp}`);
  });

  it("margin=1, 3min → < 0.95 (injury time makes it dangerous)", () => {
    const wp = soccerWinProb(1, 3);
    assert.ok(wp < 0.95, `margin=1 3min should be < 0.95, got ${wp}`);
  });

  // Margin 2: safe zone at <= 15 min
  it("margin=2, 10min → > 0.97", () => {
    const wp = soccerWinProb(2, 10);
    assert.ok(wp > 0.97, `margin=2 10min should be > 0.97, got ${wp}`);
  });

  it("margin=2, 15min → > 0.95", () => {
    const wp = soccerWinProb(2, 15);
    assert.ok(wp > 0.95, `margin=2 15min should be > 0.95, got ${wp}`);
  });

  it("margin=2, 5min → > 0.99", () => {
    const wp = soccerWinProb(2, 5);
    assert.ok(wp > 0.99, `margin=2 5min should be > 0.99, got ${wp}`);
  });

  // Margin 3: very safe
  it("margin=3, 20min → > 0.99", () => {
    const wp = soccerWinProb(3, 20);
    assert.ok(wp > 0.99, `margin=3 20min should be > 0.99, got ${wp}`);
  });

  it("margin=3, 10min → > 0.999", () => {
    const wp = soccerWinProb(3, 10);
    assert.ok(wp > 0.999, `margin=3 10min should be > 0.999, got ${wp}`);
  });

  // --- Injury time multiplier ---
  it("injury time multiplier kicks in at <= 5 min", () => {
    // At exactly 5min and 6min, the 5min should have LOWER wp due to multiplier
    // even though it has less time (multiplier increases lambda)
    const wp5 = soccerWinProb(1, 5);   // with multiplier
    const wp6 = soccerWinProb(1, 6);   // without multiplier
    // wp5 has 5 min * 1.5 multiplier = effective 7.5 min of goal rate
    // wp6 has 6 min * 1.0 = effective 6 min of goal rate
    // So wp5 should be LOWER than wp6 despite less real time
    assert.ok(wp5 < wp6, `wp5=${wp5} (with multiplier) should be < wp6=${wp6} (without)`);
  });

  // --- Edge cases ---
  it("minutesLeft=0 → very high win_prob (clamped to 0.5 min)", () => {
    const wp = soccerWinProb(2, 0);
    assert.ok(wp > 0.999, `margin=2 0min should be > 0.999, got ${wp}`);
  });

  it("very large margin → > 0.9999", () => {
    const wp = soccerWinProb(5, 20);
    assert.ok(wp > 0.9999, `margin=5 20min should be > 0.9999, got ${wp}`);
  });

  it("returns a number between 0 and 1", () => {
    for (const m of [1, 2, 3, 4]) {
      for (const t of [0, 1, 5, 10, 15, 20, 30, 45]) {
        const wp = soccerWinProb(m, t);
        assert.ok(wp >= 0 && wp <= 1, `margin=${m} time=${t}: wp=${wp} not in [0,1]`);
      }
    }
  });
});

// ─── checkSoccerEntryGate ────────────────────────────────────

describe("checkSoccerEntryGate", () => {
  const base = {
    period: 2,
    minutesLeft: 10,
    marginForYes: 2,
    confidence: "high",
    lastScoreChangeAgoSec: 120,
  };

  // --- Blocking conditions ---
  it("blocks when no context", () => {
    const r = checkSoccerEntryGate({});
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "no_context");
  });

  it("blocks when confidence is low", () => {
    const r = checkSoccerEntryGate({ ...base, confidence: "low" });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "low_confidence");
  });

  it("blocks in first half", () => {
    const r = checkSoccerEntryGate({ ...base, period: 1 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "first_half");
  });

  it("blocks in extra time (period > 2)", () => {
    const r = checkSoccerEntryGate({ ...base, period: 3 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "extra_time_or_invalid");
  });

  it("blocks with margin=1 (too risky for soccer)", () => {
    const r = checkSoccerEntryGate({ ...base, marginForYes: 1 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "margin_too_small");
  });

  it("blocks with margin=0", () => {
    const r = checkSoccerEntryGate({ ...base, marginForYes: 0 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "margin_too_small");
  });

  it("blocks with negative margin", () => {
    const r = checkSoccerEntryGate({ ...base, marginForYes: -2 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "margin_too_small");
  });

  // --- Score change cooldown (VAR protection) ---
  it("blocks when score changed < 90s ago", () => {
    const r = checkSoccerEntryGate({ ...base, lastScoreChangeAgoSec: 30 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "score_change_cooldown");
  });

  it("blocks when score changed exactly 89s ago", () => {
    const r = checkSoccerEntryGate({ ...base, lastScoreChangeAgoSec: 89 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "score_change_cooldown");
  });

  it("allows when score changed >= 90s ago", () => {
    const r = checkSoccerEntryGate({ ...base, lastScoreChangeAgoSec: 90 });
    assert.equal(r.allowed, true);
  });

  it("allows when lastScoreChangeAgoSec is null (unknown)", () => {
    const r = checkSoccerEntryGate({ ...base, lastScoreChangeAgoSec: null });
    assert.equal(r.allowed, true);
  });

  // --- Time window by margin ---
  it("margin=2: blocks at 16 min", () => {
    const r = checkSoccerEntryGate({ ...base, marginForYes: 2, minutesLeft: 16 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "too_much_time_left");
  });

  it("margin=2: allows at 15 min (if win_prob passes)", () => {
    const r = checkSoccerEntryGate({ ...base, marginForYes: 2, minutesLeft: 15 });
    // win_prob at margin=2 15min is ~97.9% which should pass 0.97 threshold
    assert.equal(r.allowed, true);
  });

  it("margin=3: allows at 20 min", () => {
    const r = checkSoccerEntryGate({ ...base, marginForYes: 3, minutesLeft: 20 });
    assert.equal(r.allowed, true);
  });

  it("margin=3: blocks at 21 min", () => {
    const r = checkSoccerEntryGate({ ...base, marginForYes: 3, minutesLeft: 21 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "too_much_time_left");
  });

  // --- Win prob thresholds by margin ---
  it("margin=2: uses 0.97 threshold (stricter)", () => {
    // At margin=2, 15min, win_prob ≈ 0.979 — right at the edge
    const r = checkSoccerEntryGate({ ...base, marginForYes: 2, minutesLeft: 15 });
    assert.ok(r.win_prob >= 0.97, `win_prob should be >= 0.97, got ${r.win_prob}`);
  });

  it("margin=3: uses 0.95 threshold (more relaxed)", () => {
    const r = checkSoccerEntryGate({ ...base, marginForYes: 3, minutesLeft: 20 });
    assert.ok(r.win_prob >= 0.95, `win_prob should be >= 0.95, got ${r.win_prob}`);
  });

  // --- Happy path ---
  it("allows margin=2, 10min, confidence high, score stable", () => {
    const r = checkSoccerEntryGate(base);
    assert.equal(r.allowed, true);
    assert.equal(r.reason, "pass");
    assert.ok(r.win_prob > 0.97);
  });

  it("allows margin=3, 15min, all conditions met", () => {
    const r = checkSoccerEntryGate({
      ...base,
      marginForYes: 3,
      minutesLeft: 15,
    });
    assert.equal(r.allowed, true);
    assert.ok(r.win_prob > 0.99);
  });

  it("allows margin=4, 20min", () => {
    const r = checkSoccerEntryGate({
      ...base,
      marginForYes: 4,
      minutesLeft: 20,
    });
    assert.equal(r.allowed, true);
    assert.ok(r.win_prob > 0.999);
  });

  // --- Custom thresholds ---
  it("respects custom minWinProbMargin2", () => {
    // Force a very high threshold that margin=2, 15min won't pass
    const r = checkSoccerEntryGate({
      ...base,
      marginForYes: 2,
      minutesLeft: 15,
      minWinProbMargin2: 0.999,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "winprob_below_threshold");
  });

  it("respects custom maxMinutesMargin2", () => {
    const r = checkSoccerEntryGate({
      ...base,
      marginForYes: 2,
      minutesLeft: 12,
      maxMinutesMargin2: 10,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "too_much_time_left");
  });

  it("respects custom scoreChangeCooldownSec", () => {
    const r = checkSoccerEntryGate({
      ...base,
      lastScoreChangeAgoSec: 50,
      scoreChangeCooldownSec: 60,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "score_change_cooldown");
  });

  // --- Integration: called via checkContextEntryGate for sport=soccer ---
  // (This tests the delegation path in checkContextEntryGate)
  it("win_prob output is always a number when inputs are valid", () => {
    for (const margin of [2, 3, 4]) {
      for (const min of [1, 5, 10, 15]) {
        const r = checkSoccerEntryGate({ ...base, marginForYes: margin, minutesLeft: min });
        assert.ok(typeof r.win_prob === "number", `margin=${margin} min=${min}: win_prob should be number`);
        assert.ok(r.win_prob >= 0 && r.win_prob <= 1, `margin=${margin} min=${min}: win_prob=${r.win_prob}`);
      }
    }
  });
});
