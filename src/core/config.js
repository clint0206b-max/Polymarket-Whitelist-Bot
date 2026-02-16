import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function readJsonFile(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function deepMerge(a, b) {
  if (!isObj(a)) return b;
  if (!isObj(b)) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = isObj(v) ? deepMerge(a[k], v) : v;
  }
  return out;
}

/**
 * Resolve the runner identity from SHADOW_ID env var.
 * Returns { id, isProd, stateDir, shadowConfigPath }
 */
export function resolveRunner() {
  const shadowId = process.env.SHADOW_ID || "";
  const isProd = !shadowId;
  const id = shadowId || "prod";
  const stateDir = isProd ? "state" : `state-${shadowId}`;
  const shadowConfigPath = isProd ? null : resolve(process.cwd(), stateDir, "config-override.json");
  return { id, isProd, stateDir, shadowConfigPath };
}

export function loadConfig() {
  const runner = resolveRunner();
  const defaultsPath = resolve(process.cwd(), "src", "config", "defaults.json");
  const localPath = resolve(process.cwd(), "src", "config", "local.json");

  const defaults = readJsonFile(defaultsPath);
  const local = existsSync(localPath) ? readJsonFile(localPath) : {};

  // Shadow config overlay (if shadow runner)
  let shadowOverlay = {};
  if (runner.shadowConfigPath && existsSync(runner.shadowConfigPath)) {
    shadowOverlay = readJsonFile(runner.shadowConfigPath);
  }

  // Env overrides (minimal v0): allow JSON blob override
  const envJson = process.env.WATCHLIST_CONFIG_JSON ? JSON.parse(process.env.WATCHLIST_CONFIG_JSON) : {};

  // Precedence: defaults → local (prod) → shadow overlay → env vars
  const merged = deepMerge(deepMerge(deepMerge(defaults, local), shadowOverlay), envJson);

  // Inject runner metadata
  merged._runner = {
    id: runner.id,
    isProd: runner.isProd,
    stateDir: runner.stateDir,
  };

  return merged;
}
