// WebSocket client for Polymarket CLOB market channel
// Primary source for real-time orderbook updates (best_bid_ask)

import WebSocket from "ws";

export class CLOBWebSocketClient {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.ws = null;
    this.cache = new Map(); // tokenId → {bestBid, bestAsk, spread, lastUpdate}
    this.subscriptions = new Set(); // Set of tokenIds currently subscribed
    this.reconnectDelay = 1000; // Start with 1s
    this.maxReconnectDelay = 60000; // Max 60s
    this.pingIntervalMs = 30000; // PING every 30s
    this.pingTimer = null;
    this.isConnecting = false;
    this.isConnected = false;
    this.initialSubscribeSent = false; // Track if initial subscribe was sent
    
    this._closing = false; // Intentional shutdown flag
    
    // Metrics
    this.metrics = {
      connects: 0,
      disconnects: 0,
      messages_received: 0,
      messages_unknown: 0,
      best_bid_ask_updates: 0,
      book_snapshots: 0,
      reconnects: 0
    };

    this.url = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
  }

  connect() {
    if (this.isConnecting || this.isConnected) {
      console.log("[WS] Already connecting or connected, skip");
      return;
    }

    this.isConnecting = true;
    console.log(`[WS] Connecting to ${this.url}...`);

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on("open", () => {
        this.isConnecting = false;
        this.isConnected = true;
        this.reconnectDelay = 1000; // Reset backoff
        this.metrics.connects++;
        this.initialSubscribeSent = false; // Reset on new connection
        console.log("[WS] Connected");

        // Send initial subscription message (type: "market")
        if (this.subscriptions.size > 0) {
          this.sendInitialSubscribe(Array.from(this.subscriptions));
        }

        // Start PING heartbeat
        this.startPingHeartbeat();
      });

      this.ws.on("message", (data) => {
        this.metrics.messages_received++;
        
        // Handle ping/pong (text-based)
        const text = data.toString();
        if (text === "ping") {
          try {
            this.ws.send("pong");
            return;
          } catch (e) {
            console.error(`[WS] Failed to send pong: ${e?.message}`);
          }
        }
        
        try {
          const msg = JSON.parse(text);
          this.handleMessage(msg);
        } catch (e) {
          console.error(`[WS] Failed to parse message: ${e?.message}`);
        }
      });

      this.ws.on("ping", () => {
        // Binary ping frame (WebSocket protocol level)
        try {
          this.ws.pong();
        } catch (e) {
          console.error(`[WS] Failed to send pong: ${e?.message}`);
        }
      });

      this.ws.on("close", (code, reason) => {
        this.isConnected = false;
        this.stopPingHeartbeat();
        
        if (this._closing) {
          console.log(`[WS] Closed (shutdown)`);
          return; // Intentional close — don't reconnect or bump disconnect metrics
        }
        
        this.metrics.disconnects++;
        console.log(`[WS] Disconnected (code=${code}, reason=${reason || "none"})`);
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        console.error(`[WS] Error: ${err?.message || err}`);
      });

    } catch (e) {
      this.isConnecting = false;
      console.error(`[WS] Connect failed: ${e?.message || e}`);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this._closing) return; // Don't reconnect during shutdown
    
    this.metrics.reconnects++;
    console.log(`[WS] Reconnecting in ${this.reconnectDelay}ms...`);
    
    setTimeout(() => {
      if (this._closing) return;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff (1s → 2s → 4s → ... → 60s)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  startPingHeartbeat() {
    this.stopPingHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch (e) {
          console.error(`[WS] PING failed: ${e?.message}`);
        }
      }
    }, this.pingIntervalMs);
  }

  stopPingHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  sendInitialSubscribe(assetIds) {
    // Initial subscription message (sent once per connection)
    const msg = { assets_ids: assetIds, type: "market" };
    try {
      const payload = JSON.stringify(msg);
      console.log(`[WS] Sending initial subscribe: ${payload.slice(0, 100)}...`);
      this.ws.send(payload);
      this.initialSubscribeSent = true;
      console.log(`[WS] Initial subscription sent (${assetIds.length} assets)`);
    } catch (e) {
      console.error(`[WS] Initial subscribe failed: ${e?.message}`);
    }
  }

  sendDynamicSubscribe(assetIds) {
    // Dynamic subscription (for new assets after initial connect)
    const msg = { assets_ids: assetIds, operation: "subscribe" };
    try {
      const payload = JSON.stringify(msg);
      console.log(`[WS] Sending dynamic subscribe: ${payload.slice(0, 100)}...`);
      this.ws.send(payload);
      console.log(`[WS] Dynamic subscription sent (${assetIds.length} assets)`);
    } catch (e) {
      console.error(`[WS] Dynamic subscribe failed: ${e?.message}`);
    }
  }

  subscribe(tokenIds) {
    const newIds = tokenIds.filter(id => !this.subscriptions.has(id));
    if (newIds.length === 0) return;

    // Queue subscriptions
    for (const id of newIds) {
      this.subscriptions.add(id);
    }

    if (this.isConnected && this.initialSubscribeSent) {
      // Already connected and initial subscribe sent → use dynamic subscribe
      this.sendDynamicSubscribe(newIds);
    } else if (!this.isConnecting && !this.isConnected) {
      // Not connected and not connecting, trigger connection
      // Subscriptions will be sent as initial subscribe in 'open' handler
      this.connect();
    }
    // else: connecting or initial subscribe not sent yet, subscriptions queued
  }

  handleMessage(msg) {
    const eventType = msg.event_type;

    if (eventType === "price_change" && Array.isArray(msg.price_changes)) {
      // Primary message: price_change with array of updates
      for (const pc of msg.price_changes) {
        if (!pc.asset_id) continue;
        const bestBid = pc.best_bid != null ? Number(pc.best_bid) : null;
        const bestAsk = pc.best_ask != null ? Number(pc.best_ask) : null;
        if (bestBid != null && bestAsk != null) {
          this.cache.set(String(pc.asset_id), {
            bestBid,
            bestAsk,
            spread: bestAsk - bestBid,
            lastUpdate: Date.now(),
            timestamp: parseInt(pc.timestamp || msg.timestamp || "0", 10)
          });
          this.metrics.best_bid_ask_updates++;
        }
      }
    }
    else if (Array.isArray(msg)) {
      // Book snapshot (array format)
      for (const entry of msg) {
        if (!entry.asset_id) continue;
        // These are simplified book entries with just best prices
        const bestBid = entry.best_bid != null ? Number(entry.best_bid) : null;
        const bestAsk = entry.best_ask != null ? Number(entry.best_ask) : null;
        if (bestBid != null && bestAsk != null) {
          this.cache.set(String(entry.asset_id), {
            bestBid,
            bestAsk,
            spread: bestAsk - bestBid,
            lastUpdate: Date.now(),
            timestamp: parseInt(entry.timestamp || "0", 10)
          });
          this.metrics.book_snapshots++;
        }
      }
    }
    else if (eventType === "book" && msg.asset_id) {
      // Full book snapshot (object format)
      this.metrics.book_snapshots++;
      const bids = msg.bids || [];
      const asks = msg.asks || [];
      const bestBid = bids.length > 0 ? Math.max(...bids.map(b => Number(b.price))) : null;
      const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => Number(a.price))) : null;
      if (bestBid != null && bestAsk != null) {
        this.cache.set(String(msg.asset_id), {
          bestBid,
          bestAsk,
          spread: bestAsk - bestBid,
          lastUpdate: Date.now(),
          timestamp: parseInt(msg.timestamp || "0", 10)
        });
      }
    }
    else if (eventType === "last_trade_price" && msg.asset_id) {
      // Fallback: use last trade price if no cache entry
      const existing = this.cache.get(String(msg.asset_id));
      if (!existing) {
        const price = Number(msg.price);
        if (Number.isFinite(price)) {
          this.cache.set(String(msg.asset_id), {
            bestBid: price,
            bestAsk: price,
            spread: 0,
            lastUpdate: Date.now(),
            timestamp: parseInt(msg.timestamp || "0", 10)
          });
        }
      }
    }
    // Ignore: tick_size_change, etc.
  }

  getPrice(tokenId) {
    return this.cache.get(String(tokenId)) || null;
  }

  getMetrics() {
    return {
      ...this.metrics,
      cache_size: this.cache.size,
      subscriptions_count: this.subscriptions.size,
      is_connected: this.isConnected
    };
  }

  close() {
    this._closing = true; // Signal intentional shutdown BEFORE closing
    this.stopPingHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
  }
}
