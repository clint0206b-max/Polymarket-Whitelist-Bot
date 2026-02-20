# Plan: LoL Esports Edge Measurement & Trading Rules

> **Este plan sigue el "Plan de Análisis de Edge" — un framework de 6 pasos que aplica a todos los esports. Ver MEMORY.md para los principios universales. Cada deporte tiene su propio plan en `plans/`.**

**Objetivo:** Determinar si existe un edge tradeable en mercados LoL de Polymarket usando datos in-game de Riot Esports API, y si existe, construir reglas de trading basadas en evidencia.

**Principio:** Observar antes de tradear. No construir reglas hasta que los datos demuestren edge real.

---

## Paso 1: Edge Logger ✅ DONE

**Módulo:** `src/context/lol_esports_logger.mjs`
**Output:** `state/journal/lol_edge_log.jsonl`

### Qué hace
- **market_tick** (WS, ~5s): `recv_ts_local`, `msg_ts_raw`, `best_bid`, `best_ask`, `game_frame_age_ms`
- **game_frame** (Riot API, ~20s): gold, kills, towers, dragons, barons, inhibitors por equipo
- **HTTP /book** en candidate windows (ask 0.70-0.95, spread <0.06): top 3 levels + `depth_to_ask_plus_1c`
- **mapping**: `outcome_team_riot_id`, `riot_game_id`, `condition_id` (IDs estables, no nombres/sides)
- **outcome**: `winner_team_riot_id` (no side). Si no hay outcome (remake, pause, error) → `outcome_status: "missing"` con `reason`.

### API Sources
- **Schedule/teams:** `esports-api.lolesports.com` — public key hardcodeada del frontend (no expira)
- **Live stats:** `feed.lolesports.com` — NO necesita key. `startingTime` divisible por 10s, ≥20s detrás de now.
- **Rate limits:** No visibles. CDN cache 60s (esports-api) / 7s (feed).

---

## Paso 2: Acumular datos 🔄 EN PROGRESO

### Target
- **300-500 candidate windows con snapshot de /book, de ≥20 games distintos**
- La unidad de muestra real son los GAMES, no las windows.

### Definición de "candidate window" y "episode"
- **Window:** período continuo donde el mercado cumple criterios (ask 0.70-0.95, spread <0.06). Si sale y re-entra en <30s → misma window. Si interrupción ≥30s → windows separadas.
- **Episode:** cada sub-entrada dentro de una window. Una window con 3 re-entradas tiene 3 episodes.
- Dentro de cada window, registrar:
  - `re_entries`: cuántas veces salió y re-entró al rango
  - `time_in_range_ms`: tiempo efectivo dentro del rango
  - `time_out_range_ms`: tiempo fuera del rango dentro de la window
- Para análisis: reportar por window agrupada Y por episode. No inflar conteo pero no perder patrón de churn.

### Estado actual
- 1 game trackeado (DK vs DNS LCK Cup)
- 896 records (887 market_tick, 27 game_frame, 1 mapping)

### Criterio de suficiencia
- Trackear CUATRO métricas: **candidate windows**, **unique games**, y **airtime en cuatro niveles**
- **Airtime: CUATRO mediciones separadas:**
  - **airtime_expected:** mercados LoL listados como activos en Polymarket (Gamma API: `active=true`, `closed=false`). "Mercados existen."
  - **airtime_seen:** market_ticks recibidos. Tiempo activo descontando gaps >5min. "Nuestro collector los vio."
  - **airtime_opportunity_loose:** horas donde ≥1 mercado tuvo bid/ask válido, sin filtrar por spread ni ask range. "El mercado estaba vivo."
  - **airtime_opportunity_strict:** horas donde ≥1 mercado tuvo ≥1 tick en candidate range (ask 0.70-0.95, spread <0.06). "Mercados generaron ventanas con nuestros filtros."
  - Si `airtime_seen / airtime_expected < 0.7` → collector roto. FIXEAR, no declarar "no tradeable".
- **Gate de suficiencia mira loose primero, strict después:**
  - Si opportunity_loose bajo → realmente no hay mercado. ESPERAR o PARAR.
  - Si opportunity_loose alto pero strict bajo → mercado existe pero filtros son demasiado estrechos. Revisar definición de candidate range ANTES de declarar "no tradeable".
  - Si opportunity_strict ≥ 50h Y windows < 100 → no tradeable con filtros actuales.
