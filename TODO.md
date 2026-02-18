# TODO — Polymarket Watchlist Bot v1

Generado 2026-02-17 a partir de review completa (score: 7/10).
Objetivo: llevar el bot de buen MVP a sistema confiable con edge validado.

---

## P0 — Bugs (arreglar ya)

- [x] **CBB "roto"**: Resultó que funciona correctamente. Markets entran al watchlist (13 activos), pero el context gate `cbb_gate:not_final_period` los rechaza hasta que estén en período final. Comportamiento esperado del blocking mode. (2026-02-17)

## P1 — Estrategia (validar el edge)

- [ ] **Backtesting**: Guardar snapshots de books/prices cada eval cycle para poder replay histórico. Simular señales con parámetros alternativos sobre data real.
- [ ] **Más data**: Necesita 200+ trades para distinguir alpha de varianza. Revisar si los filtros son demasiado restrictivos (solo 25 trades en el período live).
- [ ] **Parameter optimization**: Con suficiente data, sweep de `min_prob`, `max_spread`, `pending_window_seconds` para maximizar EV.
- [ ] **League-specific parameters**: Los esports, NBA y CBB tienen dinámicas distintas. Permitir overrides por league (spreads, depth, entry prices).

## P2 — Monitoring & Alerting (no depender de mirar manualmente)

- [ ] **Alerta de inactividad**: Si el bot no genera señales en X horas durante horario activo, notificar por Telegram.
- [ ] **Alerta de anomalías**: Spike de rechazos, WS disconnects prolongados, 0 markets en watchlist → Telegram.
- [ ] **Daily P&L digest**: Resumen diario automático por Telegram (trades, WR, PnL, balance). Zero AI tokens (código nativo).
- [ ] **Health check externo**: Ping al health endpoint desde fuera (cron simple o uptime monitor).

## P3 — Funcionalidad

- [ ] **Coverage report**: Agregar `c8` o similar para medir cobertura de tests. Target: >80%.
- [ ] **Log rotation**: Los JSONL crecen indefinidamente. Rotar por día o tamaño.
- [ ] **Auto-recovery mejorado**: Si el bot crashea y el lockfile queda, recovery automático (watchdog).
- [ ] **`signal_open` con campo `league`**: Ya se agregó a `signal_close`, falta en open. Backfill existentes.
- [ ] **Limpiar `_deprecated_entry_rules`**: Scheduled para borrar después de 2026-03-01.
- [ ] **Dashboard mejorado**: El HTML actual es básico. Agregar PnL chart, funnel visualization, trade history.

## P4 — Documentación & Proceso

- [ ] **Trading decisions doc**: Documentar por qué se eligieron estos parámetros, qué alternativas se evaluaron, qué data soporta cada decisión.
- [ ] **Runbook**: Qué hacer cuando algo falla (bot down, API down, balance bajo, trade stuck).
- [ ] **Refactor archivos grandes**: `loop_eval_http_only.mjs` y `trade_bridge.mjs` son los más largos. Extraer sub-módulos.

---

## Completados ✅

- [x] ESPN context habilitado para CBB/NBA (2026-02-17)
- [x] `min_entry_depth_usd_ask` bajado a 500 (2026-02-17)
- [x] Telegram notifications en BUY/SELL (2026-02-17)
- [x] `league` en `signal_close` entries (2026-02-17)
- [x] Depth filter tests (2026-02-17)
- [x] Journal backup cron diario (2026-02-17)
- [x] DuckDB analytics setup (2026-02-17)
