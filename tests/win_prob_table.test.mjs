import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateWinProb, checkContextEntryGate } from "../src/strategy/win_prob_table.mjs";

describe("estimateWinProb", () => {
  // --- Basic properties ---
  it("positive margin, 5 min left → higher than same margin at 20 min", () => {
    const wp5  = estimateWinProb(8, 5, "nba");
    const wp20 = estimateWinProb(8, 20, "nba");
    assert.ok(wp5 > wp20, `wp5=${wp5} should be > wp20=${wp20}`);
  });

  it("margin 0 → win_prob ≈ 0.5", () => {
    const wp = estimateWinProb(0, 10, "nba");
    assert.ok(Math.abs(wp - 0.5) < 0.01, `wp=${wp} should be ≈ 0.5`);
  });

  it("negative margin → win_prob < 0.5", () => {
    const wp = estimateWinProb(-5, 10, "nba");
    assert.ok(wp < 0.5, `wp=${wp} should be < 0.5`);
  });

  it("large positive margin, 1 min left → win_prob very high", () => {
    const wp = estimateWinProb(15, 1, "nba");
    assert.ok(wp > 0.99, `wp=${wp} should be > 0.99`);
  });

  it("clamp: minutes_left near 0 doesn't explode", () => {
    const wp0   = estimateWinProb(5, 0, "nba");
    const wp01  = estimateWinProb(5, 0.1, "nba");
    const wp05  = estimateWinProb(5, 0.5, "nba");
    // All should be valid numbers > 0.5
    assert.ok(wp0 != null && Number.isFinite(wp0) && wp0 > 0.5, `wp0=${wp0}`);
    assert.ok(wp01 != null && Number.isFinite(wp01) && wp01 > 0.5, `wp01=${wp01}`);
    assert.ok(wp05 != null && Number.isFinite(wp05) && wp05 > 0.5, `wp05=${wp05}`);
    // 0 and 0.1 should both clamp to 0.5 so same result
    assert.ok(Math.abs(wp0 - wp05) < 0.01, `wp0=${wp0} ≈ wp05=${wp05} (both clamped to 0.5 min)`);
  });

  it("minutes_left negative → null", () => {
    assert.equal(estimateWinProb(5, -1, "nba"), null);
  });

  // --- CBB vs NBA: CBB has lower sigma so same margin = higher wp ---
  it("same conditions: CBB win_prob slightly different from NBA (different sigma)", () => {
    const cbb = estimateWinProb(8, 5, "cbb");
    const nba = estimateWinProb(8, 5, "nba");
    assert.ok(cbb != null && nba != null);
    assert.ok(cbb !== nba, "cbb and nba should differ due to sigma/total_minutes");
  });

  // --- Invalid inputs ---
  it("unknown sport → null", () => {
    assert.equal(estimateWinProb(5, 5, "soccer"), null);
  });

  it("NaN margin → null", () => {
    assert.equal(estimateWinProb(NaN, 5, "nba"), null);
  });

  it("null margin → null", () => {
    assert.equal(estimateWinProb(null, 5, "nba"), null);
  });

  // --- Sanity checks calibrated against inpredictable.com ---
  // NBA: +10, 5 min Q4 → inpredictable says ~95.6% (without possession)
  it("NBA +10, 5 min left → ≈ 93-98%", () => {
    const wp = estimateWinProb(10, 5, "nba");
    assert.ok(wp > 0.93 && wp < 0.98, `wp=${wp} expected ~95.7%`);
  });

  // NBA: +5, 3 min left → ~83-88%
  it("NBA +5, 3 min left → ≈ 78-90%", () => {
    const wp = estimateWinProb(5, 3, "nba");
    assert.ok(wp > 0.78 && wp < 0.92, `wp=${wp} expected ~84%`);
  });

  // CBB: +10, 5 min H2 → ~92-96% (empirical)
  it("CBB +10, 5 min left → ≈ 90-97%", () => {
    const wp = estimateWinProb(10, 5, "cbb");
    assert.ok(wp > 0.90 && wp < 0.97, `wp=${wp} expected ~93%`);
  });

  // NBA: +20, 5 min → should be >99%
  it("NBA +20, 5 min → > 99%", () => {
    const wp = estimateWinProb(20, 5, "nba");
    assert.ok(wp > 0.99, `wp=${wp} expected > 99%`);
  });

  // NBA: +5, 5 min → should be ~80% (not high enough to enter)
  it("NBA +5, 5 min → ≈ 76-86%", () => {
    const wp = estimateWinProb(5, 5, "nba");
    assert.ok(wp > 0.76 && wp < 0.86, `wp=${wp} expected ~81%`);
  });

  // Symmetry: negative margin mirror
  it("symmetry: wp(+m) + wp(-m) ≈ 1", () => {
    const pos = estimateWinProb(8, 10, "nba");
    const neg = estimateWinProb(-8, 10, "nba");
    assert.ok(Math.abs((pos + neg) - 1.0) < 0.001, `pos=${pos} neg=${neg} sum=${pos + neg}`);
  });
});

