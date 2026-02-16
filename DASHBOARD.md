# Dashboard Quick Start

## How to View the Dashboard

### 1. Start the bot
```bash
cd /Users/andres/.openclaw/workspace/polymarket-watchlist-v1
node run.mjs
```

### 2. Open the dashboard in your browser
```bash
# macOS
open http://localhost:3210/

# Linux
xdg-open http://localhost:3210/

# Or just visit in any browser:
# http://localhost:3210/
```

### 3. Auto-refresh
The dashboard auto-refreshes every 5 seconds. No need to manually reload.

---

## What You'll See

### 4 Cards (Top Row)
1. **Loop** — Runs count, last cycle age
2. **Staleness** — % stale signaled markets, max stale age
3. **HTTP** — Success rate, rate limited count
4. **Persistence** — Last write age, write/skip counts

### 3 Tables (Bottom)
1. **Watchlist Status** — Count by status (watching, pending, signaled, expired)
2. **League Breakdown** — Count by league (nba, cbb, esports, soccer)
3. **Top Reject Reasons** — Most common reject reasons from last cycle

---

## Color Coding

**Green** = OK
- Loop age ≤5s
- Stale = 0%
- HTTP success ≥99%
- Write age ≤5s

**Yellow** = Warning
- Loop age 6-10s
- HTTP success 98.5-99%
- Write age 6-10s

**Red** = Alert
- Loop age >10s
- Stale >0%
- HTTP success <98.5%
- Write age >10s
- Rate limited >0

---

## Troubleshooting

### Dashboard not loading?
1. Check if bot is running: `ps aux | grep run.mjs`
2. Check if health server started: Look for `[HEALTH] HTTP server listening` in logs
3. Check port not in use: `lsof -i :3210`

### Dashboard shows stale data?
- Wait 5 seconds for auto-refresh
- Check if loop is running (last cycle age should be ≤2s)

### Want JSON instead of HTML?
```bash
curl http://localhost:3210/health | jq
```

---

## Remote Access (Secure)

**Do NOT expose to 0.0.0.0** — use SSH tunnel instead:

```bash
# From your local machine:
ssh -L 3210:localhost:3210 user@remote-server

# Then open locally:
open http://localhost:3210/
```

This keeps the dashboard secure (local-only on server, tunneled to your machine).

---

## See Also

- `HEALTH.md` — Full health monitoring documentation
- `scripts/health-check.sh` — Alerting script for cron
- `tests/health_server.test.mjs` — Test suite (18 tests)
