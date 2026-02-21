# Duplicate Buy Bug Analysis & Fix

## Root Cause

**The trade bridge idempotency check uses `signal_id`, not `slug` or `conditionId`.**

Both paths converge on `TradeBridge.handleSignalOpen()`, which checks:
```js
const tradeId = `buy:${signal.signal_id}`;
if (this.execState.trades[tradeId]) { /* SKIP */ }
```

But `signal_id` is **different** for each caller:
- Scanner: `${Date.now()}|${market.slug}` (e.g. `1740091245000|btc-up-down`)
- Eval loop: `${Number(s.ts)}|${String(s.slug)}` (e.g. `1740091243000|btc-up-down`)

Different timestamps → different `signal_id` → different `tradeId` → **idempotency check passes for both**.

### Why the scanner's `open_index` check doesn't help

The scanner does check `open_index` by slug before buying (`global_ws_scanner.mjs:401-406`), BUT:

1. **Race condition (TOCTOU):** Scanner reads open_index, finds it empty, starts buying. Eval loop runs simultaneously, also finds open_index empty (scanner hasn't written yet), also buys.
2. **Eval loop doesn't check open_index at all** before calling `handleSignalOpen` — it only relies on trade_bridge's signal_id check.
3. The scanner writes to open_index **after** `handleSignalOpen` returns success, not before. So there's a window where both can pass.

## Fix

Add a **slug-based duplicate check** inside `TradeBridge.handleSignalOpen()` — the single chokepoint both paths must pass through. This catches duplicates regardless of `signal_id` format.

### File: `src/execution/trade_bridge.mjs`

**Add after the existing idempotency check (line ~163, after `if (this.execState.trades[tradeId])`):**

```js
    // --- Cross-source duplicate check: prevent different signal sources buying the same market ---
    // The signal_id-based check above only catches exact duplicates from the SAME source.
    // Scanner and eval loop generate different signal_ids for the same slug, so we also
    // check if ANY open (non-closed) BUY trade already exists for this slug.
    const existingBuyForSlug = Object.values(this.execState.trades).find(
      t => t.slug === signal.slug
        && String(t.side).toUpperCase() === "BUY"
        && !t.closed
        && (t.status === "filled" || t.status === "queued" || t.status === "sent" || t.status === "shadow")
    );
    if (existingBuyForSlug) {
      console.log(`[TRADE_BRIDGE] SKIP duplicate buy for slug=${signal.slug} — already have trade (signal_id=${existingBuyForSlug.signal_id}, status=${existingBuyForSlug.status})`);
      return { blocked: true, reason: "duplicate_slug" };
    }
```

### Exact diff (context lines for placement):

```diff
--- a/src/execution/trade_bridge.mjs
+++ b/src/execution/trade_bridge.mjs
@@ -160,6 +160,18 @@
       return this.execState.trades[tradeId];
     }
 
+    // --- Cross-source duplicate check: prevent different signal sources buying the same market ---
+    // The signal_id-based check above only catches exact duplicates from the SAME source.
+    // Scanner and eval loop generate different signal_ids for the same slug, so we also
+    // check if ANY open (non-closed) BUY trade already exists for this slug.
+    const existingBuyForSlug = Object.values(this.execState.trades).find(
+      t => t.slug === signal.slug
+        && String(t.side).toUpperCase() === "BUY"
+        && !t.closed
+        && (t.status === "filled" || t.status === "queued" || t.status === "sent" || t.status === "shadow")
+    );
+    if (existingBuyForSlug) {
+      console.log(`[TRADE_BRIDGE] SKIP duplicate buy for slug=${signal.slug} — already have trade (signal_id=${existingBuyForSlug.signal_id}, status=${existingBuyForSlug.status})`);
+      return { blocked: true, reason: "duplicate_slug" };
+    }
+
     // Allowlist check
     if (this.allowlist && !this.allowlist.includes(signal.slug)) {
```

## Why slug and not conditionId?

- `conditionId` is not passed to `handleSignalOpen` by either caller (scanner sends `slug`, `yes_token`, `entry_price`, `league`; eval loop sends the same).
- `slug` uniquely identifies the market in practice (each conditionId maps to one slug).
- Adding conditionId would require changing both callers. Slug is already there and stored in every trade.

## Race condition safety

Even though JS is single-threaded for synchronous code, `handleSignalOpen` is `async` — it awaits `executeBuy()`. The check-then-act pattern could theoretically fail if:
1. Call A checks → no existing trade → proceeds to mark as "queued" → awaits executeBuy
2. Call B checks → finds "queued" trade → **blocked** ✅

This works because the `execState.trades[tradeId]` is set to status "queued" **synchronously before** the async `executeBuy()`. The new slug check also reads from `execState.trades` which includes "queued" entries. So even in a concurrent scenario, the second caller will see the "queued" entry from the first caller.

**Key:** The status "queued" is written to `execState.trades` **before** the `await executeBuy()` call (line ~205). So the window between "check passes" and "trade is visible" is only synchronous JS execution — no race possible.

## Test impact

None — the fix adds a new guard in a path that existing tests don't exercise with conflicting signal sources. All 1052 tests pass as-is.
