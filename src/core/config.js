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

export function loadConfig() {
  const defaultsPath = resolve(process.cwd(), "src", "config", "defaults.json");
  const localPath = resolve(process.cwd(), "src", "config", "local.json");

  const defaults = readJsonFile(defaultsPath);
  const local = existsSync(localPath) ? readJsonFile(localPath) : {};

  // Env overrides (minimal v0): allow JSON blob override
  const envJson = process.env.WATCHLIST_CONFIG_JSON ? JSON.parse(process.env.WATCHLIST_CONFIG_JSON) : {};

  return deepMerge(deepMerge(defaults, local), envJson);
}
