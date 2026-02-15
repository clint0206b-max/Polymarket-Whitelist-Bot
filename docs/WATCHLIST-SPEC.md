# Watchlist v1 — Gamma discovery + CLOB/WS price evaluation

**Status:** agreed spec (2026-02-14). Not implemented yet.

## Goal
Separate **market discovery** (Gamma) from **price evaluation** (WS/CLOB) to:
- reduce rate-limit risk,
- avoid missing markets due to discovery timing,
- add per-market state (TTL/cooldowns/pending/signaled).

## Key Constraints
- **One process, one writer** (avoid state corruption).
- Persist state to a single JSON file with **atomic write** (tmp + rename).
- Watchlist bounded by **TTL + max size**.

---

## Persistent State File
- Path: `state/watchlist.json`
- Write pattern:
  1) read JSON on start
  2) update in memory
  3) write `state/watchlist.json.tmp`
  4) rename → `state/watchlist.json` (atomic)
- Optional safety: lockfile to prevent double instance:
  - `state/watchlist.lock` (O_EXCL create; check PID if present)

### Top-level schema (v1)
```json
{
  "version": 1,
  "polling": {
    "gamma_discovery_seconds": 60,
    "clob_eval_seconds": 2,
    "watchlist_ttl_minutes": 30,
    "candidate_cooldown_seconds": 20,
    "depth_cache_ttl_seconds": 15,
    "pending_window_seconds": 6,
    "max_watchlist": 200
  },
  "filters": {
    "min_prob": 0.94,
    "max_entry_price": 0.97,
    "max_spread": 0.02,
    "min_exit_depth_usd_bid": 2000,
    "min_entry_depth_usd_ask": 1000,
    "exit_depth_floor_price": 0.70
  },
  "events_index": {
    "last_gamma_fetch_ts": 0
  },
  "watchlist": {},
  "runtime": {
    "last_run_ts": 0,
    "runs": 0,
    "candidates_found": 0
  }
}
```

---

## Watchlist Entry (per market)
**Key:** `conditionId` (string)

Fields (recommended minimum):
- `conditionId`, `slug`, `question`, `eventSlug`, `tag`
- `tokens`:
  - `clobTokenIds`: `[tokenA, tokenB]` (strings)
  - `yes_token_id`: string|null
  - `no_token_id`: string|null
  - `resolved_by`: string|null
  - `resolved_ts`: number|null
  - `token_complement_sanity_ok`: boolean|null
- `status`: `watching | pending_signal | signaled | traded | ignored | expired`
- `first_seen_ts`, `last_seen_ts`
- `cooldown_until_ts`
- `last_price`:
  - `yes_best_bid`, `yes_best_ask`, `spread`, `updated_ts`, `source` (ws/http)
- `liquidity`:
  - `entry_depth_usd_ask`, `exit_depth_usd_bid`, `updated_ts`
  - `exit_depth_floor_price` (for transparency)
- `signals`:
  - `pending_since_ts`
  - `last_signal_ts`
  - `signal_count`
  - `reason`
- `traded` (when manual execution happens):
  - `traded_ts`, `side`, `entry_price`, `shares`, `cost`, `order_id`/`tx_hash`

---

## Tokens contract & resolution (v1)

### Goal
Maintain a deterministic and non-ambiguous token mapping for each market:
- persist raw `clobTokenIds` from Gamma (normalized)
- resolve `yes_token_id` / `no_token_id` once (Phase 2) using `/book` only

### Tokens shape (per market)
```json
{
  "tokens": {
    "clobTokenIds": ["<tokenA>", "<tokenB>"],
    "yes_token_id": null,
    "no_token_id": null,
    "resolved_by": null,
    "resolved_ts": null,
    "token_complement_sanity_ok": null
  }
}
```

### Phase 1 (Gamma parse + upsert) — normalization only (no CLOB)
- If `clobTokenIds` is a string: attempt `JSON.parse`.
  - On failure: increment `runtime.health.gamma_token_parse_fail_count` and set `clobTokenIds=[]`.
- If `clobTokenIds` is an array: use as-is.
- Validation (v1): only accept arrays of length **2**.
  - Otherwise: increment `runtime.health.gamma_token_count_unexpected_count` and set `yes_token_id/no_token_id=null`.

Non-destructive upsert rules:
- never overwrite existing non-empty token fields with empty/null.

### Phase 2 (HTTP-only) — deterministic yes/no resolution using `/book`
If:
- `clobTokenIds.length == 2`
- and `yes_token_id == null`

Then resolve using `/book` once for each token (same client/parser as Stage 1/2).

**Deterministic score (v1):**
- `score(token) = bestAsk if asks.length>0, else bestBid if bids.length>0, else null`

Resolution:
- fetch `/book` for token A and token B
- derive `scoreA`, `scoreB`
- if both scores exist:
  - if `scoreA > scoreB` ⇒ YES=A, NO=B
  - if `scoreB > scoreA` ⇒ YES=B, NO=A
  - if `scoreA == scoreB` ⇒ do not resolve; increment `token_resolve_failed_count` with reason `tie_score`
- if either score is null ⇒ do not resolve; increment `token_resolve_failed_count` with reason `missing_score`

Persist on success:
- `resolved_by = "book_score_compare"`
- `resolved_ts = now`

Failure rules:
- If one or both `/book` calls fail or payload not usable:
  - do not resolve
  - increment `runtime.health.token_resolve_failed_count`
  - treat market as `gamma_metadata_missing` for evaluation (no `yes_token_id`)

Optional sanity (health only):
- define `p_hi(token) = bestAsk if exists else bestBid if exists else null`
- if `p_hiA` and `p_hiB` exist:
  - `complement_sum = p_hiA + p_hiB`
  - `token_complement_sanity_ok = (complement_sum in [0.90, 1.10])`
  - if false: increment `runtime.health.token_complement_sanity_fail_count`
- if either is null:
  - do not evaluate sanity (optional health: `token_complement_sanity_skipped_count`)

### Naming consistency note
In code, Stage 2 must use the exact config keys:
- `filters.min_exit_depth_usd_bid`
- `filters.min_entry_depth_usd_ask`

---

## Loop A — Gamma discovery (every N seconds)
**Purpose:** maintain watchlist membership (indexing), not low-latency pricing.

- Call Gamma `/events` with `live=true` (base policy).
- Select only game-bet markets (NBA/CBB main; esports submarkets) and drop spreads/totals.
- Apply cheap pre-filter: Gamma `vol24h >= min_liquidity_usd` (hint only).
- Upsert markets into `watchlist`:
  - set `first_seen_ts` if new
  - update `last_seen_ts` always

No immediate deletes; TTL cleanup handles shrink.

---

## Loop B — Price evaluation (every 1–2 seconds)
**Primary source:** WS cached prices. **Fallback:** CLOB HTTP when WS missing/stale.

### Stage 1 (cheap)
Compute:
- `probAsk` (from YES best ask)
- `probBid` (from YES best bid)
- `spread = ask - bid`

### "Almost signal" gate → triggers Stage 2 (expensive)
Base:
- `probAsk >= 0.94`
- `probAsk <= 0.97`
- `spread <= 0.02`
Plus safety margin to avoid spamming depth calls:
- `probAsk >= 0.945` OR `spread <= 0.015`

### Stage 2 (expensive): CLOB orderbook depth (cached)
Compute depths **on YES orderbook** with TTL cache (`depth_cache_ttl_seconds = 15`).

#### entry_depth_usd_ask
- Sum asks: `level_usd = price * size`
- Only include levels where `price <= max_entry_price (0.97)`
- Stop when sum >= 1000 or book ends

