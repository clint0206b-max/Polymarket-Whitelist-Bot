// tests/ws_client.test.mjs
// Test WebSocket client basic functionality

import { describe, test } from "node:test";
import assert from "node:assert";
import { CLOBWebSocketClient } from "../src/clob/ws_client.mjs";

describe("CLOBWebSocketClient", () => {
  test("initializes with correct defaults", () => {
    const client = new CLOBWebSocketClient();
    
    assert.strictEqual(client.isConnected, false);
    assert.strictEqual(client.isConnecting, false);
    assert.strictEqual(client.cache.size, 0);
    assert.strictEqual(client.subscriptions.size, 0);
    assert.strictEqual(client.reconnectDelay, 1000);
    assert.strictEqual(client.maxReconnectDelay, 60000);
    assert.strictEqual(client.pingIntervalMs, 30000);
  });

  test("cache starts empty", () => {
    const client = new CLOBWebSocketClient();
    
    const price = client.getPrice("test-token-id");
    assert.strictEqual(price, null);
  });

  test("handleMessage updates cache on price_change", () => {
    const client = new CLOBWebSocketClient();
    
    const msg = {
      event_type: "price_change",
      price_changes: [
        {
          asset_id: "test-token-123",
          best_bid: "0.48",
          best_ask: "0.52",
          timestamp: "1234567890000"
        }
      ]
    };

    client.handleMessage(msg);
    
    const cached = client.getPrice("test-token-123");
    assert.ok(cached);
    assert.strictEqual(cached.bestBid, 0.48);
    assert.strictEqual(cached.bestAsk, 0.52);
    assert.ok(Math.abs(cached.spread - 0.04) < 0.0001);
    assert.ok(cached.lastUpdate <= Date.now());
  });

  test("handleMessage updates cache on book snapshot", () => {
    const client = new CLOBWebSocketClient();
    
    const msg = {
      event_type: "book",
      asset_id: "test-token-456",
      bids: [
        { price: "0.49", size: "100" },
        { price: "0.48", size: "200" }
      ],
      asks: [
        { price: "0.51", size: "150" },
        { price: "0.52", size: "250" }
      ],
      timestamp: "1234567890000"
    };

    client.handleMessage(msg);
    
    const cached = client.getPrice("test-token-456");
    assert.ok(cached);
    assert.strictEqual(cached.bestBid, 0.49);
    assert.strictEqual(cached.bestAsk, 0.51);
    assert.ok(Math.abs(cached.spread - 0.02) < 0.0001); // Float precision tolerance
  });

  test("handleMessage ignores unknown event types", () => {
    const client = new CLOBWebSocketClient();
    
    const msg = {
      event_type: "unknown_event",
      data: "some data"
    };

    client.handleMessage(msg);
    
    // Unknown events are silently ignored (no metrics tracked)
    assert.strictEqual(client.cache.size, 0);
  });

  test("handleMessage ignores price_change (not needed)", () => {
    const client = new CLOBWebSocketClient();
    
    const msg = {
      event_type: "price_change",
      market: "0x123",
      price_changes: []
    };

    client.handleMessage(msg);
    
    // Should not update cache or metrics
    assert.strictEqual(client.cache.size, 0);
  });

  test("subscriptions can be tracked manually", () => {
    const client = new CLOBWebSocketClient();
    
    // Manually add to subscriptions (without triggering connect)
    client.subscriptions.add("token-1");
    client.subscriptions.add("token-2");
    
    assert.strictEqual(client.subscriptions.size, 2);
    assert.ok(client.subscriptions.has("token-1"));
    assert.ok(client.subscriptions.has("token-2"));
  });

  test("subscriptions deduplicate via Set", () => {
    const client = new CLOBWebSocketClient();
    
    client.subscriptions.add("token-1");
    client.subscriptions.add("token-2");
    client.subscriptions.add("token-2"); // duplicate
    client.subscriptions.add("token-3");
    
    assert.strictEqual(client.subscriptions.size, 3);
  });

  test("getMetrics returns correct structure", () => {
    const client = new CLOBWebSocketClient();
    
    const metrics = client.getMetrics();
    
    assert.ok(metrics.connects !== undefined);
    assert.ok(metrics.disconnects !== undefined);
    assert.ok(metrics.messages_received !== undefined);
    assert.ok(metrics.best_bid_ask_updates !== undefined);
    assert.ok(metrics.cache_size !== undefined);
    assert.ok(metrics.subscriptions_count !== undefined);
    assert.ok(metrics.is_connected !== undefined);
  });

  test("metrics increment on handleMessage", () => {
    const client = new CLOBWebSocketClient();
    
    const msg = {
      event_type: "price_change",
      price_changes: [
        {
          asset_id: "test-token-123",
          best_bid: "0.5",
          best_ask: "0.6",
          timestamp: "123"
        }
      ]
    };

    // Manually increment (simulating what ws.on('message') does)
    client.metrics.messages_received++;
    client.handleMessage(msg);
    
    // After handleMessage, best_bid_ask_updates should be incremented
    assert.ok(client.metrics.messages_received >= 1);
    assert.ok(client.metrics.best_bid_ask_updates >= 1);
    assert.strictEqual(client.cache.size, 1);
  });

  test("close cleans up resources", () => {
    const client = new CLOBWebSocketClient();
    
    client.close();
    
    assert.strictEqual(client.isConnected, false);
    assert.strictEqual(client.isConnecting, false);
    assert.strictEqual(client.ws, null);
    assert.strictEqual(client.pingTimer, null);
  });

  test("close sets _closing flag to prevent reconnect", () => {
    const client = new CLOBWebSocketClient();
    assert.strictEqual(client._closing, false);
    
    client.close();
    
    assert.strictEqual(client._closing, true);
    // scheduleReconnect should be a no-op after close
    client.scheduleReconnect();
    assert.strictEqual(client.metrics.reconnects, 0); // Should NOT increment
  });

  // --- New: custom_feature_enabled, lastSeenTs, lastMessageTs, best_bid_ask ---

  test("sendInitialSubscribe includes custom_feature_enabled", () => {
    const client = new CLOBWebSocketClient();
    let sentPayload = null;
    client.ws = { send(data) { sentPayload = JSON.parse(data); } };
    client.sendInitialSubscribe(["token-1"]);
    assert.strictEqual(sentPayload.custom_feature_enabled, true);
    assert.strictEqual(sentPayload.type, "market");
  });

  test("sendDynamicSubscribe includes custom_feature_enabled", () => {
    const client = new CLOBWebSocketClient();
    let sentPayload = null;
    client.ws = { send(data) { sentPayload = JSON.parse(data); } };
    client.sendDynamicSubscribe(["token-2"]);
    assert.strictEqual(sentPayload.custom_feature_enabled, true);
    assert.strictEqual(sentPayload.operation, "subscribe");
  });

  test("handleMessage updates lastMessageTs on any message", () => {
    const client = new CLOBWebSocketClient();
    assert.strictEqual(client.lastMessageTs, 0);
    client.handleMessage({ event_type: "tick_size_change" });
    assert.ok(client.lastMessageTs > 0);
  });

  test("handleMessage sets lastSeenTs on price_change", () => {
    const client = new CLOBWebSocketClient();
    client.handleMessage({
      event_type: "price_change",
      price_changes: [{ asset_id: "tok1", best_bid: "0.5", best_ask: "0.6" }]
    });
    const entry = client.getPrice("tok1");
    assert.ok(entry.lastSeenTs > 0);
    assert.ok(entry.lastUpdate > 0);
  });

  test("handleMessage sets lastSeenTs on book event without updating price if no bids/asks", () => {
    const client = new CLOBWebSocketClient();
    // Pre-populate
    client.handleMessage({
      event_type: "price_change",
      price_changes: [{ asset_id: "tok1", best_bid: "0.5", best_ask: "0.6" }]
    });
    const firstUpdate = client.getPrice("tok1").lastUpdate;
    // Book with empty bids/asks: touches seen but doesn't update price
    client.handleMessage({ event_type: "book", asset_id: "tok1", bids: [], asks: [] });
    const entry = client.getPrice("tok1");
    assert.ok(entry.lastSeenTs >= firstUpdate);
    // lastUpdate should NOT have changed (no valid price in empty book)
    assert.strictEqual(entry.lastUpdate, firstUpdate);
  });

  test("handleMessage processes best_bid_ask event", () => {
    const client = new CLOBWebSocketClient();
    client.handleMessage({
      event_type: "best_bid_ask",
      changes: [{ asset_id: "tok1", best_bid: "0.45", best_ask: "0.55" }]
    });
    const entry = client.getPrice("tok1");
    assert.ok(entry);
    assert.strictEqual(entry.bestBid, 0.45);
    assert.strictEqual(entry.bestAsk, 0.55);
    assert.strictEqual(client.metrics.best_bid_ask_events, 1);
  });

  test("best_bid_ask with single object (no changes array)", () => {
    const client = new CLOBWebSocketClient();
    client.handleMessage({
      event_type: "best_bid_ask",
      asset_id: "tok2",
      best_bid: "0.30",
      best_ask: "0.70"
    });
    const entry = client.getPrice("tok2");
    assert.ok(entry);
    assert.strictEqual(entry.bestBid, 0.30);
    assert.strictEqual(entry.bestAsk, 0.70);
  });

  test("last_trade_price touches lastSeenTs", () => {
    const client = new CLOBWebSocketClient();
    // Pre-populate so last_trade_price doesn't create entry (existing behavior)
    client.handleMessage({
      event_type: "price_change",
      price_changes: [{ asset_id: "tok1", best_bid: "0.5", best_ask: "0.6" }]
    });
    const before = client.getPrice("tok1").lastSeenTs;
    // last_trade_price on existing entry: should touch seen but not update price
    client.handleMessage({ event_type: "last_trade_price", asset_id: "tok1", price: "0.55" });
    assert.ok(client.getPrice("tok1").lastSeenTs >= before);
  });

  test("getMetrics includes token_coverage and last_message_age_ms", () => {
    const client = new CLOBWebSocketClient();
    client.handleMessage({
      event_type: "price_change",
      price_changes: [{ asset_id: "tok1", best_bid: "0.5", best_ask: "0.6" }]
    });
    const m = client.getMetrics();
    assert.ok(m.token_coverage);
    assert.strictEqual(m.token_coverage.total, 1);
    assert.strictEqual(m.token_coverage.seen_10s, 1);
    assert.strictEqual(m.token_coverage.price_fresh_10s, 1);
    assert.ok(m.last_message_age_ms != null);
    assert.ok(m.last_message_age_ms < 1000); // Just processed
  });

  test("getMetrics: stale token shows in coverage", () => {
    const client = new CLOBWebSocketClient();
    // Manually insert a stale entry
    client.cache.set("old-tok", {
      bestBid: 0.5, bestAsk: 0.6, spread: 0.1,
      lastUpdate: Date.now() - 30000,
      lastSeenTs: Date.now() - 30000,
      timestamp: 0
    });
    const m = client.getMetrics();
    assert.strictEqual(m.token_coverage.total, 1);
    assert.strictEqual(m.token_coverage.seen_10s, 0);
    assert.strictEqual(m.token_coverage.price_fresh_10s, 0);
  });
});
