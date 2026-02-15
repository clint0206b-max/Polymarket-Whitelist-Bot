function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

export function evictIfNeeded(state, cfg) {
  const wl = state.watchlist || {};
  const max = Number(cfg?.polling?.max_watchlist || 200);
  const ids = Object.keys(wl);
  if (ids.length <= max) return { evicted: 0 };

  const rank = (st) => {
    if (st === "expired") return 0;
    if (st === "ignored") return 1;
    if (st === "traded") return 2;
    return 3;
  };

  const entries = ids.map(id => ({
    id,
    status: String(wl[id]?.status || "watching"),
    lastSeen: asNum(wl[id]?.last_seen_ts)
  }));

  entries.sort((a, b) => {
    const ra = rank(a.status);
    const rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    return a.lastSeen - b.lastSeen;
  });

  const over = ids.length - max;
  for (let i = 0; i < over; i++) delete wl[entries[i].id];

  return { evicted: over };
}
