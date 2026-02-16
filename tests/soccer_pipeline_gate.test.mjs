import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkSoccerEntryGate, soccerWinProb } from "../src/strategy/win_prob_table.mjs";

// These tests verify the bloqueante gate logic that runs in loop_eval_http_only.mjs.
// The gate is extracted in checkSoccerEntryGate (pure function) so we test it directly.
// In the pipeline, if gate.allowed !== true, the market is skipped entirely (no Stage 1/2).

const DEFAULT_GATE_OPTS = {
  period: 2,
  minutesLeft: 10,
  marginForYes: 2,
  confidence: "high",
  lastScoreChangeAgoSec: 120,
  minWinProbMargin2: 0.97,
  minWinProbMargin3: 0.95,
  maxMinutesMargin2: 15,
  maxMinutesMargin3: 20,
  scoreChangeCooldownSec: 90,
};

function gate(overrides = {}) {
  return checkSoccerEntryGate({ ...DEFAULT_GATE_OPTS, ...overrides });
}

describe("soccer pipeline gate — bloqueante", () => {
  // A) confidence low → no pasa
  it("confidence low → blocked", () => {
    const r = gate({ confidence: "low" });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "low_confidence");
  });

  it("confidence undefined → blocked", () => {
    const r = gate({ confidence: undefined });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "low_confidence");
  });

  // B) period 1 → no pasa
  it("period 1 → blocked", () => {
    const r = gate({ period: 1 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "first_half");
  });

  // C) halftime → no pasa
  it("halftime (period=HT) → blocked", () => {
    const r = gate({ period: "HT" });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "extra_time_or_invalid");
  });

  it("period 0 → blocked", () => {
    const r = gate({ period: 0 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "extra_time_or_invalid");
  });

  // D) margin 1 → no pasa
  it("margin 1 → blocked", () => {
    const r = gate({ marginForYes: 1 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "margin_too_small");
  });

  it("margin 0 → blocked", () => {
    const r = gate({ marginForYes: 0 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "margin_too_small");
  });

  it("margin -1 (losing) → blocked", () => {
    const r = gate({ marginForYes: -1 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "margin_too_small");
  });

  it("margin null → blocked", () => {
    const r = gate({ marginForYes: null });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "no_context");
  });

  // E) margin 2, minutes_left 20 → no pasa (max 15 for margin 2)
  it("margin 2, 20 min left → blocked (too much time)", () => {
    const r = gate({ marginForYes: 2, minutesLeft: 20 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "too_much_time_left");
  });

  it("margin 2, 16 min left → blocked", () => {
    const r = gate({ marginForYes: 2, minutesLeft: 16 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "too_much_time_left");
  });

  // F) margin 2, minutes_left 10, win_prob ≥ 0.97 → pasa
  it("margin 2, 10 min, all good → PASSES gate", () => {
    const r = gate({ marginForYes: 2, minutesLeft: 10 });
    assert.equal(r.allowed, true);
    assert.ok(r.win_prob >= 0.97, `win_prob ${r.win_prob} should be >= 0.97`);
  });

  it("margin 2, 15 min exactly → PASSES (boundary)", () => {
    const r = gate({ marginForYes: 2, minutesLeft: 15 });
    assert.equal(r.allowed, true);
  });

  it("margin 2, 5 min → PASSES with very high win_prob", () => {
    const r = gate({ marginForYes: 2, minutesLeft: 5 });
    assert.equal(r.allowed, true);
    assert.ok(r.win_prob >= 0.99, `win_prob ${r.win_prob} should be very high at 5 min`);
  });

  // G) scoreChangedRecently true → no pasa
  it("score changed 30s ago (< 90s cooldown) → blocked", () => {
    const r = gate({ lastScoreChangeAgoSec: 30 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "score_change_cooldown");
  });

  it("score changed 89s ago → blocked", () => {
    const r = gate({ lastScoreChangeAgoSec: 89 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "score_change_cooldown");
  });

  it("score changed 90s ago → passes (exactly at boundary)", () => {
    const r = gate({ lastScoreChangeAgoSec: 90 });
    assert.equal(r.allowed, true);
  });

  it("score changed null (unknown) → passes (fail-open for cooldown)", () => {
    const r = gate({ lastScoreChangeAgoSec: null });
    assert.equal(r.allowed, true);
  });

  // Margin 3+ scenarios
  it("margin 3, 20 min → passes (uses extended window)", () => {
    const r = gate({ marginForYes: 3, minutesLeft: 20 });
    assert.equal(r.allowed, true);
    assert.ok(r.win_prob >= 0.95);
  });

  it("margin 3, 21 min → blocked", () => {
    const r = gate({ marginForYes: 3, minutesLeft: 21 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "too_much_time_left");
  });

  it("margin 4, 15 min → passes with very high prob", () => {
    const r = gate({ marginForYes: 4, minutesLeft: 15 });
    assert.equal(r.allowed, true);
    assert.ok(r.win_prob >= 0.99);
  });

  // Win prob threshold check
  it("margin 2 with custom low threshold → win_prob check", () => {
    // At 15 min, margin 2, the Poisson model gives ~0.97x
    // With a very high threshold like 0.999, it should fail
    const r = gate({ marginForYes: 2, minutesLeft: 15, minWinProbMargin2: 0.999 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "winprob_below_threshold");
  });

  // Pipeline simulation: what the eval loop does
  it("simulates full pipeline gate check", () => {
    // This mimics what loop_eval_http_only.mjs does:
    // 1. soccer_context from ESPN adapter sets these fields
    // 2. checkSoccerEntryGate runs with config values
    // 3. If allowed !== true → continue (skip market)

    const soccerContext = {
      state: "in",
      period: 2,
      minutes_left: 8,
      margin_for_yes: 2,
      confidence: "high",
      lastScoreChangeAgoSec: 120,
    };

    // Simulate gate check as the pipeline does it
    const gateResult = checkSoccerEntryGate({
      period: soccerContext.period,
      minutesLeft: soccerContext.minutes_left,
      marginForYes: soccerContext.margin_for_yes,
      confidence: soccerContext.confidence,
      lastScoreChangeAgoSec: soccerContext.lastScoreChangeAgoSec,
      minWinProbMargin2: 0.97,
      minWinProbMargin3: 0.95,
      maxMinutesMargin2: 15,
      maxMinutesMargin3: 20,
      scoreChangeCooldownSec: 90,
    });

    assert.equal(gateResult.allowed, true);

    // context_entry snapshot that would be stored
    const contextEntry = {
      margin_for_yes: soccerContext.margin_for_yes,
      win_prob: gateResult.win_prob,
      entry_allowed: gateResult.allowed,
      entry_blocked_reason: gateResult.allowed ? null : gateResult.reason,
    };

    assert.equal(contextEntry.entry_allowed, true);
    assert.equal(contextEntry.entry_blocked_reason, null);
    assert.ok(contextEntry.win_prob >= 0.97);
  });

  // No context at all → blocked
  it("no context (context_entry undefined) → would be blocked in pipeline", () => {
    // In the pipeline: m.context_entry?.entry_allowed === true → false when undefined
    const contextEntry = undefined;
    const soccerAllowed = contextEntry?.entry_allowed === true;
    assert.equal(soccerAllowed, false);
  });
});

describe("soccerWinProb — Poisson model sanity", () => {
  it("margin 2, 10 min left → ~0.98+", () => {
    const p = soccerWinProb(2, 10);
    assert.ok(p >= 0.97 && p <= 1.0, `got ${p}`);
  });

  it("margin 1, 10 min left → below 0.97", () => {
    const p = soccerWinProb(1, 10);
    assert.ok(p < 0.97, `margin=1 should be risky, got ${p}`);
  });

  it("margin 2, 0 min left → very close to 1", () => {
    const p = soccerWinProb(2, 0);
    assert.ok(p >= 0.999, `got ${p}`);
  });

  it("margin 3, 20 min left → ≥ 0.95", () => {
    const p = soccerWinProb(3, 20);
    assert.ok(p >= 0.95, `got ${p}`);
  });

  it("margin 0, any time → ~0.30-0.40 (draw)", () => {
    const p = soccerWinProb(0, 10);
    assert.ok(p < 0.5, `draw should be low prob, got ${p}`);
  });
});