#### exit_depth_usd_bid
- Sum bids: `level_usd = price * size`
- Only include levels where `price >= exit_depth_floor_price (0.70)`
- Stop when sum >= 2000 or book ends

#### Liquidity rules (required)
- `exit_depth_usd_bid >= 2000`
- `entry_depth_usd_ask >= 1000`

### State machine (anti-spam)
- If candidate passes all filters and not in cooldown:
  - first hit: `watching → pending_signal` (set `pending_since_ts`)
  - second hit within `pending_window_seconds = 6`: `pending_signal → signaled`
  - otherwise: return to `watching`

`signaled` does **not** auto-trade in v1.

---

## Reject reasons v1 (final) — consistent TOP_REJECTS

### Principle
Per evaluation (Loop B) we assign:
- `primary_reject_reason` (exactly 1)
- optional `secondary_reject_reasons[]` (verbose/samples only)

`TOP_REJECTS` counts **only** `primary_reject_reason`.

### What counts as an "evaluation"
Count only markets with `status in {watching, pending_signal}` processed in the current Loop B cycle.
Do **not** count: `signaled`, `traded`, `ignored`, `expired`.

### Stages
- **Stage 0 (metadata eligibility):** market must have minimal required metadata (conditionId, tokenIds, league/slug/title).
- **Stage 1 (cheap):** price + spread from WS (primary) with HTTP fallback.
- **Stage 2 (expensive):** orderbook depth on-demand (cached).
- **Stage 3 (gating):** cooldown / pending window state transitions.

### Reasons (and stage assignment)
**Data / sources**
- `gamma_metadata_missing` — Stage 0 (also increments `gamma_metadata_missing_count` health)
- `http_fallback_failed` — Stage 1 (WS missing/stale and HTTP fallback fails ⇒ no usable price)

**Price / spread filters (Stage 1)**
- `price_out_of_range` — `probAsk < min_prob` OR `probAsk > max_entry_price`
- `spread_above_max` — `spread > max_spread`

**Near-signal margin (Stage 1) — NOT in default TOP_REJECTS**
- `not_near_signal_margin` — passes Stage 1 base, but fails margin gate for depth fetch
  - shown in verbose; aggregated as `gray_zone_count`

**Depth / liquidity (Stage 2)**
- `depth_cache_stale_and_fetch_failed` — depth needed but cache stale and depth fetch fails
- `depth_bid_below_min` — `exit_depth_usd_bid < min_exit_depth_usd_bid` (floor applied)
- `depth_ask_below_min` — `entry_depth_usd_ask < min_entry_depth_usd_ask` (max_entry_price applied)

**Cooldown (Stage 3)**
- `cooldown_active` — candidate passes all signal conditions (including depth) but `now < cooldown_until_ts`
  - also increment `cooldown_active_count` health

**Pending window**
- `pending_window_missed` — not a market reject; track as separate metric if desired.

### Priority order (first failure wins)
To keep TOP_REJECTS stable, use fixed priority:
1) `gamma_metadata_missing`
2) `http_fallback_failed`
3) `price_out_of_range`
4) `spread_above_max`
5) `depth_cache_stale_and_fetch_failed`
6) `depth_bid_below_min`
7) `depth_ask_below_min`
8) `cooldown_active`

---

## WS stale & price usability (v1)

### WS staleness
Constant (recommended):
- `WS_PRICE_STALE_MS = 2500` (for `clob_eval_seconds = 2`)

Rule:
- WS price is **stale** if `now - last_price.updated_ts > WS_PRICE_STALE_MS`.

### "Usable price" definition
A price snapshot is usable iff:
- `bid` and `ask` exist and are finite numbers
- `0 < bid <= ask <= 1`
- `spread = ask - bid` is finite and `>= 0`

Edge cases:
- missing bid (only ask) ⇒ not usable (cannot compute spread)
- `bid > ask` or `bid/ask == 0` ⇒ corrupt/not usable

### WS vs HTTP decision
1) If WS price is **fresh + usable**, use it.
2) Else attempt HTTP fallback.
   - If HTTP yields usable price: use it and increment health counters:
     - `ws_missing_used_http_count` OR `ws_stale_used_http_count` (depending on why)
     - `http_fallback_success_count`
   - If HTTP fails / unusable: `primary_reject_reason = http_fallback_failed` and increment `http_fallback_fail_count`.

---

## Rolling 5-minute aggregation (v1)
Persist a small ring buffer in `runtime` for calibration stability:
- `rejects_buckets[5]` — 5 buckets of 60s each (counts by primary reason + limited samples)
- `health_buckets[5]` — same idea for WS/HTTP health metrics
- `current_bucket_index`

`status.mjs` default shows:
- `TOP_REJECTS last_cycle`
- `TOP_REJECTS last_5min` (sum buckets)

---

## HTTP endpoints & failure mapping (v1)

### Objective
Define a single HTTP fallback without ambiguity, and lock down the mapping from failures to **rejects** and **health metrics** so `TOP_REJECTS` and `HEALTH` stay consistent and calibratable.

### HTTP endpoints
**Single endpoint** for both price fallback and depth calculation:
- `GET https://clob.polymarket.com/book?token_id=YES_TOKEN_ID`

(Do **not** use `/price` in v1 to avoid discrepancies and reduce endpoint surface.)

From one `/book` response derive:
- `probAsk` = best ask price
- `probBid` = best bid price
- `spread = probAsk - probBid`
- `entry_depth_usd_ask` (asks up to `max_entry_price`)
- `exit_depth_usd_bid` (bids down to `exit_depth_floor_price`)

### WS stale & WS incomplete
- `WS_PRICE_STALE_MS = 2500`
- WS stale if: `now - last_price.updated_ts > WS_PRICE_STALE_MS`
- WS incomplete if bid/ask missing OR spread cannot be computed under the "usable price" rules.

Rule:
- If WS is fresh but incomplete ⇒ treat as **not usable** and fall back to `/book`.

### Semantics of calling `/book`
The same `/book` call can be made for two reasons; the reason determines the reject if it fails.

**Reason A: need usable price**
- WS missing / stale / incomplete ⇒ call `/book`.
- If `/book` fails or is unusable ⇒ `primary_reject_reason = http_fallback_failed`.

**Reason B: need depth (Stage 2)**
- Stage 1 passes and we need real depth (cache stale) ⇒ call `/book`.
- If `/book` fails ⇒ `primary_reject_reason = depth_cache_stale_and_fetch_failed`.

### Definition of "fetch failed" and mapping
Cases for `/book`:

**Network error / timeout / 5xx**
- Primary reject:
  - Reason A ⇒ `http_fallback_failed`
  - Reason B ⇒ `depth_cache_stale_and_fetch_failed`
- Health: `http_fallback_fail_count += 1`

**Rate limited (HTTP 429)**
- Primary reject:
  - Reason A ⇒ `http_fallback_failed`
  - Reason B ⇒ `depth_cache_stale_and_fetch_failed`
- Health:
  - `rate_limited_count += 1`
  - `last_rate_limited_ts = now`
  - `http_fallback_fail_count += 1`

**HTTP 200 but payload unusable**
Examples:
- bids/asks missing
- both arrays empty after filtering (NOTE: **one-sided is allowed** at parse level)
- non-parseable values
- invalid best bid/ask (if both present, must satisfy `bestBid <= bestAsk`)

- Primary reject:
  - Reason A ⇒ `http_fallback_failed`
  - Reason B ⇒ `depth_cache_stale_and_fetch_failed`
- Health:
  - `http_fallback_fail_count += 1`
  - `book_empty_count += 1` if **both** bids and asks are empty/missing after filtering