describe("checkContextEntryGate", () => {
  // --- CBB: allowed ---
  it("CBB H2, 4 min, margin +8 → allowed", () => {
    const r = checkContextEntryGate({
      sport: "cbb", period: 2, minutesLeft: 4, marginForYes: 8,
      minWinProb: 0.90, maxMinutesLeft: 5, minMargin: 1
    });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, "pass");
    assert.ok(r.win_prob > 0.90);
  });

  // --- CBB: not_final_period ---
  it("CBB H1 → not_final_period", () => {
    const r = checkContextEntryGate({
      sport: "cbb", period: 1, minutesLeft: 4, marginForYes: 10
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "not_final_period");
  });

  // --- NBA: allowed in Q4 ---
  it("NBA Q4, 3 min, margin +10 → allowed", () => {
    const r = checkContextEntryGate({
      sport: "nba", period: 4, minutesLeft: 3, marginForYes: 10
    });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, "pass");
    assert.ok(r.win_prob > 0.90);
  });

  // --- NBA: OT (period=5) should also be allowed ---
  it("NBA OT (period=5), 2 min, margin +6 → allowed", () => {
    const r = checkContextEntryGate({
      sport: "nba", period: 5, minutesLeft: 2, marginForYes: 6
    });
    assert.equal(r.allowed, true);
    assert.ok(r.win_prob > 0.90);
  });

  // --- NBA: not_final_period ---
  it("NBA Q3 → not_final_period", () => {
    const r = checkContextEntryGate({
      sport: "nba", period: 3, minutesLeft: 4, marginForYes: 10
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "not_final_period");
  });

  // --- too_much_time_left ---
  it("CBB H2 but 15 min left → too_much_time_left", () => {
    const r = checkContextEntryGate({
      sport: "cbb", period: 2, minutesLeft: 15, marginForYes: 10
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "too_much_time_left");
  });

  // --- not_ahead (margin 0) ---
  it("margin 0 → not_ahead", () => {
    const r = checkContextEntryGate({
      sport: "nba", period: 4, minutesLeft: 3, marginForYes: 0
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "not_ahead");
  });

  // --- not_ahead (negative margin) ---
  it("negative margin → not_ahead", () => {
    const r = checkContextEntryGate({
      sport: "nba", period: 4, minutesLeft: 3, marginForYes: -5
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "not_ahead");
  });

  // --- winprob_below_threshold ---
  it("small margin, much time → winprob_below_threshold", () => {
    const r = checkContextEntryGate({
      sport: "nba", period: 4, minutesLeft: 5, marginForYes: 2
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "winprob_below_threshold");
    assert.ok(r.win_prob != null && r.win_prob < 0.90);
  });

  // --- no_context ---
  it("null period → no_context", () => {
    const r = checkContextEntryGate({
      sport: "nba", period: null, minutesLeft: 5, marginForYes: 10
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "no_context");
  });

  it("null minutesLeft → no_context", () => {
    const r = checkContextEntryGate({
      sport: "nba", period: 4, minutesLeft: null, marginForYes: 10
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "no_context");
  });

  it("null marginForYes → no_context", () => {
    const r = checkContextEntryGate({
      sport: "nba", period: 4, minutesLeft: 3, marginForYes: null
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "no_context");
  });

  // --- unknown_sport ---
  it("unknown sport → unknown_sport", () => {
    const r = checkContextEntryGate({
      sport: "curling", period: 2, minutesLeft: 3, marginForYes: 10
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "unknown_sport");
  });

  it("soccer delegates to checkSoccerEntryGate", () => {
    // Soccer gate requires confidence:"high" — without it, blocks with low_confidence
    const r = checkContextEntryGate({
      sport: "soccer", period: 2, minutesLeft: 3, marginForYes: 2
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "low_confidence"); // proves delegation happened
  });

  // --- minMargin edge case ---
  it("minMargin=1 blocks tied games (margin=0.5 rounds)", () => {
    // marginForYes = 0 should be blocked by not_ahead (minMargin default = 1)
    const r = checkContextEntryGate({
      sport: "nba", period: 4, minutesLeft: 3, marginForYes: 0
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "not_ahead");
  });

  // --- CBB OT (period=3) should be allowed (>= 2) ---
  it("CBB OT (period=3) with 2 min, margin +7 → allowed", () => {
    const r = checkContextEntryGate({
      sport: "cbb", period: 3, minutesLeft: 2, marginForYes: 7
    });
    assert.equal(r.allowed, true);
  });
});
