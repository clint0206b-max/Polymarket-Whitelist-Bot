import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function readJson(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

export function writeJsonAtomic(path, obj) {
  const dir = dirname(path);
  try { mkdirSync(dir, { recursive: true }); } catch {}

  const tmp = `${path}.tmp`;
  const raw = JSON.stringify(obj, null, 2);
  writeFileSync(tmp, raw + "\n");
  renameSync(tmp, path);
}

export function resolvePath(...parts) {
  return resolve(process.cwd(), ...parts);
}