**NOTE (v1)**: a one-sided book (only bids or only asks) is parseable, but Stage 1 quote is **not usable** unless both `bestBid` and `bestAsk` exist. In that case reject as `quote_incomplete_one_sided_book` (with health subreasons `missing_best_bid` / `missing_best_ask`).

### `/book` usable but depth fails
If `/book` is usable and depths compute, apply depth rules:
- If both fail:
  - `exit_depth_usd_bid < min_exit_depth_usd_bid`
  - `entry_depth_usd_ask < min_entry_depth_usd_ask`
  - then `primary_reject_reason = depth_bid_below_min`
  - and `depth_ask_below_min` may be secondary (verbose/samples only)

Depth definitions (v1):
- `exit_depth_usd_bid`: sum `price * size` for bids with `price >= exit_depth_floor_price (0.70)` until >= 2000 or book ends
- `entry_depth_usd_ask`: sum `price * size` for asks with `price <= max_entry_price (0.97)` until >= 1000 or book ends

### WS vs HTTP health metrics
If `/book` succeeds:
- WS missing ⇒ `ws_missing_used_http_count += 1` and `http_fallback_success_count += 1`
- WS stale ⇒ `ws_stale_used_http_count += 1` and `http_fallback_success_count += 1`
- WS incomplete ⇒ `ws_incomplete_used_http_count += 1` and `http_fallback_success_count += 1`

If `/book` fails:
- `http_fallback_fail_count += 1` (+ `rate_limited_count` / `book_empty_count` when applicable)

Notes:
- `ws_missing_no_cache` is effectively deprecated as a reject in v1 since `/book` exists as fallback.

---

## /book response format, parsing, validation (v1)

### Objective
Define the expected response format of the `/book` endpoint and strict parsing/validation rules to:
- avoid ambiguity between string and number,
- detect corrupt payloads,
- keep consistency with "usable price" and with rejects/health metrics.

Endpoint:
- `GET https://clob.polymarket.com/book?token_id=YES_TOKEN_ID`

### Expected high-level shape
Minimum required fields:
- `bids`: array
- `asks`: array

Each level must contain:
- `price`
- `size`

### Accepted representations
`price` and `size` may be:
- number
- numeric string (e.g. `"0.946"`, `"120.5"`)

### Parsing rules (strict)
When parsing `price` and `size`:
- reject `NaN`
- reject `Infinity`
- reject empty strings
- reject non-numeric strings
- normalize using `.` decimal separator only (do **not** accept `,`)

### Allowed ranges
- `price`: `0 < price <= 1`
- `size`: `size > 0`

Invalid levels are **discarded** (prefer discarding bad levels over rejecting the entire book), but see "book usable".

### Ordering
Do **not** assume the API returns sorted levels.
Sort internally:
- bids: price desc
- asks: price asc

### Book usable definition
After parsing, discarding invalid levels, and sorting:
- at least 1 valid bid must exist
- at least 1 valid ask must exist

If not:
- `book_empty_count += 1`
- treat the fetch as **payload not usable**.

### Best bid/ask and spread
- `best_bid = bids[0].price`
- `best_ask = asks[0].price`

Consistency rules:
- must satisfy `0 < best_bid <= best_ask <= 1`
- if `best_bid > best_ask`: treat as corrupt/inconsistent ⇒ payload not usable.

"Usable price" from `/book` requires:
- best_bid and best_ask exist and satisfy the above
- `spread = best_ask - best_bid` and `spread >= 0`

### Depth calculation
Levels discarded during parsing do not participate.

#### exit_depth_usd_bid
- include bids where `price >= exit_depth_floor_price (0.70)`
- `level_usd = price * size`
- accumulate until `>= min_exit_depth_usd_bid (2000)` or levels end

#### entry_depth_usd_ask
- include asks where `price <= max_entry_price (0.97)`
- `level_usd = price * size`
- accumulate until `>= min_entry_depth_usd_ask (1000)` or levels end

If usable price exists but depth does not meet minimums, this is **not** fetch failed; it maps to:
- `depth_bid_below_min` (priority)
- `depth_ask_below_min`

### Payload not usable → failure mapping
Payload is not usable when:
- bids/asks missing or not arrays, OR
- after cleanup bids valid empty or asks valid empty, OR
- `best_bid > best_ask`

Then:
- Reason A (need usable price) ⇒ `http_fallback_failed`
- Reason B (need depth) ⇒ `depth_cache_stale_and_fetch_failed`
- plus `book_empty_count += 1` when applicable.

### Optional verbose-only parse debugging
Keep verbose-only counters/samples:
- `count_parse_failed_levels`
- one sample of raw level value

Do not affect TOP_REJECTS.

### Protection limits
To avoid slow loops on huge books:
- `max_levels_considered = 50` per side (bids and asks)

**Explicit truncation rule (v1):** truncation is applied **only after**:
1) parsing
2) filtering invalid levels
3) sorting bids desc / asks asc

If more levels exist, truncate after sorting.

Best bid/ask uses the first level after sorting.
Depth uses up to 50 levels.

### Guardrail: heavily filtered payloads (health only)
For each side (bids and asks):
- `levels_total` = number of levels received
- `levels_valid` = levels that pass parse + range checks
- `discard_ratio = 1 - (levels_valid / levels_total)` when `levels_total > 0`

Rule:
- if `discard_ratio >= 0.80` on bids OR asks:
  - increment `runtime.health.book_parse_heavily_filtered_count += 1`

Notes:
- does not change rejects
- show only in verbose/health

---

## WS message format, parsing, validation, freshness (v1)

### Objective
Define the expected format of the CLOB WS stream used to obtain best bid/ask, with parsing/validation rules identical to `/book`, and a local `updated_ts` + staleness semantics comparable 1:1 with HTTP fallback.

### Scope
Defines:
- what data we consume from WS
- what counts as a usable message/state
- how we normalize numbers
- how we compute `updated_ts`
- when data is considered stale

Does **not** define subscription/reconnect logic.

### Logical cache shape
For each `token_id` (YES token) maintain:

```js
ws_cache[token_id] = {
  best_bid_price,
  best_bid_size,
  best_ask_price,
  best_ask_size,
  updated_ts,
  source: "ws",
  raw_seq: null // optional
}
```

### WS message requirement (v1)
WS may emit different shapes by channel. For v1 we only require that the parser can derive, for a given `token_id`:
- best bid price (and optionally size)
- best ask price (and optionally size)

The WS parser must produce the same logical output as `/book` best levels.

### Numeric parsing
Same rules as `/book`:
- accept number or numeric string
- reject NaN/Infinity/empty/non-numeric
- normalize using `.` decimal separator only (no commas)

### Range/validity
Same as `/book`:
- `0 < price <= 1`
- `size > 0`

### Invalid field handling (conservative cache)
- If bid fields are invalid, ignore the bid update.
- If ask fields are invalid, ignore the ask update.
- Do **not** delete previously valid cached values unless the message explicitly signals no liquidity (out of scope v1).

### Usable WS price definition
WS price is usable iff, for the token cache:
- `best_bid_price` and `best_ask_price` exist
- `0 < best_bid_price <= best_ask_price <= 1`
- `spread = best_ask_price - best_bid_price` is finite and `>= 0`

If bid or ask is missing ⇒ WS is **incomplete** and not usable for Stage 1 (fallback to `/book`).

### updated_ts (closed rule)
`updated_ts` is the **local timestamp** `now` at the moment we process a WS message that contains bid and/or ask information for that token and passes basic numeric parsing.

**Updated_ts refresh on "no change" messages (v1):**
- If a valid WS message includes bid or ask for the `token_id` (even if the value is unchanged vs cache), set `updated_ts = now`.
- Motivation: a "no change" still confirms the subscription is alive and the cached quote is fresh, avoiding unnecessary `/book` fallbacks in quiet markets.
- Exception: if the WS message contains **no bid/ask info** for that `token_id`, do not update `updated_ts`.

