// Phase 1: Gamma-only discovery client (no CLOB/WS)

import { setTimeout as sleep } from "node:timers/promises";

export async function fetchLiveEvents(cfg) {
  const base = String(cfg?.gamma?.gamma_base_url || "https://gamma-api.polymarket.com").replace(/\/+$/, "");
  const tags = Array.isArray(cfg?.gamma?.gamma_tags) ? cfg.gamma.gamma_tags : ["esports", "nba", "ncaa-basketball"];
  const limitDefault = Number(cfg?.gamma?.max_events_per_fetch || 30);
  const limitByTag = (cfg?.gamma?.max_events_per_fetch_by_tag && typeof cfg.gamma.max_events_per_fetch_by_tag === "object")
    ? cfg.gamma.max_events_per_fetch_by_tag
    : {};
  const timeoutMs = Number(cfg?.gamma?.gamma_timeout_ms || 2500);

  const started = Date.now();

  const onlyLiveDefault = cfg?.gamma?.only_live_default;
  const onlyLiveByLeague = (cfg?.gamma?.only_live_by_league && typeof cfg.gamma.only_live_by_league === "object") ? cfg.gamma.only_live_by_league : {};

  const leagueFromTag = (tag) => {
    if (tag === "nba") return "nba";
    if (tag === "ncaa-basketball") return "cbb";
    if (tag === "esports") return "esports";
    return String(tag || "");
  };

  const isOnlyLiveForTag = (tag) => {
    const league = leagueFromTag(tag);
    if (Object.prototype.hasOwnProperty.call(onlyLiveByLeague, league)) return !!onlyLiveByLeague[league];
    // Default behavior: preserve existing live=true unless explicitly disabled.
    return (onlyLiveDefault === undefined) ? true : !!onlyLiveDefault;
  };

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const results = {};
    for (const tag of tags) {
      const onlyLive = isOnlyLiveForTag(tag);
      const liveParam = onlyLive ? "&live=true" : "";
      const limit = Number(Object.prototype.hasOwnProperty.call(limitByTag, tag) ? limitByTag[tag] : limitDefault);
      const url = `${base}/events?active=true&closed=false&tag_slug=${encodeURIComponent(tag)}&limit=${limit}&order=volume&ascending=false${liveParam}`;
      const r = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return { ok: false, error: `Gamma ${r.status} ${r.statusText}${body ? ` :: ${body.slice(0, 200)}` : ""}`, data: null };
      }
      const j = await r.json();
      results[tag] = Array.isArray(j) ? j : [];
      // micro-yield to be polite
      await sleep(0);
    }
    return { ok: true, data: results, error: null, duration_ms: Math.max(0, Date.now() - started) };
  } catch (e) {
    const msg = e?.name === "AbortError" ? `Gamma timeout after ${timeoutMs}ms` : (e?.message || String(e));
    return { ok: false, error: msg, data: null, duration_ms: Math.max(0, Date.now() - started) };
  } finally {
    clearTimeout(to);
  }
}
