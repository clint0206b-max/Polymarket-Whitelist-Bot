const VALID_STATUS = new Set(["watching","pending_signal","signaled","traded","ignored","expired"]);

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export function checkAndFixInvariants(state, cfg, now) {
  state.runtime = state.runtime || {};
  state.runtime.health = state.runtime.health || {};

  const health = state.runtime.health;
  health.integrity_violation_count = health.integrity_violation_count || 0;
  health.integrity_violation_by_rule = health.integrity_violation_by_rule || {};

  function bump(rule) {
    health.integrity_violation_count++;
    health.integrity_violation_by_rule[rule] = (health.integrity_violation_by_rule[rule] || 0) + 1;
    health.integrity_last_violation_ts = now;
  }

  const wl = state.watchlist || {};
  for (const [id, m] of Object.entries(wl)) {
    // I1 status domain
    const st = String(m?.status || "watching");
    if (!VALID_STATUS.has(st)) {
      bump("I1");
      m.status = "ignored";
      m.notes = m.notes || {};
      m.notes.reason_ignored = "invalid_status";
    }

    // I3 pending requires timestamp (+ deadline)
    if (m.status === "pending_signal") {
      if (m.pending_since_ts == null) {
        bump("I3");
        m.status = "watching";
        delete m.pending_since_ts;
        delete m.pending_deadline_ts;
      } else {
        // ensure deadline exists
        if (m.pending_deadline_ts == null) {
          bump("I3_deadline_missing");
          const winMs = Number(cfg?.polling?.pending_window_seconds || 6) * 1000;
          m.pending_deadline_ts = Number(m.pending_since_ts) + winMs;
        }
      }
    } else {
      // I4 pending absent otherwise
      if (m.pending_since_ts != null || m.pending_deadline_ts != null) {
        bump("I4");
        delete m.pending_since_ts;
        delete m.pending_deadline_ts;
      }
    }

    // I1 expired implies no pipeline is operational (no-op here)

    // I8 last_seen monotonic not enforceable without prev; ensure numeric
    const ls = asNum(m.last_seen_ts);
    if (ls == null) {
      bump("I8");
      m.last_seen_ts = now;
    }

    // I9 first_seen <= last_seen
    const fs = asNum(m.first_seen_ts);
    if (fs != null && ls != null && fs > ls) {
      bump("I9");
      m.first_seen_ts = ls;
    }
  }

  return state;
}
