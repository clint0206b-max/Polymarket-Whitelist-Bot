// Global WebSocket Scanner for Polymarket Watchlist Bot
// Monitors ALL Polymarket markets in real-time via WebSocket
// and DIRECTLY EXECUTES trades when opportunities are detected (bypasses eval loop)

import WebSocket from "ws";
import { execSync } from "node:child_process";
import { upsertMarket } from "../strategy/watchlist_upsert.mjs";
import { getBook } from "../clob/book_http_client.mjs";
import { compute_depth_metrics, is_depth_sufficient } from "../strategy/stage2.mjs";
import { parseAndNormalizeBook } from "../clob/book_parser.mjs";
import { appendJsonl, loadOpenIndex, saveOpenIndex, addOpen, addFailedBuy } from "../core/journal.mjs";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const BATCH_SIZE = 500; // Subscribe in batches of 500 tokens
const DISCOVERY_INTERVAL_DEFAULT = 120_000; // 2 minutes default
const SCHEMA_VERSION = 2;
const BUILD_COMMIT = (() => { try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();

/**
 * Parse league from slug prefix (for per-league config overrides)
 */
function parseLeagueFromSlug(slug) {
  const s = String(slug || "").toLowerCase();
  
  // Esports prefixes
  if (/^(lol|cs2|cs|csgo|val|dota|dota2|rl|cod|r6|r6siege|ow|apex|pubg|sc2|halo|smash|sf|tekken|fifa|fc|hok)-/.test(s)) {
    return "esports";
  }
  
  // Soccer leagues
  const soccerPrefixes = [
    "epl-", "lal-", "sea-", "fl1-", "bun-", "ucl-", "uel-",
    "mex-", "arg-", "ere-", "por-", "bra-", "tur-", "sco-",
    "bel-", "aut-", "elc-", "rus-", "jpn-", "kor-", "aus-"
  ];
  if (soccerPrefixes.some(p => s.startsWith(p))) {
    return "soccer";
  }
  
  // NBA
  if (s.startsWith("nba-")) return "nba";
  
  // CBB (NCAA basketball)
  if (s.startsWith("ncaa-basketball-") || s.startsWith("cbb-")) return "cbb";
  
  // CWBB (Women's college basketball)
  if (s.startsWith("cwbb-") || s.startsWith("ncaa-womens-basketball-")) return "cwbb";
  
  // MLB
  if (s.startsWith("mlb-")) return "mlb";
  
  // NFL
  if (s.startsWith("nfl-")) return "nfl";
  
  // NHL
  if (s.startsWith("nhl-")) return "nhl";
  
  // MMA
  if (s.startsWith("mma-") || s.startsWith("ufc-")) return "mma";
  
  // Tennis
  if (s.startsWith("tennis-") || s.startsWith("atp-") || s.startsWith("wta-")) return "tennis";
  
  // Cricket
  if (s.startsWith("cricket-")) return "cricket";
  
  // Fallback: use first slug part or "other"
  const parts = s.split("-");
  return parts[0] || "other";
}

/**
 * Global WebSocket Scanner - Direct Execution Path
 */
export class GlobalWSScanner {
  constructor(state, cfg, tradeBridge = null) {
    this.state = state;
    this.cfg = cfg;
    this.tradeBridge = tradeBridge;
    this.enabled = cfg?.global_scanner?.enabled ?? false;
    
    if (!this.enabled) {
      console.log("[GLOBAL_SCANNER] Disabled in config");
      return;
    }
    
    this.minPriceFilter = Number(cfg?.global_scanner?.min_price_filter ?? 0.90);
    this.discoveryIntervalMs = Number(cfg?.global_scanner?.discovery_interval_seconds ?? 120) * 1000;
    
    // Track in-flight executions to avoid double-buying
    this._executingSlug = new Set();
    
    // Global universe: token -> market metadata
    this.tokenToMarket = new Map();
    
    // WebSocket state
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 60000;
    this.pingTimer = null;
    this.subscriptions = new Set();
    this.initialSubscribeSent = false;
    this._closing = false;
    
    // Price cache: tokenId -> { bid, ask, spread, lastUpdate }
    this.priceCache = new Map();
    
    // Discovery state
    this.discoveryTimer = null;
    this.lastDiscoveryTs = 0;
    this.discoveryRunning = false;
    
    // Metrics
    this.metrics = {
      discovery_runs: 0,
      discovery_errors: 0,
      total_markets_fetched: 0,
      markets_pre_filtered: 0,
      tokens_subscribed: 0,
      ws_connects: 0,
      ws_disconnects: 0,
      ws_messages: 0,
      price_updates: 0,
      markets_injected: 0,
      injection_errors: 0,
      depth_fetch_errors: 0,
      depth_insufficient: 0,
      trades_executed: 0,
      trades_failed: 0,
      trades_unknown: 0,
      trades_exception: 0,
    };
    
    console.log(`[GLOBAL_SCANNER] Initialized | min_price=${this.minPriceFilter} discovery_interval=${this.discoveryIntervalMs/1000}s direct_execution=true`);
  }
  
  /**
   * Start the scanner
   */
  async start() {
    if (!this.enabled) return;
    
    console.log("[GLOBAL_SCANNER] Starting...");
    
    // Run initial discovery
    await this.runDiscovery();
    
    // Schedule periodic discovery
    this.discoveryTimer = setInterval(() => {
      this.runDiscovery().catch(err => {
        console.error(`[GLOBAL_SCANNER] Discovery error: ${err?.message || err}`);
        this.metrics.discovery_errors++;
      });
    }, this.discoveryIntervalMs);
    
    // Connect WebSocket
    this.connect();
    
    console.log("[GLOBAL_SCANNER] Started successfully");
  }
  
  /**
   * Phase 1: Discovery - Fetch ALL active events from Gamma API
   */
  async runDiscovery() {
    if (this.discoveryRunning) {
      console.log("[GLOBAL_SCANNER] Discovery already running, skipping");
      return;
    }
    
    this.discoveryRunning = true;
    this.metrics.discovery_runs++;
    const started = Date.now();
    
    try {
      console.log("[GLOBAL_SCANNER] Starting discovery...");
      
      const allMarkets = [];
      let offset = 0;
      const limit = 500;
      let hasMore = true;
      
      // Paginate through ALL events
      while (hasMore) {
        const url = `${GAMMA_API_BASE}/events?active=true&closed=false&limit=${limit}&offset=${offset}`;
        
        try {
          const response = await fetch(url, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(10000) // 10s timeout per page
          });
          
          if (!response.ok) {
            console.error(`[GLOBAL_SCANNER] Gamma fetch failed: ${response.status} ${response.statusText}`);
            break;
          }
          
          const events = await response.json();
          
          if (!Array.isArray(events) || events.length === 0) {
            hasMore = false;
            break;
          }
          
          // Extract markets from events
          for (const event of events) {
            const markets = Array.isArray(event?.markets) ? event.markets : [];
            for (const market of markets) {
              if (market?.active && !market?.closed) {
                const endDateRaw = market.endDate || market.endDateIso || event.endDate;
                const vol24h = Number(market.volume24hr ?? market.volume24h ?? market.volumeNum ?? 0);
                
                // Filter: category blacklist
                const catBlacklist = this.cfg?.global_scanner?.category_blacklist || ["crypto", "soccer", "temperature"];
                const slugLower = String(market.slug || "").toLowerCase();
                const titleLower = String(market.question || "").toLowerCase();
                const isCrypto = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|crypto|up-or-down.*et)\b/.test(slugLower)
                  || /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp)\b/.test(titleLower);
                if (isCrypto && catBlacklist.includes("crypto")) {
                  continue;
                }
                const isSoccer = /\b(soccer|epl-|laliga|bundesliga|ligue1|seriea|tur-|itsb-|es2-|mls-|ucl-|uel-)\b/.test(slugLower);
                if (isSoccer && catBlacklist.includes("soccer")) {
                  continue;
                }
                const isTemperature = /\b(temperature|temperatures|temp-in-|fahrenheit|celsius|weather)\b/.test(slugLower)
                  || /\b(temperature|temperatures|weather)\b/.test(titleLower);
                if (isTemperature && catBlacklist.includes("temperature")) {
                  continue;
                }

                // Filter: endDate within max_end_date_hours from now (no endDate or past = reject)
                const maxHours = Number(this.cfg?.global_scanner?.max_end_date_hours ?? 6);
                if (!endDateRaw) {
                  continue; // No end date = skip
                }
                const endTs = new Date(endDateRaw).getTime();
                if (!Number.isFinite(endTs) || endTs <= Date.now() || endTs > Date.now() + maxHours * 3600000) {
                  continue; // Past, too far in the future, or unparseable
                }
                
                // Filter: volume24h >= min_volume_24h
                // Exception: if endDate is < 4h from now, skip volume check (short-term markets like crypto 5m candles)
                const minVol = Number(this.cfg?.global_scanner?.min_volume_24h ?? 100);
                const isShortTerm = Number.isFinite(endTs) && (endTs - Date.now()) < 1 * 3600000;
                if (vol24h < minVol && !isShortTerm) {
                  continue; // Not enough volume (and not short-term)
                }
                
                allMarkets.push({
                  conditionId: String(market.conditionId || ""),
                  slug: String(market.slug || ""),
                  question: String(market.question || ""),
                  clobTokenIds: market.clobTokenIds,
                  outcomePrices: market.outcomePrices,
                  outcomes: market.outcomes,
                  endDate: endDateRaw,
                  event_slug: String(event.slug || ""),
                  event_title: String(event.title || event.name || ""),
                  vol24h
                });
              }
            }
          }
          
          offset += events.length;
          
          // Stop if we got fewer results than limit (last page)
          if (events.length < limit) {
            hasMore = false;
          }
          
          // Rate limit: small delay between pages
          if (hasMore) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          
        } catch (err) {
          console.error(`[GLOBAL_SCANNER] Fetch error at offset ${offset}: ${err?.message || err}`);
          this.metrics.discovery_errors++;
          break;
        }
      }
      
      this.metrics.total_markets_fetched = allMarkets.length;
      console.log(`[GLOBAL_SCANNER] Fetched ${allMarkets.length} markets`);
      
      // Pre-filter: only keep tokens where ANY outcome price >= min_price_filter
      const filteredTokens = new Map(); // tokenId -> market metadata
      
      for (const market of allMarkets) {
        if (!market.conditionId) continue;
        
        // Parse clobTokenIds and outcomePrices
        let tokenIds = market.clobTokenIds;
        if (typeof tokenIds === "string") {
          try {
            tokenIds = JSON.parse(tokenIds);
          } catch {
            continue;
          }
        }
        
        let prices = market.outcomePrices;
        if (typeof prices === "string") {
          try {
            prices = JSON.parse(prices);
          } catch {
            continue;
          }
        }
        
        if (!Array.isArray(tokenIds) || !Array.isArray(prices)) continue;
        if (tokenIds.length !== 2 || prices.length !== 2) continue;
        
        // Check if ANY price >= min_price_filter
        const price0 = Number(prices[0]);
        const price1 = Number(prices[1]);
        
        if (!Number.isFinite(price0) || !Number.isFinite(price1)) continue;
        
        if (price0 >= this.minPriceFilter || price1 >= this.minPriceFilter) {
          // Determine league from slug
          const league = parseLeagueFromSlug(market.slug);
          
          // Parse outcomes
          let outcomes = market.outcomes;
          if (typeof outcomes === "string") {
            try {
              outcomes = JSON.parse(outcomes);
            } catch {
              outcomes = null;
            }
          }
          
          // Store metadata for both tokens
          const metadata = {
            conditionId: market.conditionId,
            slug: market.slug,
            question: market.question,
            league,
            clobTokenIds: tokenIds.map(String),
            prices: [price0, price1],
            outcomes: Array.isArray(outcomes) ? outcomes.map(String) : null,
            endDateIso: market.endDate,
            event_slug: market.event_slug,
            event_title: market.event_title
          };
          
          filteredTokens.set(String(tokenIds[0]), { ...metadata, tokenIndex: 0 });
          filteredTokens.set(String(tokenIds[1]), { ...metadata, tokenIndex: 1 });
        }
      }
      
      this.metrics.markets_pre_filtered = filteredTokens.size / 2;
      console.log(`[GLOBAL_SCANNER] Pre-filtered ${filteredTokens.size / 2} markets (${filteredTokens.size} tokens) with price >= ${this.minPriceFilter}`);
      
      // Update global universe
      this.tokenToMarket = filteredTokens;
      
      // Subscribe to WebSocket
      const tokenIds = Array.from(filteredTokens.keys());
      if (tokenIds.length > 0) {
        this.subscribeTokens(tokenIds);
      }
      
      this.lastDiscoveryTs = Date.now();
      const duration = Date.now() - started;
      console.log(`[GLOBAL_SCANNER] Discovery completed in ${duration}ms`);
      
    } catch (err) {
      console.error(`[GLOBAL_SCANNER] Discovery failed: ${err?.message || err}`);
      this.metrics.discovery_errors++;
    } finally {
      this.discoveryRunning = false;
    }
  }
  
  /**
   * Phase 2: WebSocket Connection
   */
  connect() {
    if (this.isConnecting || this.isConnected) {
      return;
    }
    
    this.isConnecting = true;
    console.log(`[GLOBAL_SCANNER] Connecting to ${WS_URL}...`);
    
    try {
      this.ws = new WebSocket(WS_URL);
      
      this.ws.on("open", () => {
        this.isConnecting = false;
        this.isConnected = true;
        this.reconnectDelay = 1000;
        this.initialSubscribeSent = false;
        this.metrics.ws_connects++;
        console.log("[GLOBAL_SCANNER] WebSocket connected");
        
        // Send initial subscription if we have tokens
        if (this.subscriptions.size > 0) {
          this.sendInitialSubscribe(Array.from(this.subscriptions));
        }
        
        // Start ping heartbeat
        this.startPingHeartbeat();
      });
      
      this.ws.on("message", (data) => {
        this.metrics.ws_messages++;
        
        // Handle text-based ping/pong
        const text = data.toString();
        if (text === "ping") {
          try {
            this.ws.send("pong");
          } catch (e) {
            console.error(`[GLOBAL_SCANNER] Failed to send pong: ${e?.message}`);
          }
          return;
        }
        
        try {
          const msg = JSON.parse(text);
          this.handleMessage(msg);
        } catch (e) {
          // Suppress known non-JSON responses (e.g. "INVALID OPERATION")
          if (!text.startsWith("INVALID")) {
            console.error(`[GLOBAL_SCANNER] Failed to parse message: ${e?.message}`);
          }
        }
      });
      
      this.ws.on("ping", () => {
        try {
          this.ws.pong();
        } catch (e) {
          console.error(`[GLOBAL_SCANNER] Failed to send pong: ${e?.message}`);
        }
      });
      
      this.ws.on("close", (code, reason) => {
        this.isConnected = false;
        this.stopPingHeartbeat();
        
        if (this._closing) {
          console.log("[GLOBAL_SCANNER] WebSocket closed (shutdown)");
          return;
        }
        
        this.metrics.ws_disconnects++;
        console.log(`[GLOBAL_SCANNER] WebSocket disconnected (code=${code}, reason=${reason || "none"})`);
        this.scheduleReconnect();
      });
      
      this.ws.on("error", (err) => {
        console.error(`[GLOBAL_SCANNER] WebSocket error: ${err?.message || err}`);
      });
      
    } catch (e) {
      this.isConnecting = false;
      console.error(`[GLOBAL_SCANNER] Connect failed: ${e?.message || e}`);
      this.scheduleReconnect();
    }
  }
  
  scheduleReconnect() {
    if (this._closing) return;
    
    console.log(`[GLOBAL_SCANNER] Reconnecting in ${this.reconnectDelay}ms...`);
    
    setTimeout(() => {
      if (this._closing) return;
      this.connect();
    }, this.reconnectDelay);
    
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
  
  startPingHeartbeat() {
    this.stopPingHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch (e) {
          console.error(`[GLOBAL_SCANNER] PING failed: ${e?.message}`);
        }
      }
    }, 30000); // 30s
  }
  
  stopPingHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
  
  /**
   * Subscribe tokens to WebSocket
   */
  subscribeTokens(tokenIds) {
    const newIds = tokenIds.filter(id => !this.subscriptions.has(id));
    if (newIds.length === 0) return;
    
    // Add to subscription set
    for (const id of newIds) {
      this.subscriptions.add(id);
    }
    
    console.log(`[GLOBAL_SCANNER] Queued ${newIds.length} new tokens for subscription (total: ${this.subscriptions.size})`);
    
    if (this.isConnected && this.initialSubscribeSent) {
      // Already connected - use dynamic subscribe in batches
      this.sendDynamicSubscribe(newIds);
    } else if (!this.isConnecting && !this.isConnected) {
      // Not connected - trigger connection
      this.connect();
    }
    // else: connecting or initial subscribe pending - tokens will be sent on connect
  }
  
  sendInitialSubscribe(assetIds) {
    if (assetIds.length === 0) return;
    
    // Batch subscribe in chunks of BATCH_SIZE
    for (let i = 0; i < assetIds.length; i += BATCH_SIZE) {
      const batch = assetIds.slice(i, i + BATCH_SIZE);
      const msg = { assets_ids: batch, type: "market", custom_feature_enabled: true };
      
      try {
        this.ws.send(JSON.stringify(msg));
        this.metrics.tokens_subscribed += batch.length;
        console.log(`[GLOBAL_SCANNER] Initial subscribe batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} tokens`);
      } catch (e) {
        console.error(`[GLOBAL_SCANNER] Initial subscribe failed: ${e?.message}`);
      }
    }
    
    this.initialSubscribeSent = true;
    console.log(`[GLOBAL_SCANNER] Initial subscription complete (${assetIds.length} tokens)`);
  }
  
  sendDynamicSubscribe(assetIds) {
    if (assetIds.length === 0) return;
    
    // Batch subscribe in chunks of BATCH_SIZE
    for (let i = 0; i < assetIds.length; i += BATCH_SIZE) {
      const batch = assetIds.slice(i, i + BATCH_SIZE);
      const msg = { assets_ids: batch, operation: "subscribe", custom_feature_enabled: true };
      
      try {
        this.ws.send(JSON.stringify(msg));
        this.metrics.tokens_subscribed += batch.length;
        console.log(`[GLOBAL_SCANNER] Dynamic subscribe batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} tokens`);
      } catch (e) {
        console.error(`[GLOBAL_SCANNER] Dynamic subscribe failed: ${e?.message}`);
      }
    }
  }
  
  /**
   * Phase 3: Handle WebSocket messages
   */
  handleMessage(msg) {
    const now = Date.now();
    const eventType = msg.event_type;
    
    // Handle price_change events
    if (eventType === "price_change" && Array.isArray(msg.price_changes)) {
      for (const pc of msg.price_changes) {
        if (!pc.asset_id) continue;
        const tokenId = String(pc.asset_id);
        const bestBid = pc.best_bid != null ? Number(pc.best_bid) : null;
        const bestAsk = pc.best_ask != null ? Number(pc.best_ask) : null;
        
        if (bestBid != null && bestAsk != null) {
          this.updatePrice(tokenId, bestBid, bestAsk, now);
        }
      }
    }
    // Handle best_bid_ask events (custom feature)
    else if (eventType === "best_bid_ask") {
      const changes = msg.changes || msg.price_changes;
      const items = Array.isArray(changes) && changes.length > 0 ? changes : [msg];
      
      for (const item of items) {
        if (!item.asset_id) continue;
        const tokenId = String(item.asset_id);
        const bestBid = item.best_bid != null ? Number(item.best_bid) : null;
        const bestAsk = item.best_ask != null ? Number(item.best_ask) : null;
        
        if (bestBid != null && bestAsk != null) {
          this.updatePrice(tokenId, bestBid, bestAsk, now);
        }
      }
    }
    // Handle book snapshots (array format)
    else if (Array.isArray(msg)) {
      for (const entry of msg) {
        if (!entry.asset_id) continue;
        const tokenId = String(entry.asset_id);
        const bestBid = entry.best_bid != null ? Number(entry.best_bid) : null;
        const bestAsk = entry.best_ask != null ? Number(entry.best_ask) : null;
        
        if (bestBid != null && bestAsk != null) {
          this.updatePrice(tokenId, bestBid, bestAsk, now);
        }
      }
    }
  }
  
  /**
   * Update price cache and check for signal injection
   */
  updatePrice(tokenId, bestBid, bestAsk, timestamp) {
    this.metrics.price_updates++;
    
    // Update cache
    this.priceCache.set(tokenId, {
      bid: bestBid,
      ask: bestAsk,
      spread: bestAsk - bestBid,
      lastUpdate: timestamp
    });
    
    // Get market metadata
    const market = this.tokenToMarket.get(tokenId);
    if (!market) return;
    
    // Phase 4: Signal Detection + Direct Execution
    this.checkAndInject(market, tokenId, bestBid, bestAsk).catch(err => {
      console.error(`[GLOBAL_SCANNER] checkAndInject error: ${err?.message || err}`);
    });
  }
  
  /**
   * Phase 4: Signal Detection + Direct Execution
   * When a qualifying market is detected, this bypasses the eval loop and executes immediately
   */
  async checkAndInject(market, triggeredTokenId, bestBid, bestAsk) {
    // Prevent concurrent executions for same slug
    if (this._executingSlug.has(market.slug)) {
      return;
    }
    
    // Get entry range from config (with per-league overrides)
    const league = market.league;
    const minProb = Number(this.cfg?.filters?.[`min_entry_price_${league}`] ?? this.cfg?.filters?.min_prob ?? 0.98);
    const maxEntryPrice = Number(this.cfg?.filters?.[`max_entry_price_${league}`] ?? this.cfg?.filters?.max_entry_price ?? 0.99);
    const maxSpread = Number(this.cfg?.filters?.[`max_spread_${league}`] ?? this.cfg?.filters?.max_spread ?? 0.10);
    
    // Check entry criteria (price + spread)
    if (bestAsk < minProb || bestAsk > maxEntryPrice) {
      return; // Not in entry range
    }
    
    const spread = bestAsk - bestBid;
    if (spread > maxSpread) {
      return; // Spread too wide
    }
    
    // Check if market is already in watchlist or has open position
    const existingMarket = this.state.watchlist?.[market.conditionId];
    if (existingMarket) {
      return; // Already being tracked
    }
    
    // Check if we already have an open position for this slug
    try {
      const idx = loadOpenIndex();
      const openPositions = Object.values(idx.open || {});
      if (openPositions.some(p => p.slug === market.slug)) {
        return; // Already have position open
      }
    } catch (e) {
      // Non-fatal: proceed if we can't load index
    }
    
    // Mark as executing to prevent duplicates
    this._executingSlug.add(market.slug);
    
    try {
      // Determine which token is the "yes" token
      const yesTokenId = triggeredTokenId;
      const yesTokenIndex = market.tokenIndex;
      const noTokenIndex = yesTokenIndex === 0 ? 1 : 0;
      const noTokenId = market.clobTokenIds[noTokenIndex];
      
      // DEPTH CHECK: Fetch /book to verify liquidity
      console.log(`[GLOBAL_SCANNER] Checking depth for ${market.slug} (ask=${bestAsk.toFixed(3)} spread=${spread.toFixed(3)})`);
      
      const bookResult = await getBook(yesTokenId, this.cfg);
      if (!bookResult.ok) {
        console.log(`[GLOBAL_SCANNER] ❌ DEPTH_FETCH_FAILED | ${market.slug} | ${bookResult.error}`);
        this.metrics.depth_fetch_errors = (this.metrics.depth_fetch_errors || 0) + 1;
        return;
      }
      
      // Parse + sort book (asks ascending, bids descending) before depth check
      const parsed = parseAndNormalizeBook(bookResult.rawBook, this.cfg);
      if (!parsed?.ok || !parsed.book) {
        console.log(`[GLOBAL_SCANNER] ❌ BOOK_PARSE_FAILED | ${market.slug}`);
        return;
      }

      // Override max_entry_price for scanner (we trade 0.98-0.99, default 0.97 kills everything)
      const scannerCfg = {
        ...this.cfg,
        filters: { ...this.cfg?.filters, max_entry_price: Number(this.cfg?.global_scanner?.max_entry_price ?? 0.995) }
      };
      const depthMetrics = compute_depth_metrics(parsed.book, scannerCfg);
      const depthCheck = is_depth_sufficient(depthMetrics, scannerCfg);
      
      if (!depthCheck.pass) {
        console.log(`[GLOBAL_SCANNER] ❌ DEPTH_INSUFFICIENT | ${market.slug} | ${depthCheck.reason} | entry=${depthMetrics.entry_depth_usd_ask.toFixed(0)} exit=${depthMetrics.exit_depth_usd_bid.toFixed(0)}`);
        this.metrics.depth_insufficient = (this.metrics.depth_insufficient || 0) + 1;
        return;
      }
      
      // Build market object for injection (status will be set to "signaled" after successful buy)
      const marketToInject = {
        conditionId: market.conditionId,
        slug: market.slug,
        title: market.event_title || market.question,
        question: market.question,
        league: league,
        event_slug: market.event_slug,
        endDateIso: market.endDateIso,
        outcomes: market.outcomes,
        tokens: {
          clobTokenIds: market.clobTokenIds,
          yes_token_id: yesTokenId,
          no_token_id: noTokenId
        }
      };
      
      // Inject into watchlist first (status: "watching" initially)
      upsertMarket(this.state, marketToInject, Date.now());
      
      // DIRECT EXECUTION: Call tradeBridge to execute trade immediately
      if (!this.tradeBridge) {
        console.log(`[GLOBAL_SCANNER] ❌ NO_TRADE_BRIDGE | ${market.slug} | cannot execute`);
        return;
      }
      
      const now = Date.now();
      const signalId = `${now}|${market.slug}`;
      const entryPrice = bestAsk;
      
      console.log(`[GLOBAL_SCANNER] 🎯 EXECUTING BUY | ${league.toUpperCase()} | ${market.slug} | ask=${bestAsk.toFixed(3)} spread=${spread.toFixed(3)} depth=${depthMetrics.entry_depth_usd_ask.toFixed(0)}`);
      
      try {
        const buyResult = await this.tradeBridge.handleSignalOpen({
          signal_id: signalId,
          slug: market.slug,
          entry_price: entryPrice,
          yes_token: yesTokenId,
          league: league,
        });
        
        if (buyResult && buyResult.ok) {
          // Buy confirmed → write signal_open to journal + open_index
          const idx = loadOpenIndex();
          
          // Determine entry outcome name
          let entryOutcome = null;
          if (market.outcomes && market.outcomes.length === 2) {
            entryOutcome = String(market.outcomes[yesTokenIndex]);
          }
          
          const paperNotional = (this.tradeBridge.mode !== "paper")
            ? (this.tradeBridge.balanceCache?.calculateTradeSize?.(this.cfg?.sizing, this.tradeBridge._getOpenTrades?.(), this.tradeBridge._currentPricesBySlug || new Map())?.budgetUsd || Number(this.cfg?.paper?.notional_usd ?? 10))
            : Number(this.cfg?.paper?.notional_usd ?? 10);
          
          const marketTitle = market.event_title || market.question;
          
          // Build signal_open row (same format as run.mjs)
          const signalOpenRow = {
            type: "signal_open",
            runner_id: process.env.SHADOW_ID || "prod",
            schema_version: SCHEMA_VERSION,
            build_commit: BUILD_COMMIT,
            signal_id: signalId,
            ts_open: now,
            slug: market.slug,
            title: marketTitle,
            conditionId: market.conditionId,
            league: league,
            market_kind: null,
            signal_type: "global_scanner",
            near_by: "ws_price_update",
            entry_price: entryPrice,
            spread: spread,
            entry_depth_usd_ask: depthMetrics.entry_depth_usd_ask,
            exit_depth_usd_bid: depthMetrics.exit_depth_usd_bid,
            paper_notional_usd: paperNotional,
            paper_shares: (entryPrice > 0) ? (paperNotional / entryPrice) : null,
            entry_outcome_name: entryOutcome,
            would_gate_apply: false,
            would_gate_block: false,
            would_gate_reason: "not_applicable",
            tp_bid_target: null,
            tp_min_profit_per_share: null,
            tp_fees_roundtrip: null,
            tp_max_entry_dynamic: null,
            tp_math_margin: null,
            tp_math_allowed: false,
            tp_math_reason: "no_data",
            ctx: null,
            esports: null,
            status: "open"
          };
          
          // Build open_index row
          const openIndexRow = {
            slug: market.slug,
            title: marketTitle,
            ts_open: now,
            league: league,
            market_kind: null,
            entry_price: entryPrice,
            paper_notional_usd: paperNotional,
            entry_outcome_name: entryOutcome,
            would_gate_apply: false,
            would_gate_block: false,
            would_gate_reason: "not_applicable",
            tp_math_allowed: false,
            tp_math_reason: "no_data",
            context_entry: null
          };
          
          // Write to journal
          appendJsonl("state/journal/signals.jsonl", signalOpenRow);
          addOpen(idx, signalId, openIndexRow);
          saveOpenIndex(idx);
          
          // Update watchlist market to "signaled" status
          const wlMarket = this.state.watchlist[market.conditionId];
          if (wlMarket) {
            wlMarket.status = "signaled";
          }
          
          this.metrics.markets_injected++;
          this.metrics.trades_executed = (this.metrics.trades_executed || 0) + 1;
          
          console.log(`[GLOBAL_SCANNER] ✅ BUY_SUCCESS | ${league.toUpperCase()} | ${marketTitle || market.slug} | ${entryOutcome || "?"} @ ${entryPrice.toFixed(3)}`);
          
        } else if (buyResult && buyResult.error === "order_status_unknown") {
          // Ambiguous — write signal_open but mark unknown for deferred reconcile
          console.log(`[GLOBAL_SCANNER] ⚠️  BUY_UNKNOWN | ${market.slug} | order_status_unknown → deferred reconcile`);
          this.metrics.trades_unknown = (this.metrics.trades_unknown || 0) + 1;
          
        } else {
          // Buy failed or blocked
          const failReason = buyResult?.error || buyResult?.reason || "unknown";
          console.log(`[GLOBAL_SCANNER] ❌ BUY_FAILED | ${market.slug} | ${failReason}`);
          this.metrics.trades_failed = (this.metrics.trades_failed || 0) + 1;
          
          // Remove from watchlist since we won't trade it
          if (this.state.watchlist[market.conditionId]) {
            delete this.state.watchlist[market.conditionId];
          }
        }
        
      } catch (e) {
        console.error(`[GLOBAL_SCANNER] ❌ BUY_EXCEPTION | ${market.slug} | ${e?.message || e}`);
        this.metrics.trades_exception = (this.metrics.trades_exception || 0) + 1;
        
        // Remove from watchlist
        if (this.state.watchlist[market.conditionId]) {
          delete this.state.watchlist[market.conditionId];
        }
      }
      
    } catch (err) {
      console.error(`[GLOBAL_SCANNER] Execution error for ${market.slug}: ${err?.message || err}`);
      this.metrics.injection_errors++;
    } finally {
      // Release execution lock
      this._executingSlug.delete(market.slug);
    }
  }
  
  /**
   * Get scanner metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      enabled: this.enabled,
      universe_size: this.tokenToMarket.size / 2,
      tokens_tracked: this.tokenToMarket.size,
      price_cache_size: this.priceCache.size,
      is_connected: this.isConnected,
      last_discovery_ts: this.lastDiscoveryTs,
      last_discovery_ago_ms: this.lastDiscoveryTs ? Date.now() - this.lastDiscoveryTs : null
    };
  }
  
  /**
   * Shutdown
   */
  close() {
    console.log("[GLOBAL_SCANNER] Shutting down...");
    
    this._closing = true;
    
    // Stop discovery timer
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    
    // Close WebSocket
    this.stopPingHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.isConnected = false;
    this.isConnecting = false;
    
    console.log("[GLOBAL_SCANNER] Shutdown complete");
  }
}
