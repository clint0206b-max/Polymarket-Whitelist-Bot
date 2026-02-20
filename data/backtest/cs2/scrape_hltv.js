/**
 * HLTV CS2 match scraper - run via browser evaluate.
 * Extracts match URLs from results pages, then scrapes each match for map scores + halftime data.
 * 
 * Usage: 
 *   1. Open HLTV results page in browser
 *   2. Run extractMatchUrls() to get match URLs
 *   3. For each URL, navigate and run extractMatchData()
 */

// Step 1: Extract match URLs from results page  
function extractMatchUrls() {
  const rows = document.querySelectorAll('.result-con a');
  const urls = [];
  for (const a of rows) {
    const href = a.getAttribute('href');
    if (href && href.match(/\/matches\/\d+\//)) {
      urls.push(href);
    }
  }
  return [...new Set(urls)];
}

// Step 2: Extract match data from individual match page
function extractMatchData() {
  const maps = [];
  const mapHolders = document.querySelectorAll('.mapholder');
  for (const mh of mapHolders) {
    const mapName = mh.querySelector('.mapname')?.textContent?.trim();
    const results = mh.querySelectorAll('.results-team-score');
    const scores = [];
    results.forEach(r => {
      const val = parseInt(r.textContent.trim());
      if (!isNaN(val)) scores.push(val);
    });
    const halves = mh.querySelector('.results-center-half-score')?.textContent?.trim();
    if (mapName && scores.length >= 2 && scores[0] !== null && scores[1] !== null) {
      maps.push({ map: mapName, score1: scores[0], score2: scores[1], halves: halves || null });
    }
  }
  
  const team1 = document.querySelector('.team1-gradient .teamName')?.textContent?.trim();
  const team2 = document.querySelector('.team2-gradient .teamName')?.textContent?.trim();
  const event_name = document.querySelector('.event a')?.textContent?.trim();
  const date = document.querySelector('.timeAndEvent .date')?.textContent?.trim();
  const format = document.querySelector('.preformatted-text')?.textContent?.trim();
  
  // Get match URL for ID
  const url = window.location.pathname;
  const matchId = url.match(/\/matches\/(\d+)\//)?.[1];
  
  return { matchId, team1, team2, event: event_name, date, format, maps, url };
}