We do **not** rely on remote timestamps.

### WS staleness
- `WS_PRICE_STALE_MS = 2500`
- stale if: `now - ws_cache[token_id].updated_ts > WS_PRICE_STALE_MS`

### missing vs stale vs incomplete
- **missing**: no cache entry exists for `token_id`
- **stale**: cache entry exists but is stale
- **incomplete**: cache exists (fresh or stale) but missing bid/ask or violates `bid <= ask`

### Fallback + health metric mapping (Stage 1)
When Stage 1 needs a price:
- If WS is fresh + usable ⇒ use WS; `ws_fresh_count += 1`
- If WS is missing ⇒ fall back to `/book`
  - if `/book` succeeds: `ws_missing_used_http_count += 1` + `http_fallback_success_count += 1`
  - if `/book` fails: `http_fallback_fail_count += 1`
- If WS is stale ⇒ fall back to `/book`
  - if `/book` succeeds: `ws_stale_used_http_count += 1` + `http_fallback_success_count += 1`
- If WS is incomplete ⇒ treat as missing for fallback:
  - if `/book` succeeds: `ws_incomplete_used_http_count += 1` + `http_fallback_success_count += 1`

### Comparability with `/book`
In `status.mjs`, per market:
- `price_source = ws|http`
- `price_age_s = now - price.updated_ts`

If source is WS, `updated_ts` is local WS processing time.
If source is HTTP, `updated_ts` is local `/book` processing time.

This makes WS staleness and HTTP age comparable on the same scale.

### Cache overwrite rules
- **No-degradation:** invalid WS updates must not wipe valid cached values.
- **Coherence:** if updating one side makes `bid > ask`, mark as incomplete (not usable) until a coherent update arrives.

### Optional WS payload health
- `ws_parse_invalid_count += 1` when detecting invalid WS numeric fields (health only, never a reject).

---

## Stage 1 signal functions (v1)

### Objective
Define deterministic, pure functions for Stage 1 with float-robust comparisons to decide:
- if a market is a base candidate
- if it is in near-signal margin (enables Stage 2 / depth)

### Conventions
Inputs:
- `quote`: `probAsk` (float), `probBid` (float), `spread` (float), where `spread = probAsk - probBid`
- `cfg`: `min_prob`, `max_entry_price`, `max_spread`, `near_prob_min`, `near_spread_max`, `EPS` (default `1e-6`)

All thresholds come from config.
Defaults v1:
- `EPS = 1e-6`
- `min_prob = 0.94`
- `max_entry_price = 0.97`
- `max_spread = 0.02`
- `near_prob_min = 0.945`
- `near_spread_max = 0.015`

### EPS comparisons
- `gte(x, t) := (x + EPS) >= t`
- `lte(x, t) := (x - EPS) <= t`

### Preconditions
Stage 1 assumes `quote` already passed "usable price" validation:
- `0 < probBid <= probAsk <= 1`
- `spread >= 0`

If not, Stage 1 must not run; the pipeline should fall back or reject earlier (`http_fallback_failed`, etc.).

---

## Function 1: is_base_signal_candidate(quote, cfg)
Signature:
- `is_base_signal_candidate(quote, cfg) -> (pass: bool, primary_reason: string|null)`

Rules (fixed order):
1) **Price out of range**
- if `gte(probAsk, cfg.min_prob)` is false OR `lte(probAsk, cfg.max_entry_price)` is false
  - return `(false, "price_out_of_range")`

2) **Spread above max**
- if `lte(spread, cfg.max_spread)` is false
  - return `(false, "spread_above_max")`

3) Pass
- return `(true, null)`

Notes:
- Primary reason is unique and stable due to fixed evaluation order.
- Near-margin is not evaluated here.

---

## Function 2: is_near_signal_margin(quote, cfg)
Signature:
- `is_near_signal_margin(quote, cfg) -> bool`

Rule:
- return `true` iff:
  - `gte(probAsk, cfg.near_prob_min)` is true **OR**
  - `lte(spread, cfg.near_spread_max)` is true

If returns false:
- increment `gray_zone_count`
- do not request depth
- do not change state (stay `watching` / `pending_signal` as applicable)

---

### Calibration notes
- Too few Stage 2 checks: decrease `near_prob_min` or increase `near_spread_max` (without changing `min_prob`/`max_spread`).
- Too many depth fetches: increase `near_prob_min` or decrease `near_spread_max`.

---

## Stage 2 depth evaluation functions (v1)

### Objective
Standardize depth (liquidity) calculation and decision as deterministic functions using the YES token orderbook (`/book`).

### Conventions
Inputs:
- `book`:
  - `bids`: array of levels `{ price, size }` already parsed/filtered/sorted/truncated per "/book response format, parsing, validation (v1)"
  - `asks`: array of levels `{ price, size }` same
- `cfg`:
  - `min_exit_depth_usd` (default 2000)
  - `min_entry_depth_usd` (default 1000)
  - `exit_depth_floor_price` (default 0.70)
  - `max_entry_price` (default 0.97)
  - `max_levels_considered` (default 50)
  - `depth_cache_ttl_seconds` (default 15)
  - `EPS` (default `1e-6`)

EPS comparisons:
- `gte(x, t) := (x + EPS) >= t`
- `lte(x, t) := (x - EPS) <= t`

---

## Function 1: compute_depth_metrics(book, cfg)
Signature:
- `compute_depth_metrics(book, cfg) -> metrics`

Output:
- `entry_depth_usd_ask` (float)
- `exit_depth_usd_bid` (float)
- `bid_levels_used` (int)
- `ask_levels_used` (int)

Deterministic rules:

### A) exit_depth_usd_bid
Initialize:
- `sum_usd = 0`
- `levels_used = 0`

Iterate bids (price desc), already truncated to `cfg.max_levels_considered`:
- for each `{ price, size }`:
  - if `lte(price, 0)` or `lte(size, 0)`: continue (should not happen post-parse)
  - if `gte(price, cfg.exit_depth_floor_price)` is false: break (remaining bids are lower)
  - `level_usd = price * size`
  - `sum_usd += level_usd`
  - `levels_used += 1`
  - **early stop:** if `gte(sum_usd, cfg.min_exit_depth_usd)`: break

Set:
- `exit_depth_usd_bid = sum_usd`
- `bid_levels_used = levels_used`

### B) entry_depth_usd_ask
Initialize:
- `sum_usd = 0`
- `levels_used = 0`

Iterate asks (price asc), already truncated to `cfg.max_levels_considered`:
- for each `{ price, size }`:
  - if `lte(price, 0)` or `lte(size, 0)`: continue
  - if `lte(price, cfg.max_entry_price)` is false: break (remaining asks are higher)
  - `level_usd = price * size`
  - `sum_usd += level_usd`
  - `levels_used += 1`
  - **early stop:** if `gte(sum_usd, cfg.min_entry_depth_usd)`: break

Set:
- `entry_depth_usd_ask = sum_usd`
- `ask_levels_used = levels_used`

Notes:
- Early stop is used for performance and determinism.
- No interpolation; only discrete levels.

---

## Function 2: is_depth_sufficient(metrics, cfg)
Signature:
- `is_depth_sufficient(metrics, cfg) -> (pass: bool, primary_reason: string|null)`

Fixed order (exit first):
1) Exit depth:
- if `gte(metrics.exit_depth_usd_bid, cfg.min_exit_depth_usd)` is false ⇒ `(false, "depth_bid_below_min")`

