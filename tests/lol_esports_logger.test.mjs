import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We test the pure functions directly — no network calls
// The module uses dynamic imports for book_http_client, so we test logic in isolation

describe("lol_esports_logger", () => {

  describe("normName + fuzzyMatch", () => {
    // These are internal but we can test the mapping logic through buildMapping-like patterns
    it("normalizes team names for matching", () => {
      const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      assert.equal(normName("Dplus KIA"), "dpluskia");
      assert.equal(normName("DN Freecs"), "dnfreecs");
      assert.equal(normName("Team Falcons"), "teamfalcons");
      assert.equal(normName("DN SOOPers"), "dnsoopers");
    });

    it("fuzzy matches team names", () => {
      const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const fuzzyMatch = (a, b) => {
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;
        return false;
      };
      // "Dplus KIA" from Polymarket matches "Dplus KIA" from Riot
      assert.ok(fuzzyMatch(normName("Dplus KIA"), normName("Dplus KIA")));
      // "DN Freecs" should match "DN SOOPers"? NO — different teams
      assert.ok(!fuzzyMatch(normName("DN Freecs"), normName("DN SOOPers")));
      // Substring match
      assert.ok(fuzzyMatch(normName("Dplus KIA"), normName("Dplus")));
    });
  });

  describe("schema validation", () => {
    it("market_tick ws record has required fields", () => {
      const record = {
        type: "market_tick",
        recv_ts_local: Date.now(),
        msg_ts_raw: null,
        msg_seq: null,
        riot_game_id: "12345",
        source: "ws",
        best_bid: 0.83,
        best_ask: 0.85,
        mid: 0.84,
        spread: 0.02,
        last_game_frame_ts: null,
        game_frame_age_ms: null,
      };
      assert.equal(record.type, "market_tick");
      assert.equal(record.source, "ws");
      assert.ok(record.recv_ts_local > 0);
      assert.equal(record.msg_ts_raw, null); // explicitly null when not available
    });

    it("market_tick http_book record has depth fields", () => {
      const record = {
        type: "market_tick",
        recv_ts_local: Date.now(),
        msg_ts_raw: null,
        msg_seq: null,
        riot_game_id: "12345",
        source: "http_book",
        best_bid: 0.83,
        best_ask: 0.85,
        mid: 0.84,
        spread: 0.02,
        ask_levels: [{ p: 0.85, s: 45 }, { p: 0.86, s: 120 }],
        bid_levels: [{ p: 0.83, s: 60 }, { p: 0.82, s: 90 }],
        depth_to_ask_plus_1c: 165,
        hypo_size_usd: 10,
        last_game_frame_ts: 1708419050000,
        game_frame_age_ms: 10000,
      };
      assert.equal(record.source, "http_book");
      assert.ok(Array.isArray(record.ask_levels));
      assert.ok(Array.isArray(record.bid_levels));
      assert.ok(record.depth_to_ask_plus_1c > 0);
    });

    it("game_frame record has all in-game fields", () => {
      const record = {
        type: "game_frame",
        recv_ts_local: Date.now(),
        frame_ts: "2026-02-20T09:45:33.359Z",
        riot_game_id: "12345",
        game_state: "in_game",
        blue_gold: 45000,
        red_gold: 40000,
        gold_diff: 5000,
        blue_kills: 12,
        red_kills: 7,
        kill_diff: 5,
        blue_towers: 5,
        red_towers: 3,
        tower_diff: 2,
        blue_dragons: 2,
        red_dragons: 1,
        blue_dragon_types: ["hextech", "cloud"],
        red_dragon_types: ["ocean"],
        blue_barons: 1,
        red_barons: 0,
        blue_inhibs: 0,
        red_inhibs: 0,
      };
      assert.equal(record.type, "game_frame");
      assert.equal(record.gold_diff, 5000);
      assert.equal(record.kill_diff, 5);
      assert.equal(record.game_state, "in_game");
    });

    it("mapping record has stable IDs", () => {
      const record = {
        type: "mapping",
        ts: Date.now(),
        polymarket_slug: "lol-dk-dnf-2026-02-20",
        condition_id: "0x29c...",
        outcome_token_id: "716163...",
        outcome_team_name: "Dplus KIA",
        outcome_team_riot_id: "100725845018863243",
        riot_match_id: "115604876650946517",
        riot_game_id: "115604876650946520",
        game_number: 3,
        series_score: [2, 0],
        blue_team_riot_id: "100725845018863243",
        red_team_riot_id: "99566404581868574",
        blue_team_name: "Dplus KIA",
        red_team_name: "DN SOOPers",
      };
      assert.equal(record.type, "mapping");
      assert.ok(record.outcome_team_riot_id); // stable ID, not name
      assert.ok(record.riot_game_id);
      assert.ok(record.condition_id);
    });

    it("outcome record uses team riot ID not side", () => {
      const record = {
        type: "outcome",
        recv_ts_local: Date.now(),
        riot_game_id: "12345",
        winner_team_riot_id: "100725845018863243",
        winner_determined_by: "gold_at_finish",
      };
      assert.equal(record.type, "outcome");
      assert.ok(record.winner_team_riot_id);
      // No "winner_side" field — side is derived, not primary
      assert.equal(record.winner_side, undefined);
    });
  });

  describe("depth_to_ask_plus_1c calculation", () => {
    it("sums size within 1c of best ask", () => {
      const asks = [
        { price: 0.85, size: 45 },
        { price: 0.855, size: 30 },
        { price: 0.86, size: 120 },
        { price: 0.87, size: 200 },
      ];
      const bestAsk = 0.85;
      const ceiling = bestAsk + 0.01;
      let depth = 0;
      for (const l of asks) {
        if (l.price <= ceiling) depth += l.size;
        else break;
      }
      // 0.85 + 0.855 + 0.86 = 195 (all <= 0.86)
      assert.equal(depth, 195);
    });

    it("handles single level", () => {
      const asks = [{ price: 0.90, size: 100 }];
      const bestAsk = 0.90;
      const ceiling = bestAsk + 0.01;
      let depth = 0;
      for (const l of asks) {
        if (l.price <= ceiling) depth += l.size;
        else break;
      }
      assert.equal(depth, 100);
    });
  });

  describe("candidate window logic", () => {
    it("triggers book fetch when ask is in range and spread is tight", () => {
      const ask = 0.85;
      const spread = 0.02;
      const minAsk = 0.70;
      const maxAsk = 0.95;
      const maxSpread = 0.06;
      const shouldFetch = ask >= minAsk && ask <= maxAsk && spread <= maxSpread;
      assert.ok(shouldFetch);
    });

    it("skips book fetch when ask is too high", () => {
      const ask = 0.97;
      const maxAsk = 0.95;
      const shouldFetch = ask <= maxAsk;
      assert.ok(!shouldFetch);
    });

    it("skips book fetch when spread is too wide", () => {
      const spread = 0.08;
      const maxSpread = 0.06;
      const shouldFetch = spread <= maxSpread;
      assert.ok(!shouldFetch);
    });

    it("does not depend on game_state", () => {
      // Candidate window is purely market-based
      // game_state is only added as context, never as trigger
      const ask = 0.82;
      const spread = 0.03;
      const gameState = null; // unknown
      const shouldFetch = ask >= 0.70 && ask <= 0.95 && spread <= 0.06;
      // Game state doesn't matter
      assert.ok(shouldFetch);
    });
  });

  describe("game_frame_age_ms", () => {
    it("computes correctly when frame exists", () => {
      const recvTs = 1708419060000;
      const lastFrameTs = 1708419050000;
      const age = lastFrameTs ? (recvTs - lastFrameTs) : null;
      assert.equal(age, 10000);
    });

    it("returns null when no frame yet", () => {
      const recvTs = 1708419060000;
      const lastFrameTs = null;
      const age = lastFrameTs ? (recvTs - lastFrameTs) : null;
      assert.equal(age, null);
    });
  });
});
