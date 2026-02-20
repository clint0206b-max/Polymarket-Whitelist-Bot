#!/usr/bin/env node

/**
 * OddsPortal Esports Odds Scraper
 * 
 * Scrapes upcoming esports match odds from OddsPortal and writes to JSONL.
 * 
 * Usage:
 *   node tools/oddsportal_scraper.mjs [--league <name>] [--dry-run]
 * 
 * Output: state/journal/cross_odds_log.jsonl
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUTPUT_PATH = path.join(ROOT, "state", "journal", "cross_odds_log.jsonl");
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_URL = "https://www.oddsportal.com";

// Rate limiting: max 1 request per 3 seconds
const MIN_DELAY_MS = 3000;
let lastRequestTime = 0;

// League definitions
const LEAGUES = {
  lol: [
    { name: "LCK", url: "/esports/league-of-legends/league-of-legends-lck/" },
    { name: "LPL", url: "/esports/league-of-legends/league-of-legends-lpl/" },
    { name: "LEC", url: "/esports/league-of-legends/league-of-legends-lec/" },
    { name: "LCS", url: "/esports/league-of-legends/league-of-legends-lcs/" }
  ],
  cs2: [
    // URLs to be discovered from /esports/counter-strike/
  ],
  dota2: [
    // URLs to be discovered from /esports/dota-2/
  ]
};

// Sleep utility
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Rate-limited fetch
async function rateLimitedFetch(url, options = {}) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - timeSinceLastRequest);
  }
  
  lastRequestTime = Date.now();
  
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    ...options.headers
  };
  
  try {
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      console.error(`HTTP ${response.status} for ${url}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.error(`Fetch error for ${url}:`, error.message);
    return null;
  }
}

// Extract JSON data from HTML
function extractJsonFromHtml(html, pattern) {
  const matches = html.match(pattern);
  if (!matches) return null;
  
  try {
    // Find JSON object/array in the match
    const jsonStr = matches[1];
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("JSON parse error:", error.message);
    return null;
  }
}

// Parse league page for matches
function parseLeagueMatches(html, leagueName, sport) {
  // The match data is embedded in the :comp-data attribute of <next-matches>
  const compDataPattern = /:comp-data="({.*?})"/s;
  const compDataMatch = html.match(compDataPattern);
  
  if (!compDataMatch) {
    // Try alternative pattern from the tournament-component
    const altPattern = /:sport-data="({.*?})"/s;
    const altMatch = html.match(altPattern);
    if (!altMatch) {
      console.error(`Could not find match data in HTML for ${leagueName}`);
      return [];
    }
  }
  
  // Extract the data object - it's HTML-escaped JSON
  const dataStr = (compDataMatch || html.match(/:sport-data="({.*?})"/s))[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  
  let data;
  try {
    data = JSON.parse(dataStr);
  } catch (error) {
    console.error(`Failed to parse match data for ${leagueName}:`, error.message);
    return [];
  }
  
  const rows = data?.d?.rows || [];
  const matches = [];
  
  for (const row of rows) {
    // Skip finished matches
    if (row["status-id"] === 3 || row["event-stage-id"] === 3) {
      continue;
    }
    
    const matchId = row.encodeEventId || "";
    const team1 = row["home-name"] || "";
    const team2 = row["away-name"] || "";
    const scheduledStart = row["date-start-timestamp"] ? new Date(row["date-start-timestamp"] * 1000).toISOString() : null;
    const matchUrl = row.url || "";
    
    if (!matchId || !team1 || !team2) {
      continue;
    }
    
    matches.push({
      match_id: matchId,
      sport,
      league: leagueName,
      team1,
      team2,
      scheduled_start: scheduledStart,
      match_url: matchUrl
    });
  }
  
  return matches;
}

// Fetch odds for a specific match
async function fetchMatchOdds(matchUrl) {
  const fullUrl = BASE_URL + matchUrl;
  const html = await rateLimitedFetch(fullUrl);
  
  if (!html) {
    return null;
  }
  
  // Extract odds from the page
  // OddsPortal embeds odds in various data attributes and script tags
  // For now, we'll try to extract from the odds data endpoint pattern
  
  // Look for odds in the ajax endpoint URL patterns
  const oddsRequestPattern = /"url":"(\/ajax-sport-country-tournament_[^"]+)"/;
  const oddsMatch = html.match(oddsRequestPattern);
  
  if (oddsMatch) {
    const oddsUrl = BASE_URL + oddsMatch[1];
    const oddsHtml = await rateLimitedFetch(oddsUrl);
    
    if (oddsHtml) {
      // Parse odds from the AJAX response
      try {
        const oddsData = JSON.parse(oddsHtml);
        return parseOddsFromAjax(oddsData);
      } catch (error) {
        console.error(`Failed to parse odds AJAX response:`, error.message);
      }
    }
  }
  
  // Fallback: extract from HTML bookmaker links
  return parseOddsFromHtml(html);
}

// Parse odds from AJAX response
function parseOddsFromAjax(data) {
  const bookmakers = [];
  
  // The AJAX response contains odds data in various formats
  // We need to extract bookmaker names and odds pairs
  
  if (data.odds) {
    for (const [bookmakerId, oddsData] of Object.entries(data.odds)) {
      if (Array.isArray(oddsData) && oddsData.length >= 2) {
        bookmakers.push({
          name: bookmakerId,
          odds1: parseFloat(oddsData[0]) || null,
          odds2: parseFloat(oddsData[1]) || null,
          payout: null // Calculate if both odds available
        });
      }
    }
  }
  
  return { bookmakers, exchange: null };
}

// Parse odds from HTML
function parseOddsFromHtml(html) {
  const bookmakers = [];
  
  // Extract bookmaker odds from links like: /bookmaker/{name}/betslip/
  const bookmakerPattern = /<a[^>]+href="\/bookmaker\/([^\/]+)\/betslip\/[^"]*"[^>]*>([\d.]+)<\/a>/g;
  let match;
  
  const bookmakersMap = new Map();
  
  while ((match = bookmakerPattern.exec(html)) !== null) {
    const name = match[1];
    const odds = parseFloat(match[2]);
    
    if (!bookmakersMap.has(name)) {
      bookmakersMap.set(name, []);
    }
    bookmakersMap.get(name).push(odds);
  }
  
  // Convert to bookmakers array
  for (const [name, oddsList] of bookmakersMap) {
    if (oddsList.length >= 2) {
      const odds1 = oddsList[0];
      const odds2 = oddsList[1];
      const payout = odds1 && odds2 ? 1 / ((1/odds1) + (1/odds2)) : null;
      
      bookmakers.push({
        name,
        odds1,
        odds2,
        payout: payout ? Math.round(payout * 1000) / 1000 : null
      });
    }
  }
  
  // Look for Betfair Exchange data
  let exchange = null;
  const betfairPattern = /betfair.*?back.*?([\d.]+).*?lay.*?([\d.]+)/is;
  const betfairMatch = html.match(betfairPattern);
  
  if (betfairMatch) {
    exchange = {
      betfair: {
        back1: parseFloat(betfairMatch[1]) || null,
        lay1: parseFloat(betfairMatch[2]) || null,
        back1_depth: null,
        lay1_depth: null,
        back2: null,
        lay2: null,
        back2_depth: null,
        lay2_depth: null
      }
    };
  }
  
  return { bookmakers, exchange };
}

// Scrape a single league
async function scrapeLeague(leagueName, leagueUrl, sport) {
  console.log(`\n=== Scraping ${sport.toUpperCase()} - ${leagueName} ===`);
  
  const fullUrl = BASE_URL + leagueUrl;
  const html = await rateLimitedFetch(fullUrl);
  
  if (!html) {
    console.error(`Failed to fetch ${leagueName}`);
    return [];
  }
  
  const matches = parseLeagueMatches(html, leagueName, sport);
  console.log(`Found ${matches.length} upcoming matches in ${leagueName}`);
  
  const results = [];
  
  for (const match of matches) {
    console.log(`  Fetching odds for: ${match.team1} vs ${match.team2}`);
    
    const oddsData = await fetchMatchOdds(match.match_url);
    
    if (!oddsData || !oddsData.bookmakers || oddsData.bookmakers.length === 0) {
      console.log(`    No odds found`);
      continue;
    }
    
    const now = new Date().toISOString();
    const timeToStart = match.scheduled_start ? 
      new Date(match.scheduled_start).getTime() - Date.now() : null;
    
    // Calculate best odds
    const odds1List = oddsData.bookmakers.map(b => b.odds1).filter(o => o !== null);
    const odds2List = oddsData.bookmakers.map(b => b.odds2).filter(o => o !== null);
    
    const bestOdds1 = odds1List.length > 0 ? Math.max(...odds1List) : null;
    const bestOdds2 = odds2List.length > 0 ? Math.max(...odds2List) : null;
    
    const bestBook1 = bestOdds1 ? oddsData.bookmakers.find(b => b.odds1 === bestOdds1)?.name : null;
    const bestBook2 = bestOdds2 ? oddsData.bookmakers.find(b => b.odds2 === bestOdds2)?.name : null;
    
    // Calculate average implied probabilities
    const impliedProb1 = odds1List.map(o => 1/o);
    const impliedProb2 = odds2List.map(o => 1/o);
    
    const avgImpliedProb1 = impliedProb1.length > 0 ? 
      Math.round((impliedProb1.reduce((a,b) => a+b, 0) / impliedProb1.length) * 1000) / 1000 : null;
    const avgImpliedProb2 = impliedProb2.length > 0 ? 
      Math.round((impliedProb2.reduce((a,b) => a+b, 0) / impliedProb2.length) * 1000) / 1000 : null;
    
    const snapshot = {
      type: "odds_snapshot",
      ts: now,
      match_id: match.match_id,
      sport: match.sport,
      league: match.league,
      team1: match.team1,
      team2: match.team2,
      scheduled_start: match.scheduled_start,
      time_to_start_ms: timeToStart,
      match_url: match.match_url,
      bookmakers: oddsData.bookmakers,
      exchange: oddsData.exchange,
      best_odds1: bestOdds1,
      best_odds2: bestOdds2,
      best_book1: bestBook1,
      best_book2: bestBook2,
      avg_implied_prob1: avgImpliedProb1,
      avg_implied_prob2: avgImpliedProb2
    };
    
    console.log(`    Found ${oddsData.bookmakers.length} bookmakers | Best: ${bestOdds1} / ${bestOdds2}`);
    results.push(snapshot);
  }
  
  return results;
}

// Main scraper
async function scrapeAllEsports(options = {}) {
  const { leagueFilter = null, dryRun = false } = options;
  
  let allSnapshots = [];
  
  // Scrape LoL leagues
  for (const league of LEAGUES.lol) {
    if (leagueFilter && league.name.toLowerCase() !== leagueFilter.toLowerCase()) {
      continue;
    }
    
    const snapshots = await scrapeLeague(league.name, league.url, "lol");
    allSnapshots = allSnapshots.concat(snapshots);
  }
  
  // TODO: Discover and scrape CS2 leagues
  // TODO: Discover and scrape Dota2 leagues
  
  if (dryRun) {
    console.log(`\n=== DRY RUN: Would write ${allSnapshots.length} snapshots ===`);
    for (const snap of allSnapshots) {
      console.log(JSON.stringify(snap, null, 2));
    }
    return;
  }
  
  // Write to JSONL
  if (allSnapshots.length > 0) {
    const dir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const lines = allSnapshots.map(snap => JSON.stringify(snap)).join('\n') + '\n';
    fs.appendFileSync(OUTPUT_PATH, lines);
    console.log(`\n✓ Wrote ${allSnapshots.length} snapshots to ${OUTPUT_PATH}`);
  } else {
    console.log(`\n! No snapshots to write`);
  }
}

// CLI
const args = process.argv.slice(2);
const options = {
  leagueFilter: null,
  dryRun: false
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--league' && i + 1 < args.length) {
    options.leagueFilter = args[i + 1];
    i++;
  } else if (args[i] === '--dry-run') {
    options.dryRun = true;
  }
}

scrapeAllEsports(options)
  .then(() => {
    console.log('\nDone!');
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
