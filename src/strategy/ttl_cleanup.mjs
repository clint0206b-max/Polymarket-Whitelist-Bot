export function markExpired(state, cfg, now) {
  const ttlMin = Number(cfg?.polling?.watchlist_ttl_minutes || 30);
  const ttlMs = ttlMin * 60_000;

  const wl = state.watchlist || {};
  let marked = 0;

  for (const m of Object.values(wl)) {
    const last = Number(m?.last_seen_ts || 0);
    if (!last) continue;
    if (now - last > ttlMs && m.status !== "expired") {
      m.status = "expired";
      m.notes = m.notes || {};
      m.notes.reason_expired = "ttl";
      marked++;
    }
  }

  return { marked };
}
