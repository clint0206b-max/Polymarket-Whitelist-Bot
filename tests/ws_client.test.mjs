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
});
