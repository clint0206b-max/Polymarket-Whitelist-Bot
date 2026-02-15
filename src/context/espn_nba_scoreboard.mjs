// NBA context feed (D2 v0) — ESPN scoreboard
// Tag-only: no strategy changes, only observability fields.

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseClockToMinutes(displayClock) {
  // ESPN displayClock is typically "MM:SS" remaining in period.
  const t = String(displayClock || "").trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const ss = Number(m[2]);
  if (!Number.isFinite(mm) || !Number.isFinite(ss)) return null;
  return mm + (ss / 60);
}

// --- Team name normalization (deterministic; no fuzzy) ---
const TEAM_ALIAS = {
  "la": "los angeles",
  "st": "saint",
  "st.": "saint",
  "mt": "mount",
  "mt.": "mount"
};

const STOPWORDS = new Set(["university", "college"]);

function applyAliases(tokens) {
  return tokens.map(t => TEAM_ALIAS[t] || t);
}

function schoolToken(name) {
  let t = norm(name);
  if (!t) return "";

  let parts = t.split(" ").filter(Boolean);
  parts = applyAliases(parts);
  parts = parts.filter(x => !STOPWORDS.has(x));

  // compact common ESPN punctuation artifact: "l a" -> "los angeles" already handled by aliasing tokens
  let out = parts.join(" ").trim();
  return out;
}

function schoolKey(a, b) {
  const aa = schoolToken(a);
  const bb = schoolToken(b);
  if (!aa || !bb) return null;
  return [aa, bb].sort().join("|");
}

function teamKey(a, b) {
  const aa = norm(a);
  const bb = norm(b);
  if (!aa || !bb) return null;
  return [aa, bb].sort().join("|");
}

function getTeamAliases(team) {
  const out = [];
  const push = (x) => { const t = norm(x); if (t && !out.includes(t)) out.push(t); };
  push(team?.shortDisplayName);
  push(team?.displayName);
  push(team?.location);
  push(team?.name);
  push(team?.abbreviation);
  return out;
}

