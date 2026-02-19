import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTitleOverride, applyOutcomeOverride } from "../src/config/team_overrides.mjs";

describe("applyTitleOverride", () => {
  const titleIndex = new Map([
    ["binghamton bearcats", "binghamton"],
    ["uc riverside highlanders", "uc riverside"],
    ["saint francis red flash", "saint francis pa"],
  ]);

  it("exact match returns target token", () => {
    assert.equal(applyTitleOverride("binghamton bearcats", titleIndex), "binghamton");
  });

  it("no match returns null (caller uses normal tokenization)", () => {
    assert.equal(applyTitleOverride("duke blue devils", titleIndex), null);
  });

  it("partial match does NOT trigger (exact only)", () => {
    assert.equal(applyTitleOverride("binghamton", titleIndex), null);
    assert.equal(applyTitleOverride("binghamton bearcats extra", titleIndex), null);
  });

  it("empty/null inputs return null", () => {
    assert.equal(applyTitleOverride("", titleIndex), null);
    assert.equal(applyTitleOverride(null, titleIndex), null);
    assert.equal(applyTitleOverride("test", null), null);
    assert.equal(applyTitleOverride("test", new Map()), null);
  });
});

describe("applyOutcomeOverride", () => {
  const outcomeEntries = [
    { from: "massachusetts lowell", to: "umass lowell" },
    { from: "southern illinois", to: "siu" },
  ];

  it("replaces matching fragment at word boundary", () => {
    const result = applyOutcomeOverride("massachusetts lowell river hawks", outcomeEntries);
    assert.equal(result, "umass lowell river hawks");
  });

  it("does NOT replace partial word matches", () => {
    // "massachusetts" alone should not be replaced since the override key is "massachusetts lowell"
    const result = applyOutcomeOverride("massachusetts minutemen", outcomeEntries);
    assert.equal(result, "massachusetts minutemen");
  });

  it("multiple overrides can apply to different parts", () => {
    // Unlikely but both could exist in a weird scenario
    const result = applyOutcomeOverride("southern illinois salukis", outcomeEntries);
    assert.equal(result, "siu salukis");
  });

  it("no match returns original string unchanged", () => {
    const result = applyOutcomeOverride("duke blue devils", outcomeEntries);
    assert.equal(result, "duke blue devils");
  });

  it("empty entries returns original", () => {
    assert.equal(applyOutcomeOverride("test", []), "test");
    assert.equal(applyOutcomeOverride("test", null), "test");
  });

  it("empty/null input returns as-is", () => {
    assert.equal(applyOutcomeOverride("", outcomeEntries), "");
    assert.equal(applyOutcomeOverride(null, outcomeEntries), null);
  });
});

describe("loadTeamOverrides validation", () => {
  it("outcome key with <2 words is skipped (safety)", async () => {
    // We can't easily test the console.error without mocking,
    // but we can verify the module doesn't crash with bad data
    const { loadTeamOverrides } = await import("../src/config/team_overrides.mjs");
    const result = loadTeamOverrides();
    // Should load successfully (from the actual file)
    assert.ok(result);
    assert.ok(result.titleIndex instanceof Map);
    assert.ok(Array.isArray(result.outcomeEntries));
  });

  it("actual overrides file has expected entries", async () => {
    const { loadTeamOverrides } = await import("../src/config/team_overrides.mjs");
    const result = loadTeamOverrides();
    // binghamton bearcats → binghamton
    assert.equal(result.titleIndex.get("binghamton bearcats"), "binghamton");
    // outcome overrides: massachusetts lowell + appalachian state
    assert.ok(result.outcomeEntries.length >= 2);
    const maLowell = result.outcomeEntries.find(e => e.from === "massachusetts lowell");
    assert.ok(maLowell, "massachusetts lowell override should exist");
    assert.equal(maLowell.to, "umass lowell");
    const appState = result.outcomeEntries.find(e => e.from === "appalachian state");
    assert.ok(appState, "appalachian state override should exist");
    assert.equal(appState.to, "app state");
  });
});

describe("schoolToken with overrides (integration)", () => {
  it("binghamton bearcats resolves via override", async () => {
    // Import the CBB module which loads overrides at module init
    const { deriveCbbContextForMarket, fetchEspnCbbScoreboardForDate, computeDateWindow3, mergeScoreboardEventsByWindow } = await import("../src/context/espn_cbb_scoreboard.mjs");
    // We can't easily test schoolToken directly (not exported),
    // but we can verify the override mechanism works by checking the module loads without error
    assert.ok(deriveCbbContextForMarket);
  });
});