2) Entry depth:
- if `gte(metrics.entry_depth_usd_ask, cfg.min_entry_depth_usd)` is false ⇒ `(false, "depth_ask_below_min")`

3) Pass:
- `(true, null)`

---

## Function 3: get_depth_with_cache(marketId, tokenId, cache, cfg)
### Purpose
Define cache semantics and the mapping to `depth_cache_stale_and_fetch_failed` without relying on a specific implementation.

Signature:
- `get_depth_with_cache(marketId, tokenId, cache, cfg) -> (ok: bool, metrics_or_reason)`

Cache key:
- `cache_key = tokenId` (recommended) OR `marketId`, but must be consistent system-wide.

Cache entry:
- `cache[cache_key] = { metrics, updated_ts }`

Freshness:
- cache is fresh if `now - updated_ts <= cfg.depth_cache_ttl_seconds`

Return rules:
- If cache fresh ⇒ return `(true, cache.metrics)`
- If cache missing/stale ⇒ fetch `/book` for `tokenId`
  - if fetch fails or payload not usable (per "HTTP endpoints & failure mapping (v1)") ⇒ return `(false, "depth_cache_stale_and_fetch_failed")`
  - if fetch ok + book usable ⇒
    - `metrics = compute_depth_metrics(book, cfg)`
    - save cache with `updated_ts = now`
    - return `(true, metrics)`

Notes:
- This wrapper is called only in Stage 2 (after Stage 1 near-margin gate).
- If HTTP is called for **Reason A** (need usable price), the reject is `http_fallback_failed` (not `depth_cache_stale_and_fetch_failed`).

---

### Defaults v1 (config)
- `min_exit_depth_usd = 2000`
- `min_entry_depth_usd = 1000`
- `exit_depth_floor_price = 0.70`
- `max_entry_price = 0.97`
- `max_levels_considered = 50`
- `depth_cache_ttl_seconds = 15`
- `EPS = 1e-6`

---

## State machine transitions (v1)

### Objective
Define the complete watchlist market state machine as deterministic transitions:
- which inputs trigger transitions
- which JSON fields mutate
- which counters increment (signals, rejects, health)
- how pending window is resolved without depending on loop timing
- what happens if a market is already `signaled` and conditions fluctuate

### States (market.status)
- `watching`
- `pending_signal`
- `signaled`
- `traded`
- `ignored`
- `expired`

### Global rule: eligibility for signaling pipeline
Only markets with `status in {watching, pending_signal}` enter the **signal pipeline** (Stage 1 → near margin → Stage 2 → gating).

Markets with `status in {signaled, traded, ignored, expired}`:
- still have `last_price` / `liquidity` updated when available (for dashboard visibility)
- do **not** increment `TOP_REJECTS` (no primary rejects counted)
- do **not** transition automatically in v1 (except cleanup/TTL)

### Sticky signals (v1)
If a market is `signaled`, it remains `signaled` until one of:
- user/manual action sets `status` to `traded` or `ignored` (or back to `watching`)
- TTL cleanup expires it (not seen for `watchlist_ttl_minutes`)

This avoids re-signal spam when the market price dips and recovers.

---

## Deterministic per-evaluation pipeline inputs
For a given market `m` at time `now`:
- metadata eligibility (Stage 0)
- Stage 1 result: `(basePass, baseReason)` from `is_base_signal_candidate(quote, cfg)`
- Stage 1 near-margin: `nearPass` from `is_near_signal_margin(quote, cfg)`
- Stage 2 result:
  - `depthOk` and/or `(depthPass, depthReason)` from `is_depth_sufficient(metrics, cfg)`
  - depth fetch/cache wrapper may fail → `depth_cache_stale_and_fetch_failed`
- gating:
  - cooldown: `now < cooldown_until_ts`
  - pending window: `now - pending_since_ts <= pending_window_seconds`

Primary reject reason selection follows the fixed priority order defined in "Reject reasons v1 (final)".

---

## Pending window resolution (timing-independent)
Pending logic uses absolute timestamps; it does not depend on loop timing.

Definitions:
- `pending_deadline_ts = pending_since_ts + pending_window_seconds`

If `status == pending_signal` and `now > pending_deadline_ts` and the market is not promoted to `signaled`:
- transition to `watching`
- clear `signals.pending_since_ts`
- increment metric (health): `pending_timeouts_count += 1` (optional)

---

## Transition table (v1)
Below, `CANDIDATE_READY` means:
- Stage 0 ok (metadata ok)
- Stage 1 basePass == true
- Stage 1 nearPass == true
- Stage 2 depth fetched/cached ok AND depthPass == true

### 1) watching → pending_signal
**Condition:** `status=watching` AND `CANDIDATE_READY` AND cooldown not active (`now >= cooldown_until_ts` or cooldown missing)

**Next:** `pending_signal`

**Mutations:**
- `signals.pending_since_ts = now`
- `signals.reason = "candidate_ready_first_hit"` (or richer string in impl)

**Counters:**
- none in TOP_REJECTS (this is not a reject)
- optional health: `pending_started_count += 1`

### 2) watching → watching (reject)
**Condition:** `status=watching` AND NOT `CANDIDATE_READY`

**Next:** `watching`

**Mutations:**
- none to state machine fields (keep as watching)
- may update `last_price`, `liquidity` timestamps/values

**Counters:**
- set `primary_reject_reason` according to the deterministic reject mapping (Stage 0/1/2/3)
- increment `rejects_last_cycle[primary_reason] += 1` and also rolling bucket
- optionally store up to 3 samples per reason

### 3) pending_signal → signaled
**Condition:** `status=pending_signal` AND `CANDIDATE_READY` AND `now <= pending_deadline_ts` AND cooldown not active

**Next:** `signaled`

**Mutations:**
- `signals.pending_since_ts = null`
- `signals.last_signal_ts = now`
- `signals.signal_count += 1`
- `cooldown_until_ts = now + candidate_cooldown_seconds` (recommended)
- `signals.reason = "candidate_ready_confirmed"` (or richer)

**Counters:**
- increment runtime signals counter(s) (e.g. `signals_created_count += 1`)

### 4) pending_signal → watching (pending expired)
**Condition:** `status=pending_signal` AND `now > pending_deadline_ts` (and not promoted)

**Next:** `watching`

**Mutations:**
- `signals.pending_since_ts = null`

**Counters:**
- do not count as TOP_REJECTS (not a market reject)
- optional: `pending_timeouts_count += 1`

### 5) pending_signal → pending_signal (still waiting)
**Condition:** `status=pending_signal` AND `now <= pending_deadline_ts` AND NOT `CANDIDATE_READY`

**Next:** `pending_signal` (no change)

**Mutations:** none

**Counters:**
- Count primary rejects exactly like `watching` does (since it is still in the pipeline)

### 6) any (watching|pending_signal) + cooldown active
**Condition:** market passes all signal conditions but `now < cooldown_until_ts`

**Next:** no state promotion

**Primary reject:** `cooldown_active`

**Mutations:** none

**Counters:**
- `cooldown_active_count += 1` (health)
- include `cooldown_active` in TOP_REJECTS only when it blocks an otherwise-ready candidate (per v1 rule)

### 7) signaled behavior under fluctuations
**Condition:** `status=signaled` and price/depth later fall below thresholds

**Next:** remains `signaled` (sticky)

**Mutations:** update `last_price` / `liquidity` values for visibility; no signal pipeline counters.

### 8) Manual transitions (out of scope logic, but state defined)
- `signaled -> traded`: set `traded.*` fields (ts, side, entry_price, shares, cost, order_id/tx_hash)
- `signaled -> ignored`: set `notes.reason_ignored` (optional)
- `signaled -> watching`: allowed (manual reset)
  - **Cooldown semantics (v1):** on manual reset, set `cooldown_until_ts = now + candidate_cooldown_seconds` to prevent immediate re-signal.