function parseMarketTeamsFromTitle(title) {
  const t = String(title || "");
  const raw = t
    .replace(/\bNo\.?\s*\d+\b/gi, " ")
    .replace(/\(#\d+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // separators: vs, v, at
  const seps = [" vs ", " v ", " at ", " vs. ", " v. "];
  const low = ` ${raw.toLowerCase()} `;
  let best = null;
  for (const sep of seps) {
    const idx = low.indexOf(sep);
    if (idx > 0) {
      const left = raw.slice(0, idx).trim();
      const right = raw.slice(idx + sep.trim().length).trim();
      if (left && right) best = { left, right, sep: sep.trim() };
      break;
    }
  }
  if (!best) return { ok: false, reason: "no_sep" };

  const legacyKey = teamKey(best.left, best.right);
  const teamsKey = schoolKey(best.left, best.right);

  return {
    ok: true,
    legacyKey: legacyKey || null,
    teamsKey: teamsKey || null,
    teams: {
      a_norm: norm(best.left),
      b_norm: norm(best.right),
      a_school: schoolToken(best.left),
      b_school: schoolToken(best.right)
    },
    raw: best
  };
}

function gameKeyFromCompetitors(comp) {
  const a = comp?.[0]?.team;
  const b = comp?.[1]?.team;

  const an = a?.shortDisplayName || a?.displayName || a?.location || a?.name;
  const bn = b?.shortDisplayName || b?.displayName || b?.location || b?.name;

  // NBA: location is usually the city/identifier; keep it deterministic.
  const anSchoolRaw = a?.location || a?.shortDisplayName || a?.displayName || a?.name;
  const bnSchoolRaw = b?.location || b?.shortDisplayName || b?.displayName || b?.name;

  const legacyKey = teamKey(an, bn);
  const teamsKey = schoolKey(anSchoolRaw, bnSchoolRaw);

  return {
    legacyKey,
    teamsKey,
    an: norm(an),
    bn: norm(bn),
    an_school: schoolToken(anSchoolRaw),
    bn_school: schoolToken(bnSchoolRaw)
  };
}

function matchByTitle(title, games) {
  const tNorm = norm(title);
  if (!tNorm) return { ok: false, reason: "no_title" };

  const parsedTeams = parseMarketTeamsFromTitle(title);
  if (!parsedTeams.ok) return { ok: false, reason: parsedTeams.reason || "no_sep" };

  // Pass 0: deterministic teamsKey
  if (parsedTeams.teamsKey) {
    const hits = [];
    for (const g of games) {
      const comp = g?.competitions?.[0]?.competitors;
      if (!Array.isArray(comp) || comp.length !== 2) continue;
      const gk = gameKeyFromCompetitors(comp);
      if (gk.teamsKey && gk.teamsKey === parsedTeams.teamsKey) hits.push({ game: g, key: gk.teamsKey });
    }
    if (hits.length === 1) return { ok: true, game: hits[0].game, match: { kind: "teamsKey_exact", key: parsedTeams.teamsKey } };
    if (hits.length > 1) return { ok: false, reason: "ambiguous", debug: { matchPath: "teamsKey_exact", teamsKey: parsedTeams.teamsKey, hits: hits.length } };
  }

  // Pass 1: legacy exact
  if (parsedTeams.legacyKey) {
    const hits = [];
    for (const g of games) {
      const comp = g?.competitions?.[0]?.competitors;
      if (!Array.isArray(comp) || comp.length !== 2) continue;
      const gk = gameKeyFromCompetitors(comp);
      if (gk.legacyKey && gk.legacyKey === parsedTeams.legacyKey) hits.push({ game: g, key: gk.legacyKey });
    }
    if (hits.length === 1) return { ok: true, game: hits[0].game, match: { kind: "legacy_exact", key: parsedTeams.legacyKey } };
    if (hits.length > 1) return { ok: false, reason: "ambiguous", debug: { matchPath: "legacy_exact", marketKey: parsedTeams.legacyKey, hits: hits.length } };
  }

  // Pass 2: alias containment
  let best = null;
  for (const g of games) {
    const comp = g?.competitions?.[0]?.competitors;
    if (!Array.isArray(comp) || comp.length !== 2) continue;

    const a = comp[0];
    const b = comp[1];

    const aAliases = getTeamAliases(a?.team);
    const bAliases = getTeamAliases(b?.team);

    const aHit = aAliases.find(x => x && tNorm.includes(x));
    const bHit = bAliases.find(x => x && tNorm.includes(x));
    if (!aHit || !bHit) continue;

    const score = (aHit.length + bHit.length);
    const row = { game: g, score, aHit, bHit };
    if (!best || row.score > best.score) best = row;
    else if (best && row.score === best.score) best = { ...best, ambiguous: true };
  }

  if (!best) {
    const cand = [];
    for (const g of games) {
      const comp = g?.competitions?.[0]?.competitors;
      if (!Array.isArray(comp) || comp.length !== 2) continue;
      const gk = gameKeyFromCompetitors(comp);
      if (!gk.teamsKey && !gk.legacyKey) continue;
      cand.push({
        teamsKey: gk.teamsKey || null,
        legacyKey: gk.legacyKey || null,
        a_school: gk.an_school,
        b_school: gk.bn_school,
        a: gk.an,
        b: gk.bn
      });
    }
    cand.sort((a, b) => String(a.teamsKey || a.legacyKey || "").localeCompare(String(b.teamsKey || b.legacyKey || "")));
    return {
      ok: false,
      reason: "no_match",
      debug: {
        titleNorm: tNorm,
        teamsKey: parsedTeams.teamsKey,
        legacyKey: parsedTeams.legacyKey,
        marketTeams: parsedTeams.teams,
        top: cand.slice(0, 5)
      }
    };
  }

  if (best.ambiguous) return { ok: false, reason: "ambiguous" };
  return { ok: true, game: best.game, match: { kind: "legacy_alias", aHit: best.aHit, bHit: best.bHit } };
}

export async function fetchEspnNbaScoreboardForDate(cfg, dateKey) {
  const timeoutMs = Number(cfg?.context?.nba?.timeout_ms || 2500);
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  const date = String(dateKey || "");
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${encodeURIComponent(date)}`;
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!r.ok) return { ok: false, reason: "http", http_status: r.status, date_key: date };

    let j = null;
    try {
      j = await r.json();
    } catch {
      return { ok: false, reason: "parse", http_status: r.status, date_key: date };
    }

    const events = Array.isArray(j?.events) ? j.events : [];
    return { ok: true, events, date_key: date };
  } catch (e) {
    return { ok: false, reason: e?.name === "AbortError" ? "timeout" : "network", date_key: date };
  } finally {
    clearTimeout(to);
  }
}

export function deriveNbaContextForMarket(market, events, cfg, nowTs) {
  const title = market?.title || market?.question || market?.slug;
  const m = matchByTitle(title, events);
  if (!m.ok) return { ok: false, reason: m.reason, debug: m.debug || null };

  const g = m.game;
  const comp = g?.competitions?.[0]?.competitors;
  const a = comp?.[0];
  const b = comp?.[1];

  const sa = toNum(a?.score);
  const sb = toNum(b?.score);
  const margin = (sa != null && sb != null) ? Math.abs(sa - sb) : null;

  const st = g?.status;
  const state = st?.type?.state; // "pre"|"in"|"post"
  const period = toNum(st?.period);
  const clockMin = parseClockToMinutes(st?.displayClock);

  let minutes_left = null;
  if (state === "in" && period != null && clockMin != null) {
    // NBA: 4 quarters of 12 minutes.
    // period=1..4 for regulation; OT periods are >=5.
    if (period >= 1 && period <= 4) minutes_left = ((4 - period) * 12) + clockMin;
    else minutes_left = clockMin; // OT treated as remaining OT minutes
  }

  // D2 decided v0 (same shape as CBB; can be calibrated later)
  const decided = (margin != null && minutes_left != null)
    ? ((margin >= 15 && minutes_left <= 6) || (margin >= 10 && minutes_left <= 3))
    : false;

  return {
    ok: true,
    context: {
      provider: "espn",
      sport: "nba",
      updated_ts: nowTs,
      game_id: String(g?.id || ""),
      state: String(state || ""),
      period: period ?? null,
      displayClock: st?.displayClock ?? null,
      minutes_left,
      margin,
      decided_rule: "nba_v0",
      decided_pass: decided,
      teams: {
        a: { name: a?.team?.shortDisplayName || a?.team?.displayName || null, score: sa ?? null },
        b: { name: b?.team?.shortDisplayName || b?.team?.displayName || null, score: sb ?? null }
      },
      match: m.match
    }
  };
}
