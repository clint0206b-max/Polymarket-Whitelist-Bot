import { openSync, closeSync, unlinkSync, readFileSync, existsSync, writeFileSync } from "node:fs";

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLockInfo(s) {
  const t = String(s || "").trim();
  const [pidStr, tsStr] = t.split(":");
  const pid = Number(pidStr);
  const ts = Number(tsStr);
  return { raw: t, pid: Number.isFinite(pid) ? pid : null, ts: Number.isFinite(ts) ? ts : null };
}

export function acquireLock(lockPath) {
  // Try once normally; if lock exists, check for stale PID and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      try { writeFileSync(lockPath, `${process.pid}:${Date.now()}\n`); } catch {}
      return { ok: true };
    } catch {
      let info = null;
      try { if (existsSync(lockPath)) info = readFileSync(lockPath, "utf8"); } catch {}
      const parsed = parseLockInfo(info);

      // If stale, remove and retry.
      if (parsed.pid && !pidAlive(parsed.pid)) {
        try { unlinkSync(lockPath); } catch {}
        continue;
      }

      return { ok: false, reason: "lock_exists", info: parsed.raw || null };
    }
  }

  return { ok: false, reason: "lock_exists" };
}

export function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch {}
}
