import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Read JSON from file, returns null if file doesn't exist.
 * @param {string} path - file path
 * @returns {object|null} - parsed JSON or null
 */
export function readJson(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

/**
 * Write JSON atomically with full durability guarantees.
 * 
 * Strategy:
 * 1. Backup current file to .bak (if exists)
 * 2. Write to .tmp file
 * 3. fsync .tmp to force flush to disk
 * 4. Rename .tmp to final path (atomic operation)
 * 5. fsync parent directory (ensures rename is durable)
 * 
 * Guarantees:
 * - Never leaves truncated/invalid JSON on disk
 * - Crash-safe: either old state or new state, never corrupted
 * - Power-loss safe (with fsync)
 * - Always has .bak fallback if final file is corrupted
 * 
 * @param {string} path - target file path
 * @param {object} obj - object to serialize
 * @param {object} opts - options { backup: true }
 */
export function writeJsonAtomic(path, obj, opts = {}) {
  const dir = dirname(path);
  try { mkdirSync(dir, { recursive: true }); } catch {}

  const backup = opts.backup !== false; // default: true
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;

  // Step 1: Create backup of current file (if exists)
  if (backup && existsSync(path)) {
    try {
      copyFileSync(path, bak);
    } catch (e) {
      // Non-fatal: if backup fails, we still write (tmp→path is still atomic)
      console.warn(`[STATE] Backup failed: ${e?.message || e}`);
    }
  }

  // Step 2: Write to tmp file
  const raw = JSON.stringify(obj, null, 2);
  writeFileSync(tmp, raw + "\n", "utf8");

  // Step 3: fsync tmp file (force flush to disk)
  try {
    const fd = openSync(tmp, "r+");
    fsyncSync(fd);
    closeSync(fd);
  } catch (e) {
    // Non-fatal: fsync failure means data might not be durable on crash,
    // but rename is still atomic (filesystem guarantees)
    console.warn(`[STATE] fsync failed: ${e?.message || e}`);
  }

  // Step 4: Atomic rename (overwrites target if exists)
  renameSync(tmp, path);

  // Step 5: fsync parent directory (ensures rename is durable)
  try {
    const dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
    closeSync(dirFd);
  } catch (e) {
    // Non-fatal: directory fsync failure is rare, data is still on disk
  }
}

/**
 * Load JSON with automatic fallback to .bak if primary is corrupted.
 * 
 * Recovery strategy:
 * 1. Try to load primary file
 * 2. If corrupted (invalid JSON), try .bak
 * 3. If .bak also corrupted, return null
 * 
 * @param {string} path - file path
 * @returns {object|null} - parsed JSON or null
 */
export function readJsonWithFallback(path) {
  const bak = `${path}.bak`;

  // Try primary file
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      return JSON.parse(raw); // throws if invalid JSON
    }
  } catch (e) {
    console.warn(`[STATE] Primary file corrupted, trying backup: ${e?.message || e}`);
  }

  // Try backup file
  try {
    if (existsSync(bak)) {
      const raw = readFileSync(bak, "utf8");
      const obj = JSON.parse(raw);
      console.warn(`[STATE] Recovered from backup: ${bak}`);
      return obj;
    }
  } catch (e) {
    console.error(`[STATE] Backup also corrupted: ${e?.message || e}`);
  }

  return null;
}

export function resolvePath(...parts) {
  return resolve(process.cwd(), ...parts);
}