- **Mínimo 20 unique games** para que métricas por-game tengan sentido
- Suficiente: opportunity_strict ≥ 50h Y windows ≥ 300 Y games ≥ 20 Y ratio seen/expected ≥ 0.7

### Games sin outcome
- NO descartar silenciosamente. Loguear como `outcome_status: "missing"` con `reason` (remake, pause, API error, unknown).
- Excluir de calibración y backtest, pero reportar frecuencia.
- Si frecuencia de missing > 5% → flag de problema en pipeline/logger. Investigar antes de analizar.

### Qué monitorear
- Candidate windows acumuladas (y episodes)
- Cuatro niveles de airtime (expected, seen, opportunity_loose, opportunity_strict) y ratios
- Unique games (mappings)
- Windows per game (distribución — ¿hay games que dominan?)
- Games con outcome_status missing (frecuencia y reasons)
- Distribución de game_frame_age_ms

---

## Paso 3: Análisis de edge

### Prerrequisito: criterio de suficiencia del Paso 2 + chequeo de integridad

### Paso 0: Chequeo de integridad (antes de cualquier análisis)

**Correr ANTES de tocar DuckDB. Si falla, no analizar.**

1. **Mapping único por riot_game_id** — si hay duplicados, el join está roto
2. **Outcome presente para cada game** — sin outcome no hay P(win). Games con `outcome_status: "missing"` → excluir de análisis, reportar frecuencia.
3. **Coherencia outcome_team_riot_id con winner_team_riot_id** — el team del outcome tiene que ser uno de los del mapping
4. **Coherencia de clocks** — verificar que `recv_ts_local` y `msg_ts_raw` no diverjan >5s en promedio. Si divergen, los time segments pueden estar mal asignados. Reportar drift promedio y máximo.
5. **Collector health** — ratio airtime_seen/expected ≥ 0.7. Si no, la muestra está sesgada.
6. **Segment sanity check** — distribución de duración total por game (calculada con timestamps de Riot). LoL dura ~25-45 min. Games con duración calculada <15 min o >60 min → excluir de análisis por segmentos (assignment no confiable). Reportar cuántos games se excluyen.
7. Si cualquiera falla → fixear datos o descartar games corruptos antes de analizar

### Regla transversal: dos vistas, game×segment como principal

**TODAS las métricas se reportan en:**

- **Por window** (y por episode cuando aplica) — granular, más datos, pero autocorrelación intra-game
- **Por game×segment** — promediar cada métrica dentro de (game, time_segment) primero, después distribución entre game×segments

**Los decision gates miran game×segment como principal.** No promediar un game entero — un game tiene fases eficientes y fases con edge. Promediar game completo apaga edge que existe solo en mid-game o post-baron.

**Segmentos de tiempo:** early (0-15min), mid (15-25min), late (25min+)
- **Preferir timestamp de Riot del frame como clock absoluto** para asignar segmentos. El feed de Riot devuelve timestamp por frame — usarlo directamente.
- **Fallback:** si el timestamp de Riot no está disponible, usar contador de frames × intervalo promedio observado. Pero marcar esos games como "segment_clock: derived" para separar en análisis.
- **NO usar clock local** (mezcla de clocks con Riot API).

**Bucket adicional: playoffs vs regular season.** El comportamiento del mercado cambia entre ambos. Reportar separado para no contaminar.

---

### 3d. Feasibility gate (VA PRIMERO)

**Dos cortes:**

1. **p25 de `depth_to_ask_plus_1c`**
2. **Share de windows con depth sostenido ≥ $15**

**"Sostenido" = depth ≥ $15 durante ≥8-10 segundos** medido con `recv_ts_local`. No por ticks — la cadencia del WS varía (5s normal, <1s en momentos calientes). 2 ticks a 1s no es comparable con 2 ticks a 5s.

**Segmentar por:**
- **ask_bin** — liquidez cambia por rango de precio
- **time_segment** (early/mid/late)
- **playoffs vs regular**

**$15 benchmark inicial.** Ajustar después.

**Vista:** game×segment.

**Decisión gate:** Share promedio por game×segment de depth sostenido ≥ $15 < 10% → PARAR.

### 3a. Calibración

**TRES calibraciones en paralelo:**

- **A (Global):** Todos los market_ticks con outcome resuelto. Sin filtros.
- **B (Triggered strict):** Candidate windows con depth sostenido ≥ $15, spread < 0.06.
- **B2 (Triggered loose):** depth ≥ $5, spread ≤ 0.10. No es para tradear — es para mapear dónde vive el edge y detectar si está concentrado en condiciones "feas" que B descarta.