---

## Counters: where they increment
- **TOP_REJECTS**: only for `status in {watching, pending_signal}` and only `primary_reject_reason`.
- **HEALTH**: always separate; includes WS/HTTP metrics, gray_zone_count, cooldown_active_count, parse counters, rate limits.
- **Signals**: increment **only** on transition `pending_signal -> signaled`.
  - Never on `watching -> pending_signal`.
  - Never on manual resets.

---

## Loop mutations contract (v1)

### Objective
Define which state fields are updated:
- **always** on each loop (idempotent mutations)
- **only on state transitions** (side effects, exactly-once per logical event)
- **never automatically** (manual-only)

This prevents:
- overwriting trade fields
- accidentally resetting pending
- inflating counters
- changing status without explicit conditions

### Principles
- Loops can run thousands of times; "always" mutations must be safe to repeat.
- Transition mutations must happen once per logical event.
- Manual-only mutations must never be executed by Loop A or Loop B.

---

## "Always" mutations (each loop, if new data exists)

### A) last_seen_ts (Loop A)
If the market appears in Gamma discovery:
- set `last_seen_ts = now`
- never decrease `last_seen_ts`

### B) Gamma metadata (non-destructive upsert) (Loop A)
Update only if the new value is non-empty and consistent:
- slug, title, question, league, event_id, startTime, token ids

Rule:
- never overwrite existing fields with null/empty.

### C) last_price snapshot (Loop B)
If a **usable price** is obtained from WS or `/book`:
- update `last_price`:
  - `yes_best_ask`, `yes_best_bid`, `spread`, `updated_ts`, `source` (ws|http)

Rule:
- do not write `last_price` if no usable price exists.
- derived values like `price_age` are computed at render-time, not persisted.

### D) liquidity snapshot (only when Stage 2 runs and returns ok) (Loop B Stage 2)
If `get_depth_with_cache` returns ok:
- update `liquidity`:
  - `entry_depth_usd_ask`, `exit_depth_usd_bid`, `bid_levels_used`, `ask_levels_used`, `updated_ts`, `source` (cache|http)

Rule:
- never set liquidity to null when Stage 2 does not run; keep last snapshot and let `depth_age` communicate staleness.

### E) runtime counters (Loop B + status.mjs)
Update counters according to the rejects/health rules.

Rule:
- rolling buckets update only with primary outcomes per evaluation.

---

## "Transition-only" mutations (side effects)
Apply only when a transition defined in "State machine transitions (v1)" occurs.

### A) status
Change `status` only via explicit transitions:
- `watching -> pending_signal`
- `pending_signal -> signaled`
- `pending_signal -> watching` (timeout)
- `* -> expired` (TTL)
- manual transitions (see manual-only)

### B) pending fields
On entering `pending_signal`:
- `pending_since_ts = now`
- `pending_hits = 1` (if used)
- optional `pending_reason`

On staying `pending_signal` and recording an additional hit:
- `pending_hits += 1` (if used)

On leaving `pending_signal` (to watching or signaled):
- clear pending fields

Rule:
- do not clear pending unless `status` changes.

### C) cooldown_until_ts
Update `cooldown_until_ts` only:
- when entering `pending_signal`
- when entering `signaled`
- when manual reset `signaled -> watching`

Never update cooldown on normal loops without transition.

### D) signals counters
- `signals.signal_count` increments only on `pending_signal -> signaled`
- `signals.last_signal_ts` set only on `pending_signal -> signaled`
- `signals.reason` set only on `pending_signal -> signaled` and should reflect the criteria that passed at that moment

### E) ignored / expired
Ignored:
- in v1, recommended manual; if set, store `notes.reason_ignored`
Expired:
- on TTL, set `status=expired` (optional `notes.reason_expired`)

Rule:
- do not touch other fields besides status (+ optional notes).

---

## "Never automatically" (manual-only)

### A) trade fields
Loop A and Loop B must never modify:
- `traded_ts`, `side`, `entry_price`, `shares`, `cost`, `order_id/tx_hash`, trade notes

Only manual action may set trade fields.

### B) Manual reset of signaled
On manual `signaled -> watching`:
- set `cooldown_until_ts = now + candidate_cooldown_seconds`
- do not modify `signals.signal_count`
- do not clear `signals.last_signal_ts`
- optional: `notes.manual_reset_ts = now`

### C) Manual set ignored
Any state -> ignored:
- do not modify signals or trade

### D) Removing expired entries
Physical deletion `expired -> removed` should happen only during eviction/housekeeping, not inside the hot Loop B path.

---

## No-overwrite protections
- Non-destructive upsert: never overwrite with empty.
- Do not persist derived fields (`cooldown_remaining`, `price_age`, `depth_age`) — compute in `status.mjs`.
- Identity immutability: `conditionId` and token ids do not change; mismatches are health (`integrity_mismatch_count`).

---

## Global invariants and consistency rules (v1)

### Objective
Define global state invariants to:
- detect corruption or implementation bugs
- enable conservative auto-fix when safe
- keep the system calibratable without relying on logs

### Principles
Invariants are evaluated:
- on state load
- after each mutation cycle (Loop A + Loop B)
- before writing the atomic state file

When an invariant breaks:
- increment `runtime.health.integrity_violation_count`
- increment `runtime.health.integrity_violation_by_rule[rule_id]`
- apply auto-fix only if conservative and non-destructive
- if no safe auto-fix exists, mark market `ignored` with a reason or abort (by severity)

Suggested health fields:
- `runtime.health.integrity_violation_count`
- `runtime.health.integrity_violation_by_rule` (map `rule_id -> count`)
- `runtime.health.integrity_last_violation_ts`

---

## Invariants v1

### I1 — Status domain
`market.status` must be one of:
- `watching`, `pending_signal`, `signaled`, `traded`, `ignored`, `expired`

If violated:
- conservative auto-fix: `status = ignored`, `notes.reason_ignored = "invalid_status"`
- count violation `I1`

### I2 — Identity immutability
- `conditionId` never changes
- `tokens.yes_token_id` never changes once set

If violated:
- no auto-fix
- count violation `I2`
- mark `ignored` with reason `"identity_mismatch"` to avoid operating

### I3 — Pending requires timestamp
If `status == pending_signal` then `pending.pending_since_ts != null`.

If violated:
- conservative auto-fix: revert to `watching` and clear `pending`
- count violation `I3`

### I4 — Pending fields absent otherwise
If `status != pending_signal`, `pending` must be null or absent.

If violated:
- auto-fix: clear `pending`
- count violation `I4`

### I5 — Signaled requires signal metadata
If `status == signaled`:
- `signals.signal_count >= 1`
- `signals.last_signal_ts != null`

If violated:
- conservative auto-fix: revert to `watching` and set `cooldown_until_ts = now + candidate_cooldown_seconds`
- do **not** increment `signal_count`
- count violation `I5`

### I6 — signals.last_signal_ts implies signal_count
If `signals.last_signal_ts != null` then `signals.signal_count >= 1`.

If violated:
- auto-fix option (mild): set `signal_count = 1` (only if no other evidence suggests otherwise)
- conservative alternative: mark `ignored` with reason `"signals_inconsistent"`
- count violation `I6`

### I7 — Cooldown parse validity
`cooldown_until_ts` may be null or >= 0.
It may be `< now` (expired cooldown) and that is valid.

If violated (NaN / negative / not parseable):
- auto-fix: set `cooldown_until_ts = 0`
- count violation `I7`

### I8 — last_seen_ts monotonic
`last_seen_ts` must never decrease.

