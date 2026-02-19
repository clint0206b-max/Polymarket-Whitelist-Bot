// team_overrides.mjs — Load and apply team name overrides for Polymarket ↔ ESPN matching.
// Two separate namespaces:
//   title_school_overrides  → System 1 (market title → ESPN game matching)
//   outcome_team_overrides  → System 2 (yes outcome → ESPN team for margin)

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = join(__dirname, "team-overrides.json");

// Simple norm (same as espn_cbb_scoreboard.mjs)
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Load overrides from JSON file. Returns { titleIndex, outcomeEntries } or null on error.
 *
 * titleIndex: Map<normalized_variant, target_token>  (for System 1)
 * outcomeEntries: Array<{ from: string, to: string }> (for System 2, sorted longest-first)
 */
export function loadTeamOverrides() {
  let raw;
  try {
    raw = readFileSync(OVERRIDES_PATH, "utf8");
  } catch (e) {
    // File missing or unreadable — no overrides, not an error
    return { titleIndex: new Map(), outcomeEntries: [] };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error("[TEAM_OVERRIDES] Invalid JSON in team-overrides.json:", e.message);
    return { titleIndex: new Map(), outcomeEntries: [] };
  }

  // --- Build titleIndex: variant → target ---
  const titleIndex = new Map();
  const titleOverrides = data?.title_school_overrides || {};
  for (const [_key, entry] of Object.entries(titleOverrides)) {
    if (!entry || typeof entry !== "object") continue;
    const target = typeof entry.target === "string" ? norm(entry.target) : null;
    if (!target) continue;
    const variants = Array.isArray(entry.variants) ? entry.variants : [];
    for (const v of variants) {
      const nv = norm(v);
      if (nv) titleIndex.set(nv, target);
    }
  }

  // --- Build outcomeEntries: sorted longest-first for safe replacement ---
  const outcomeEntries = [];
  const outcomeOverrides = data?.outcome_team_overrides || {};
  for (const [from, to] of Object.entries(outcomeOverrides)) {
    const nFrom = norm(from);
    const nTo = norm(to);
    if (!nFrom || !nTo) continue;
    // Safety: require ≥2 words to avoid overly generic replacements
    const wordCount = nFrom.split(/\s+/).length;
    if (wordCount < 2) {
      console.error(`[TEAM_OVERRIDES] Skipping outcome override "${from}" → "${to}": key must be ≥2 words`);
      continue;
    }
    outcomeEntries.push({ from: nFrom, to: nTo });
  }
  // Sort longest-first so longer matches take priority
  outcomeEntries.sort((a, b) => b.from.length - a.from.length);

  console.log(`[TEAM_OVERRIDES] Loaded ${titleIndex.size} title override variant(s), ${outcomeEntries.length} outcome override(s)`);
  return { titleIndex, outcomeEntries };
}

/**
 * Apply title_school_overrides: if the normalized name matches a variant, return the target token.
 * Otherwise return null (caller should proceed with normal tokenization).
 *
 * @param {string} normalizedName - post-norm() team name
 * @param {Map} titleIndex - from loadTeamOverrides()
 * @returns {string|null}
 */
export function applyTitleOverride(normalizedName, titleIndex) {
  if (!titleIndex || !normalizedName) return null;
  return titleIndex.get(normalizedName) || null;
}

/**
 * Apply outcome_team_overrides: replace matching fragments in normalized outcome string.
 * Uses word-boundary matching to avoid accidental substring replacements.
 *
 * @param {string} normalizedOutcome - post-normTeam() outcome string
 * @param {Array} outcomeEntries - from loadTeamOverrides()
 * @returns {string} - outcome with replacements applied
 */
export function applyOutcomeOverride(normalizedOutcome, outcomeEntries) {
  if (!outcomeEntries?.length || !normalizedOutcome) return normalizedOutcome;
  let result = normalizedOutcome;
  for (const { from, to } of outcomeEntries) {
    // Word-boundary match: the "from" must appear as complete words, not as a substring
    // of a larger word. We use a regex with \b (word boundary).
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "g");
    result = result.replace(re, to);
  }
  return result;
}
