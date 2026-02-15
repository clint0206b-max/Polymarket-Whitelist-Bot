import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { readJson, writeJsonAtomic, resolvePath } from "./state_store.js";

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }); } catch {}
}

export function appendJsonl(relPath, obj) {
  const abs = resolvePath(relPath);
  ensureDir(dirname(abs));
  appendFileSync(abs, JSON.stringify(obj) + "\n");
}

export function loadOpenIndex(relPath = "state/journal/open_index.json") {
  const abs = resolvePath(relPath);
  const cur = existsSync(abs) ? readJson(abs) : null;
  const out = (cur && typeof cur === "object" && !Array.isArray(cur)) ? cur : { v: 1, open: {} };
  if (!out.open || typeof out.open !== "object") out.open = {};
  out.v = 1;
  return out;
}

export function saveOpenIndex(index, relPath = "state/journal/open_index.json") {
  const abs = resolvePath(relPath);
  writeJsonAtomic(abs, index);
}

export function addOpen(index, signalId, row) {
  index.open[String(signalId)] = row;
}

export function removeOpen(index, signalId) {
  delete index.open[String(signalId)];
}