**Implied probability:**
- **A:** Usar **mid** cuando spread es chico. Reportar P(win) vs ask Y P(win) vs mid, segmentado por spread bucket. Ask en spread enorme no es creencia del mercado, es cotización protectiva.
- **B y B2:** Usar ask (comprás al ask, spread ya filtrado en cada caso).

**Dimensiones:**
- Bins de precio: 0.70-0.75, 0.75-0.80, 0.80-0.85, 0.85-0.90, 0.90-0.95
- Time segment: early/mid/late
- `game_frame_age_ms` como covariable por buckets (0-15s, 15-30s, 30-60s), no filtro
- Playoffs vs regular

**Vista principal: game×segment.** Dentro de cada (game, segment) calcular P(win) y implied, después agregar across games dentro del mismo segment.

**Riesgos de autoengaño:**
1. Sin segmentar por tiempo → "edge" = late-game convergence
2. Solo B → matás edge en condiciones feas. Solo A → ves edge incapturable
3. Ask como implied en A con spreads enormes → "edge" = spread tax
4. **Multiple testing:** 5 bins × 3 segments × 3 calibraciones = 45 combinaciones. Control de consistencia obligatorio.

**Decision gate (game×segment) — requiere consistencia adaptativa:**
- Ni A, B, ni B2 positivas → PARAR
- A positiva, B no, B2 no → no hay edge capturable en ninguna condición → PARAR
- A positiva, B no, B2 sí → **edge existe en condiciones feas.** Evaluar: ¿se puede adaptar ejecución (sizing más chico, spread tolerance mayor)? Si sí → redefinir B con nuevos thresholds y re-evaluar. Si no → PARAR.
- B positiva → edge capturable en condiciones limpias. Requiere consistencia:
  - El mismo bin×segment debe ser positivo en **al menos 2 de las validaciones que apliquen:**
    1. **Playoffs vs regular** — solo aplica si ambos tienen ≥5 games. Si no → reemplazar por **bootstrap por game** (resamplear games con reemplazo N veces, efecto positivo en ≥80% de resampleos).
    2. **Primera mitad temporal vs segunda mitad** — siempre aplica (split por fecha).
    3. **Vista game×segment vs vista por window** — siempre aplica.
  - Mínimo 2 validaciones siempre aplican (temporal + vistas). Si las 3 aplican, ≥2 de 3.
  - Si solo pasa 1 → probable falso positivo → NO continuar.

### 3b. Slippage

- `max_fill_usd_at_ask_plus_1c` por snapshot
- p25, p50, p75
- **Sizing target = p25**
- Segmentar por ask_bin, time_segment, playoffs/regular
- Vista: game×segment

### 3c. Drift adverso

- Desde primer market_tick que vio criterio cumplido
- Mid price en T+5s, T+30s, T+60s
- `game_frame_age_ms` como covariable por buckets, no filtro
- **Condicionar a fillable:** depth sostenido ≥ $15

**Drift threshold = costo TOTAL:**
```
drift_threshold = spread/2 + fee_roundtrip + slippage_esperado
```
Slippage esperado (el +1c de fill) es PARTE del costo. Calcular por ask_bin al analizar.

**Vista:** game×segment.

**Decision gate:** Drift mediano por game×segment > costo total → PARAR o ajustar.

### 3e. Tasa de oportunidad

- Windows (y episodes) por game×segment que pasan TODOS los filtros
- Reportar ambos: tasa por window agrupada y tasa por episode
- Agregar: promedio across games
- Si < 1 por game → ¿justifica desarrollo?

**Input, no hard gate.**

---

## Paso 4: Definir reglas de trading

**Solo si Paso 3 OK en vista game×segment.**

### 4a. Context gate
- Gold lead threshold de calibración segmentada
- Game time mínimo del segmento con edge
- Objetivos como features si agregan señal
- `game_frame_age_ms` threshold de buckets

### 4b. Entry range
- Bins con P(win) - implied > threshold
- Dinámico según game state

### 4c. Sizing
- p25 de slippage por ask_bin × time_segment
- Nunca más que p25 sin mover >1c

### 4d. Stop-loss
- Derivar de volatilidad intra-partida del mid. No número mágico.
- Movimiento del mid en ventanas de 1min, 5min, 10min
- SL = fuera de rango normal (>2 std)

---

## Paso 5: Backtest

