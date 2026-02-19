import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readSignalsOpenSlugs } from "../src/core/journal.mjs";

const TEST_DIR = join(tmpdir(), `polymarket-signals-test-${process.pid}`);
const SIGNALS_PATH = join(TEST_DIR, "signals.jsonl");

function ensureDir() { mkdirSync(TEST_DIR, { recursive: true }); }
function cleanDir() { rmSync(TEST_DIR, { recursive: true, force: true }); }

function writeSignals(lines) {
  writeFileSync(SIGNALS_PATH, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

describe("readSignalsOpenSlugs", () => {
  beforeEach(ensureDir);
  afterEach(cleanDir);

  it("returns empty array for nonexistent file", () => {
    const result = readSignalsOpenSlugs(join(TEST_DIR, "nope.jsonl"));
    assert.deepStrictEqual(result, []);
  });

  it("returns empty array for empty file", () => {
    writeFileSync(SIGNALS_PATH, "");
    const result = readSignalsOpenSlugs(SIGNALS_PATH);
    assert.deepStrictEqual(result, []);
  });

  it("returns slug when signal_open exists without signal_close", () => {
    writeSignals([
      { type: "signal_open", signal_id: "1|cs2-a-b-2026-02-18", slug: "cs2-a-b-2026-02-18" },
    ]);
    const result = readSignalsOpenSlugs(SIGNALS_PATH);
    assert.deepStrictEqual(result, ["cs2-a-b-2026-02-18"]);
  });

  it("does NOT return slug when signal_open has matching signal_close", () => {
    writeSignals([
      { type: "signal_open", signal_id: "1|cs2-a-b-2026-02-18", slug: "cs2-a-b-2026-02-18" },
      { type: "signal_close", signal_id: "1|cs2-a-b-2026-02-18", close_reason: "resolved" },
    ]);
    const result = readSignalsOpenSlugs(SIGNALS_PATH);
    assert.deepStrictEqual(result, []);
  });

  it("returns multiple open slugs, excludes closed ones", () => {
    writeSignals([
      { type: "signal_open", signal_id: "1|cs2-a-b", slug: "cs2-a-b" },
      { type: "signal_open", signal_id: "2|lol-c-d", slug: "lol-c-d" },
      { type: "signal_open", signal_id: "3|val-e-f", slug: "val-e-f" },
      { type: "signal_close", signal_id: "2|lol-c-d", close_reason: "sl" },
    ]);
    const result = readSignalsOpenSlugs(SIGNALS_PATH);
    assert.ok(result.includes("cs2-a-b"));
    assert.ok(result.includes("val-e-f"));
    assert.ok(!result.includes("lol-c-d"));
    assert.strictEqual(result.length, 2);
  });

  it("handles malformed JSON lines gracefully", () => {
    writeFileSync(SIGNALS_PATH, [
      JSON.stringify({ type: "signal_open", signal_id: "1|dota2-x-y", slug: "dota2-x-y" }),
      "NOT VALID JSON {{{",
      JSON.stringify({ type: "signal_open", signal_id: "2|cs2-a-b", slug: "cs2-a-b" }),
    ].join("\n") + "\n");
    const result = readSignalsOpenSlugs(SIGNALS_PATH);
    assert.deepStrictEqual(result, ["dota2-x-y", "cs2-a-b"]);
  });

  it("skips entries without signal_id or slug", () => {
    writeSignals([
      { type: "signal_open", slug: "no-id" },
      { type: "signal_open", signal_id: "1|no-slug" },
      { type: "signal_open", signal_id: "2|good", slug: "good" },
    ]);
    const result = readSignalsOpenSlugs(SIGNALS_PATH);
    assert.deepStrictEqual(result, ["good"]);
  });
});