If violated:
- auto-fix: set `last_seen_ts = max(prev_last_seen_ts, now)` if prev exists; else `last_seen_ts = now`
- count violation `I8`

### I9 — first_seen_ts <= last_seen_ts
`first_seen_ts` must not be greater than `last_seen_ts`.

If violated:
- auto-fix: set `first_seen_ts = last_seen_ts`
- count violation `I9`

### I10 — last_price.updated_ts monotonic
If `last_price.updated_ts` exists, it must not decrease for that market.

If violated:
- conservative auto-fix: keep the max timestamp, discard the older update
- count violation `I10`

### I11 — liquidity.updated_ts monotonic
If `liquidity.updated_ts` exists, it must not decrease.

If violated:
- auto-fix: keep the max timestamp, discard the older update
- count violation `I11`

### I12 — Trade fields manual-only consistency
If `trade.traded_ts != null`, then `status` should be `traded`.

If violated:
- auto-fix: set `status = traded`
- count violation `I12`

### Optional (v1)
**I13 — Expired implies no pipeline**
If `status == expired`, do not evaluate the market for signaling.
(Operational rule; no auto-fix required.)

---

## Severity & action
High severity (ignored or abort):
- I2 identity mismatch
- repeated I1 invalid status
- persistent unparseable payloads

Medium severity (auto-fix):
- I3, I4, I5, I8, I9, I10, I11, I12

Low severity (auto-fix + health):
- I7

Notes:
- Auto-fix must be conservative: preserve data, avoid operating.
- Never touch trade fields except aligning `status=traded` (I12).
- Never increment `signal_count` as an auto-fix.

---

## Local run profile (M1 8 GB) and safety limits (v1)

### Objective
Define a safe local execution profile for a Mac M1 with 8 GB RAM:
- avoid request spikes
- keep stable latency
- protect against rate limits
- minimize disk I/O without losing consistency

### Recommended profile (defaults v1)

**Core loops**
- `gamma_discovery_seconds = 60`
- `clob_eval_seconds = 2`

**Watchlist**
- `max_watchlist = 200`
- `watchlist_ttl_minutes = 30`

**Depth**
- `depth_cache_ttl_seconds = 15`
- `max_levels_considered = 50`

**WS freshness**
- `WS_PRICE_STALE_MS = 2500`

---

## HTTP fallback and depth fetch safety
**Key rule:** never allow massive parallel `/book` bursts.

Config v1:
- `http_max_concurrency = 4`
- `http_timeout_ms = 2500`
- `http_retry_count = 0` (v1)
- `http_backoff_ms = 0` (v1)

Semantics:
- if more requests exist than `http_max_concurrency`, queue them.
- optional drop if queue exceeds limit.

### Queue limits
- `http_queue_max = 50`

If the queue exceeds the max:
- do not enqueue more
- `health.http_queue_dropped_count += 1`
- treat those markets as fetch failed for that cycle:
  - Reason A ⇒ `http_fallback_failed`
  - Reason B ⇒ `depth_cache_stale_and_fetch_failed`

### Rate limit response
On HTTP 429:
- `rate_limited_count += 1`
- `last_rate_limited_ts = now`

Optional local mitigation (without changing trading logic):
- global HTTP cooldown: `http_global_cooldown_ms = 1000` for 10 seconds after a 429

---

## Disk I/O — persist strategy
Recommendation v1:
- do not write `state/watchlist.json` every loop if nothing relevant changed.

**State dirty definition**
`dirty = true` if any occur:
- status change
- new market or eviction
- liquidity update (Stage 2 ok)
- rolling bucket update (each minute)
- manual action (trade mark or reset)

**Persist cadence**
- if dirty: persist immediately (or within 1–2 seconds)
- if not dirty: persist at most every 10 seconds, or do not persist

Health metrics:
- `runtime.health.state_write_count`
- `runtime.health.state_write_skipped_count`

---

## Process safety
- 1 process, 1 writer
- lockfile required

## Runtime memory expectations
- watchlist: 200 markets
- WS cache: per token id
- orderbooks: only when Stage 2 or HTTP fallback

This keeps resource usage low and stable.

---

## Fast calibration if things go wrong
If you see a lot of:
- `ws_stale_used_http_count` high
- `http_fallback_fail_count` high
- `rate_limited_count > 0`

Actions (in order):
1) increase `clob_eval_seconds` from 2 → 3
2) increase `depth_cache_ttl_seconds` from 15 → 20
3) decrease `max_watchlist` from 200 → 150
4) decrease `http_max_concurrency` from 4 → 2

If you see too few signals:
- decrease `min_entry_depth_usd_ask` from 1000 → 700
- decrease `near_prob_min` from 0.945 → 0.943
- increase `near_spread_max` from 0.015 → 0.018

---

## Deterministic test scenarios (v1)

### Format
Each scenario defines:
- **Given:** minimal initial state + relevant config
- **When:** cycle inputs (WS cache, `/book`, timers)
- **Then:** expected final state (status + key fields) + expected counters (rejects/health)

### Conventions used in snippets
- `now = 1_000_000`
- `EPS = 1e-6`
- Stage 1 defaults:
  - `min_prob=0.94`, `max_entry_price=0.97`, `max_spread=0.02`
  - `near_prob_min=0.945`, `near_spread_max=0.015`
- Depth defaults:
  - `min_exit_depth_usd=2000`, `min_entry_depth_usd=1000`
  - `exit_depth_floor_price=0.70`
- `WS_PRICE_STALE_MS=2500`
- `depth_cache_ttl_seconds=15`
- `candidate_cooldown_seconds=20`
- `pending_window_seconds=6`

---

## Scenario list

### S01 — WS fresh, price out of range (low)
**Given:** market `status=watching`, no cooldown. WS cache usable+fresh with `probAsk=0.930`, `probBid=0.928`, `spread=0.002`.

**When:** Stage 1 runs.

**Then:**
- no Stage 2 call
- primary reject `price_out_of_range` increments
- market stays `watching`
- `gray_zone_count` unchanged

Minimal quote:
```json
{ "ask": 0.930, "bid": 0.928 }
```

### S02 — WS fresh, spread too high
**Given:** `watching`, no cooldown. WS quote `ask=0.950`, `bid=0.920`, `spread=0.030`.

**When:** Stage 1 runs.

**Then:**
- primary reject `spread_above_max` increments
- market stays `watching`

### S03 — Base pass, near margin fail (gray zone)
**Given:** `watching`, no cooldown. WS quote `ask=0.942`, `bid=0.934`, `spread=0.008`.
- Passes base: ask in range and spread <= 0.02.
- Fails near margin: `ask < 0.945` and `spread > 0.015`.

**When:** Stage 1 runs.

**Then:**
- no Stage 2 call
- `gray_zone_count` increments
- `not_near_signal_margin` is NOT counted in default TOP_REJECTS
- market stays `watching`

### S04 — Near margin pass, Stage 2 depth pass, first hit -> pending_signal
**Given:** `watching`, `cooldown_until_ts=0`.
- WS quote `ask=0.946`, `bid=0.942`, `spread=0.004` (near margin pass by ask>=0.945)
- Depth metrics computed: `exit_depth_usd_bid=2600`, `entry_depth_usd_ask=1200`

**When:** Stage 2 runs and depth ok.

**Then:**
- transition `watching -> pending_signal`
- `pending_since_ts = now`
- `cooldown_until_ts = now + 20`
- `signals.signal_count` unchanged
- no rejects increment

### S05 — Second hit within pending window -> signaled
**Given:**
- `status=pending_signal`
- `pending_since_ts = now - 4`
- cooldown not blocking (ensure `cooldown_until_ts <= now` if cooldown is checked here)
- WS quote + depth still pass

