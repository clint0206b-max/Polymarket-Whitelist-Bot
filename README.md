# Polymarket-Whitelist-Bot

Deterministic Polymarket watchlist + signals engine.

## Commands

- Start runner: `npm start`
- Status: `npm run status`
- Verbose status: `npm run status:verbose`
- Journal stats (paper positions): `npm run journal:stats -- --since_hours 24 --only_esports true --allow_empty true`

## Notes

- Runtime state lives under `state/` (gitignored).
- This repo currently journals *paper positions* (signals) and tracks resolution via Gamma.
