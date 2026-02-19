// CBB context feed (D2 v0) — ESPN scoreboard
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

// --- Team name normalization (deterministic; no fuzzy) ---
// Goal: map both Polymarket titles and ESPN scoreboard teams to the same "school token".
// Example: "Penn State Nittany Lions" -> "penn state"; "Saint Joseph's Hawks" -> "saint josephs".
const TEAM_ALIAS = {
  // common abbreviations
  "st": "saint",
  "st.": "saint",
  "mt": "mount",
  "mt.": "mount",
  "n.c": "nc",
  "n.c.": "nc"
};

// Minimal mascot/descriptor tails to strip (can grow based on no-match examples)
// Mascot/nickname suffixes to strip from team names for matching.
// Multi-word mascots MUST come before their single-word components
// (e.g. "golden lions" before "lions", "blue raiders" before "raiders").
// Add new mascots as they appear in no-match debug logs.
const MASCOT_TAILS = [
  // multi-word (must be first — longest match wins)
  "delta devils",
  "blue raiders",
  "blue devils",
  "blue hose",
  "nittany lions",
  "golden lions",
  "golden eagles",
  "golden bears",
  "golden flashes",
  "golden griffins",
  "golden hurricanes",
  "golden gophers",
  "fighting irish",
  "fighting illini",
  "crimson tide",
  "red raiders",
  "red storm",
  "red foxes",
  "ragin cajuns",
  "sun devils",
  "horned frogs",
  "yellow jackets",
  "scarlet knights",
  "tar heels",
  "mean green",
  "running rebels",
  "flying dutchmen",
  "beach",
  // single-word
  "aggies",
  "anteaters",
  "aztecs",
  "banana slugs",
  "badgers",
  "bears",
  "beavers",
  "bengals",
  "billikens",
  "bison",
  "blazers",
  "bobcats",
  "boilermakers",
  "bonnies",
  "braves",
  "broncos",
  "bruins",
  "buckeyes",
  "buffaloes",
  "bulldogs",
  "cardinals",
  "catamounts",
  "cavaliers",
  "chanticleers",
  "chippewas",
  "colonels",
  "commodores",
  "cornhuskers",
  "cougars",
  "cowboys",
  "crimson",
  "crusaders",
  "cyclones",
  "daemons",
  "deacons",
  "demons",
  "devils",
  "dolphins",
  "dons",
  "dragons",
  "dukes",
  "eagles",
  "explorers",
  "falcons",
  "flames",
  "flyers",
  "friars",
  "gators",
  "gaels",
  "gamecocks",
  "greyhounds",
  "grizzlies",
  "hawks",
  "highlanders",
  "hilltoppers",
  "hoosiers",
  "hornets",
  "hoyas",
  "huskies",
  "hurricanes",
  "islanders",
  "jayhawks",
  "jaguars",
  "jaspers",
  "knights",
  "lancers",
  "leopards",
  "lions",
  "lobos",
  "longhorns",
  "lumberjacks",
  "mavericks",
  "midshipmen",
  "miners",
  "minutemen",
  "monarchs",
  "mountaineers",
  "musketeers",
  "mustangs",
  "orange",
  "ospreys",
  "owls",
  "paladins",
  "panthers",
  "patriots",
  "peacocks",
  "penguins",
  "phoenix",
  "pilots",
  "pioneers",
  "pirates",
  "privateers",
  "purple aces",
  "quakers",
  "racers",
  "raiders",
  "rams",
  "rattlers",
  "razorbacks",
  "redhawks",
  "retrievers",
  "roadrunners",
  "rockets",
  "runnin utes",
  "seahawks",
  "seawolves",
  "seminoles",
  "shockers",
  "skyhawks",
  "sooners",
  "spartans",
  "spiders",
  "stags",
  "terrapins",
  "terriers",
  "texans",
  "tigers",
  "titans",
  "toreros",
  "trojans",
  "vandals",
  "vaqueros",
  "vikings",
  "volunteers",
  "warriors",
  "waves",
  "wildcats",
  "wolfpack",
  "wolverines",
  "warhawks",
  "zags",
  "zips",
];

const STOPWORDS = new Set([
  "university",
  "college"
]);

function applyAliases(tokens) {
  return tokens.map(t => TEAM_ALIAS[t] || t);
}

function stripMascotTail(s) {
  const t = norm(s);
  if (!t) return "";
  for (const tail of MASCOT_TAILS) {
    const tt = norm(tail);
    if (!tt) continue;
    if (t === tt) return t;
    if (t.endsWith(" " + tt)) return t.slice(0, -(tt.length + 1)).trim();
  }
  return t;
}

function schoolToken(name) {
  // 1) normalize punctuation
  let t = norm(name);
  if (!t) return "";

  // 2) remove mascots/descriptor tails deterministically
  t = stripMascotTail(t);

  // 3) token-level cleanup
  let parts = t.split(" ").filter(Boolean);
  parts = applyAliases(parts);
  parts = parts.filter(x => !STOPWORDS.has(x));

  // 4) join special-case for saint joseph's -> saint josephs (ESPN often uses "Saint Joseph's")
  let out = parts.join(" ").trim();
  out = out.replace(/\bsaint joseph s\b/g, "saint josephs");
  out = out.replace(/\bsaint mary s\b/g, "saint marys");
  out = out.replace(/\bsaint john s\b/g, "saint johns");

  return out;
}