**When:** Stage 2 runs again within `pending_window_seconds`.

**Then:**
- transition `pending_signal -> signaled`
- `signals.signal_count += 1`
- `signals.last_signal_ts = now`
- `cooldown_until_ts = now + 20`
- pending cleared

### S06 — Pending timeout -> back to watching
**Given:** `status=pending_signal`, `pending_since_ts = now - 10` (exceeds window 6s).

**When:** no successful hit occurs / evaluate pending resolution.

**Then:**
- transition `pending_signal -> watching`
- pending cleared
- no changes to `signals.signal_count`

### S07 — Cooldown active blocks transition even if conditions pass
**Given:** `watching`, `cooldown_until_ts = now + 12`.
- WS quote near margin pass
- depth metrics pass

**When:** Stage 2 would pass.

**Then:**
- no transition to `pending_signal`
- primary reject `cooldown_active` increments
- market remains `watching`
- no signals increment

### S08 — WS stale, /book fallback success used, health increments
**Given:** `watching`.
- WS cache exists but `updated_ts = now - 4000` (stale)

**When:** fallback `/book` succeeds and yields usable bid/ask and depth metrics; Stage 1 + Stage 2 proceed.

**Then:**
- `ws_stale_used_http_count += 1`
- `http_fallback_success_count += 1`
- transitions follow same rules as S04/S05 depending on depth+cooldown
- no `http_fallback_failed` reject

### S09 — WS missing, /book fallback fails with 429
**Given:** `watching`, WS cache missing.

**When:** call `/book` for Reason A (need usable price) returns 429.

**Then:**
- primary reject `http_fallback_failed` increments
- `rate_limited_count += 1`
- `last_rate_limited_ts = now`
- `http_fallback_fail_count += 1`
- market remains `watching`

### S10 — Stage 2 depth needed, cache stale, /book fails -> depth_cache_stale_and_fetch_failed
**Given:** `watching`.
- WS quote passes base + near margin
- depth cache missing or stale

**When:** call `/book` for Reason B (need depth) fails (timeout/5xx/unusable).

**Then:**
- primary reject `depth_cache_stale_and_fetch_failed` increments
- `http_fallback_fail_count += 1`
- market remains `watching`
- no pending or signaled

---

### Notes
- In S05, if implementation chooses to let cooldown block the second hit, set `cooldown_until_ts < now` in Given. The key invariant is: `pending_signal -> signaled` happens on a second valid hit within the window.

---

## Cleanup
- TTL: if `now - last_seen_ts > watchlist_ttl_minutes` ⇒ mark `expired` and remove in cleanup pass.
- Max size (200): eviction order:
  1) expired
  2) ignored
  3) traded (oldest first)
  4) remaining by oldest `last_seen_ts`

---

## Dashboard (status.mjs)
Add sections:
- **WATCHLIST**: counts by status, max size, ttl, last gamma fetch time
- **SIGNALS**: list signaled markets with:
  - slug, probBid/probAsk, spread
  - entry_depth_usd_ask, exit_depth_usd_bid
  - floor price used (0.70)
  - cooldown remaining

---

## Dashboard output spec (status.mjs)

### Objective
Show, **in console and without relying on logs**, the operational state:
- watchlist health and size,
- actionable signals,
- why markets are not signaling,
- price feed health (WS + HTTP fallback).

### Principles
- Default output must be useful in **10 seconds**.
- Verbose output only for calibration.
- Always display active thresholds/knobs.
- Never depend on external logs.

---

## Default mode
Command: `node status.mjs`

### Section order

#### 1) SUMMARY
Include what exists today (balance, open positions, PnL if available). If not available, show:
- `runtime.runs`, `runtime.last_run_ts`, estimated uptime.

#### 2) WATCHLIST
- Counts by status: `watching`, `pending_signal`, `signaled`, `traded`, `ignored`, `expired`, `total`.
- Visible config:
  - `watchlist_ttl_minutes`, `max_watchlist`
  - `gamma_discovery_seconds`, `clob_eval_seconds`
  - `depth_cache_ttl_seconds`
- Timestamps:
  - `last_gamma_fetch_ts` + age since last fetch
- Eviction info (if `total > max_watchlist`):
  - `evictions_last_cycle`
  - dominant `eviction_reason`

#### 3) SIGNALS
Show top 10 by `last_signal_ts` desc.

Columns per row:
- `league`
- `slug` (or short title)
- `probAsk`, `probBid`
- `spread`
- `entryDepthAskUsd`, `exitDepthBidUsd`
- `cooldown_remaining_s`
- `price_age_s`, `depth_age_s`

Display rules:
- prob: 3 decimals
- spread: 3 decimals
- depth: integers or 1 decimal in k (e.g. `3.4k`)
- ages: seconds with 1 decimal

Footer:
- `signals_total`, `signals_last_5min`, `oldest_signal_age_s`

#### 4) TOP_REJECTS
Counting window (v1): show **both**
- `last_cycle`
- `last_5min` (rolling buckets)

Show count + percentage:
- `reject_reason: count (pct)`

**Default v1 primary reject reasons:**
- `gamma_metadata_missing`
- `http_fallback_failed`
- `price_out_of_range`
- `spread_above_max`
- `depth_cache_stale_and_fetch_failed`
- `depth_bid_below_min`
- `depth_ask_below_min`
- `cooldown_active`

Not included in default TOP_REJECTS:
- `not_near_signal_margin` (shown in verbose + aggregated as `gray_zone_count`)
- `pending_window_missed` (metric, not a market reject)

Optional in default:
- 2–3 total samples (one-liners): `slug, reason, probAsk, spread, exitDepth, entryDepth`

#### 5) HEALTH (always show, separate from rejects)
- `cooldown_active_count`
- `gray_zone_count`
- `ws_missing_used_http_count`
- `ws_stale_used_http_count`
- `http_fallback_success_count`
- `http_fallback_fail_count`
- `gamma_metadata_missing_count`

---

## Verbose mode
Command: `node status.mjs --watchlist-verbose`

Adds sections at the end:

### 1) NEAR_SIGNALS
Top 20 markets in `watching` or `pending_signal` closest to signaling (human ranking).

Distance score v1 (guideline):
- prioritize smallest distance to:
  - `min_prob` (need_prob)
  - `max_spread` (need_spread)
  - `min_exit_depth_usd_bid` (need_exit_depth)
  - `min_entry_depth_usd_ask` (need_entry_depth)

Columns:
- `league`, `slug`
- `probAsk`, `probBid`, `spread`
- `exitDepthBidUsd`, `entryDepthAskUsd`
- short hint text, e.g.
  - `need_exit_depth +320`
  - `need_entry_depth +180`
  - `need_prob +0.004`
  - `need_spread -0.003`

### 2) REJECT_SAMPLES
3–5 samples for top reject reasons.
One-line format: `reason, slug, probAsk, spread, exitDepth, entryDepth, price_age_s`

### 3) WS_FRESHNESS
WS vs fallback health metrics:
- `markets_total_tracked`
- `ws_fresh_count`, `ws_stale_count`
- `http_fallback_success_count`, `http_fallback_fail_count`
- `avg_price_age_s`, `p95_price_age_s`

Optional:
- top 10 markets with highest `price_age_s`

---

## Compatibility notes
- Avoid fancy styling / special characters.
- Output must be readable in a simple terminal.

## Future optional flags
- `--signals-only`
- `--json`
- `--top N`

---

## Optional v1.0.1 (non-blocking)
Anti-manipulation:
- `min_bid_levels_required = 3` for exit depth (must have ≥3 distinct bid levels contributing).