### Execution model (obligatorio, no negociable)
- **Entrada:** al ask. No al mid, no al "precio teórico".
- **Salida:** al bid. No al mid, no al ask.
- **Fill:** solo si depth sostenido ≥ sizing target en ese tick. Si no hay depth → no hay fill, trade no cuenta.
- **Fees:** en ambos lados (entry + exit). Fee real de Polymarket CLOB.
- **Slippage:** si sizing > depth al ask, excedente llena al ask+1c (o no llena).
- **Delay:** p75 del gap entre ticks consecutivos para ese mercado + penalty fijo de ejecución (submit + matching + competencia). Calibrar penalty con datos reales de latencia del bot (medir tiempo entre submit y fill en trades live). Si no hay datos al momento del backtest → penalty mínimo de 2 segundos. El simulador NUNCA asume fill en el mismo tick de la señal.

**Si el simulador no respeta estos 6 puntos → resultados no válidos.**

### Metodología
- **Walk-forward:** split por tiempo (fecha), no por games. Primera mitad define, segunda valida. Si hay regime change (meta shift, patch) entre mitades, eso es información — reglas que no sobreviven un patch no son robustas.
- **Significancia por game×segment**, no por window
- PnL con gate vs sin
- Métricas: win rate, avg PnL, max drawdown

---

## Paso 6: Deploy

1. Context gate en pipeline
2. Tests
3. **Shadow mode** — loguear, NO ejecutar
4. Shadow hasta acumular **≥10 señales shadow** o ≥2 semanas (lo que llegue primero). Calendario fijo solo no valida.
5. Si valida → live
6. Post-deploy: review si **win rate diverge >15pp O avg PnL diverge >30% del backtest, sobre ≥20 trades live.** Si <20 trades → esperar antes de declarar divergencia.

---

## Decision Gates

```
Paso 2: ¿opportunity_strict ≥ 50h, windows ≥ 300, games ≥ 20, ratio seen/expected ≥ 0.7?
  → ratio < 0.7: collector roto. FIXEAR.
  → opportunity_loose bajo: no hay mercado. ESPERAR o PARAR.
  → opportunity_loose alto, strict bajo: filtros demasiado estrechos. REVISAR RANGOS.
  → opportunity_strict ≥ 50h, windows < 100: no tradeable. PARAR.
  → Cumple todo: continuar.

Integridad: ¿Mapping único, outcomes presentes, IDs coherentes, clocks alineados,
            collector healthy, segment durations sane?
  → Falla: fixear o descartar games corruptos.
  → Games con outcome missing > 5%: investigar pipeline.
  → Games con duración <15min o >60min: excluir de segment analysis.

3d Feasibility (game×segment): ¿Share depth sostenido ≥ $15 > 10%?
  → NO: PARAR.
  → SÍ: continuar.

3a Calibración (game×segment): ¿Positiva con consistencia adaptativa?
  → Ni A, B, ni B2: PARAR.
  → A sí, B no, B2 no: no capturable. PARAR.
  → A sí, B no, B2 sí: edge en condiciones feas. Adaptar ejecución o PARAR.
  → B sí pero solo 1 validación: falso positivo probable. NO continuar.
  → B sí en ≥2 validaciones: continuar.

3c Drift (game×segment): ¿< costo total en ventanas fillables?
  → NO: PARAR o ajustar.
  → SÍ: continuar.

3e Tasa oportunidad (windows + episodes): input para ROI.

5 Backtest: ¿Walk-forward (execution model realista, significancia por game) profit?
  → NO: volver a 4 o PARAR.
  → SÍ: deploy.

6 Post-deploy: ¿WR diverge >15pp O avg PnL >30% vs backtest sobre ≥20 trades?
  → SÍ: pausar, revisar.
  → NO: seguir.
```

---

## Datos post-STOP

Si el plan se detiene en cualquier gate, los datos recolectados se conservan. El logger sigue corriendo. Si las condiciones cambian (más liquidez, nuevo season, meta shift), se puede re-evaluar desde el gate donde se paró sin perder lo acumulado.

---

## Secuencia de ejecución

1. Logger corriendo ✅ — acumulando datos automáticamente
2. Cuando haya suficientes datos → Paso 0 integridad → 3d feasibility
3. Si feasibility pasa → calibración (A + B + B2) + slippage + drift + tasa oportunidad
4. Si todo OK → definir reglas → backtest → shadow → live
5. Si feasibility falla → LoL descartado, pivotar a Dota2 (que ya debería tener datos acumulados)