function schoolKey(a, b) {
  const aa = schoolToken(a);
  const bb = schoolToken(b);
  if (!aa || !bb) return null;
  return [aa, bb].sort().join("|");
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

function teamKey(a, b) {
  const aa = norm(a);
  const bb = norm(b);
  if (!aa || !bb) return null;
  return [aa, bb].sort().join("|");
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

  // legacy key (raw normalized)
  const legacyKey = teamKey(best.left, best.right);
  // new deterministic school key
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

  // Legacy: prefer shortDisplayName if present
  const an = a?.shortDisplayName || a?.displayName || a?.location || a?.name;
  const bn = b?.shortDisplayName || b?.displayName || b?.location || b?.name;

  // New: prefer LOCATION for school token (usually just the school)
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

  // Pass 0: deterministic teamsKey (school tokens)
  if (parsedTeams.teamsKey) {
    const hits = [];
    for (const g of games) {
      const comp = g?.competitions?.[0]?.competitors;
      if (!Array.isArray(comp) || comp.length !== 2) continue;
      const gk = gameKeyFromCompetitors(comp);
      if (gk.teamsKey && gk.teamsKey === parsedTeams.teamsKey) {
        hits.push({ game: g, key: gk.teamsKey });
      }
    }
    if (hits.length === 1) return { ok: true, game: hits[0].game, match: { kind: "teamsKey_exact", key: parsedTeams.teamsKey } };
    if (hits.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        debug: { matchPath: "teamsKey_exact", teamsKey: parsedTeams.teamsKey, hits: hits.length }
      };
    }
  }

  // Pass 1: legacy exact key (raw normalized title)
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

  // Pass 2: legacy alias containment
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
    // stable sort for debug
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

export async function fetchEspnCbbScoreboard(cfg, nowTs) {
  // Backwards-compatible wrapper: fetch for UTC date derived from nowTs.
  const d = new Date(nowTs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const date = `${yyyy}${mm}${dd}`;
  return fetchEspnCbbScoreboardForDate(cfg, date);
}

export async function fetchEspnCbbScoreboardForDate(cfg, dateKey, { gender = "mens" } = {}) {
  const cfgKey = gender === "womens" ? "cwbb" : "cbb";
  const timeoutMs = Number(cfg?.context?.[cfgKey]?.timeout_ms || cfg?.context?.cbb?.timeout_ms || 2500);
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  const date = String(dateKey || "");
  const espnPath = gender === "womens" ? "womens-college-basketball" : "mens-college-basketball";
  try {
    // groups=50 = all D1 games (without it, ESPN only returns ~2-10 "top" games,
    // missing all mid-major/small conference games that Polymarket actively trades)
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/${espnPath}/scoreboard?dates=${encodeURIComponent(date)}&limit=500&groups=50`;
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

function completenessScore(game) {
  const st = game?.status;
  const comp = game?.competitions?.[0];
  const competitors = comp?.competitors;
  let s = 0;
  if (st?.type?.state) s += 1;
  if (st?.displayClock) s += 2;
  if (st?.period != null) s += 1;
  if (Array.isArray(competitors) && competitors.length === 2) {
    const a = competitors[0];
    const b = competitors[1];
    if (a?.score != null && b?.score != null) s += 2;
  }
  if (comp?.date) s += 1;
  return s;
}

function addDaysUtc(dateKey, deltaDays) {
  const s = String(dateKey);
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + Number(deltaDays));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

export function mergeScoreboardEventsByWindow(baseDateKey, results) {
  // Flatten to games (ESPN calls them "events"). Deduplicate deterministically.
  const all = [];
  for (const r of results) {
    if (r?.ok && Array.isArray(r.events)) {
      for (const e of r.events) all.push(e);
    }
  }

  const gamesTotal = all.length;

  const byKey = new Map();
  for (const g of all) {
    const comp = g?.competitions?.[0];
    const competitors = comp?.competitors;
    const gameId = g?.id != null ? String(g.id) : null;
    let key = null;
    if (gameId) key = `id:${gameId}`;
    else {
      const k = gameKeyFromCompetitors(competitors);
      const dt = comp?.date ? String(comp.date) : "";
      key = (k.key ? `teams:${k.key}` : "teams:unknown") + (dt ? `|dt:${dt}` : "");
    }

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, g);
    } else {
      const a = completenessScore(prev);
      const b = completenessScore(g);
      if (b > a) byKey.set(key, g);
    }
  }

  const merged = Array.from(byKey.values());
  // stable sort for determinism
  merged.sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")));

  return { ok: true, base_date_key: baseDateKey, games_total: gamesTotal, games_unique: merged.length, events: merged };
}

export function computeDateWindow3(baseDateKey) {
  const base = String(baseDateKey || "");
  return [addDaysUtc(base, -1), base, addDaysUtc(base, +1)].filter(Boolean);
}

export function deriveCbbContextForMarket(market, events, cfg, nowTs) {
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
    // CBB: 2 halves of 20 min. ESPN clock is remaining in current period.
    if (period === 1) minutes_left = 20 + clockMin;
    else if (period === 2) minutes_left = clockMin;
    else minutes_left = clockMin; // OT(s) treated as remaining OT minutes
  }

  const decided = (margin != null && minutes_left != null)
    ? ((margin >= 15 && minutes_left <= 6) || (margin >= 10 && minutes_left <= 3))
    : false;

  return {
    ok: true,
    context: {
      provider: "espn",
      sport: "cbb",
      updated_ts: nowTs,
      game_id: String(g?.id || ""),
      state: String(state || ""),
      period: period ?? null,
      displayClock: st?.displayClock ?? null,
      minutes_left,
      margin,
      decided_rule: "cbb_v0",
      decided_pass: decided,
      teams: {
        a: { name: a?.team?.shortDisplayName || a?.team?.displayName || null, fullName: a?.team?.displayName || a?.team?.shortDisplayName || null, score: sa ?? null },
        b: { name: b?.team?.shortDisplayName || b?.team?.displayName || null, fullName: b?.team?.displayName || b?.team?.shortDisplayName || null, score: sb ?? null }
      },
      match: m.match
    }
  };
}
