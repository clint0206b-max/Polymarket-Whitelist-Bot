# Plan: Dota2 Esports Edge Measurement & Trading Rules

> **Este plan sigue el "Plan de Análisis de Edge" — framework de 6 pasos. Ver MEMORY.md para principios universales.**

**Objetivo:** Determinar si existe un edge tradeable en mercados Dota2 de Polymarket usando datos in-game de OpenDota API, y si existe, construir reglas de trading basadas en evidencia.

**Principio:** Observar antes de tradear. No construir reglas hasta que los datos demuestren edge real.

---

## Hipótesis de edge (explicitar ANTES de medir)

**¿Por qué habría edge en Dota2 usando OpenDota?**

OpenDota es la API pública más conocida del ecosistema Dota2. A diferencia de la Riot Esports feed (nicho), es probable que market makers y bettors sofisticados ya la usen. Eso reduce la probabilidad previa de encontrar edge informacional.

**Hipótesis a testear (en orden de plausibilidad):**

1. **Ineficiencia de mercado:** Los participantes de Polymarket en esports NO usan datos in-game en absoluto — tradean por intuición/stream. Si es así, cualquier señal in-game sistemática tiene edge.
2. **Interpretación superior:** Los datos brutos (gold, kills) no se interpretan bien. Contexto (draft, timing, magnitud de ventaja) agrega señal que el precio no refleja.
3. **Timing lag:** El mercado reacciona a eventos con delay medible (>30s). Si la reacción es lenta, hay ventana para entrar.
4. **Hero draft + game state combinado:** La composición de héroes cambia la interpretación del gold lead. Esto es conocimiento especializado que la mayoría no automatiza.

**La calibración A (global) testea hipótesis 1.** Si el precio ya refleja game state → A no será positiva → no hay edge con datos públicos.

**La calibración B testea hipótesis 2-4.** Si B es positiva pero A no → hay edge en ejecución/interpretación, no en información cruda.

**Prior honesto:** La probabilidad de encontrar edge es MENOR que en LoL. El plan debe ser eficiente en descartarlo rápido si no existe.

---

## Diferencias clave vs LoL

### Lo que OpenDota ofrece (gratis)
- `GET /api/live` — matches en vivo
- Por match: **kills por equipo, gold lead neto, duration (game clock)**
- **Players array con hero_id** — composición de draft (VERIFICAR en Paso 0.5)
- Rate limits: 60 req/min sin key, 1200/min con key gratis

### Lo que OpenDota NO ofrece
- Towers/barracks/high ground
- Roshan timer / Aegis status
- Buyback availability
- Net worth por héroe (solo gold lead neto agregado)
- Items, cooldowns, ultimates

### Riesgo fundamental: cobertura de pro matches
- OpenDota `/api/live` puede no cubrir todos los matches pro que Polymarket lista
- Esto debe verificarse ANTES de construir el logger completo (ver Paso 0.5)

---

## Paso 0.5: Verificación de viabilidad técnica 🔲 PENDIENTE

**ANTES de construir el logger. Cuesta ~30 min de investigación, puede ahorrar horas de desarrollo.**

### Qué verificar

1. **¿OpenDota `/api/live` muestra pro matches?**
   - Hacer polls durante 2-3 días con matches pro (verificar en Liquipedia schedule)
   - Contar: matches pro visibles / matches pro en calendario
   - **Cobertura global Y por liga.** Puede que global sea <30% pero una liga grande (ESL, DPC) tenga >80%. Eso es suficiente para un piloto acotado a esa liga.
   - Si cobertura global < 30% Y ninguna liga individual > 50% → PARAR o buscar alternativa (Stratz, Steam GC).
   - Si cobertura global < 30% PERO ≥1 liga con >50% → viable como piloto restringido a esa liga. Ajustar targets de Paso 2 a mercados de esa liga.

2. **¿El response incluye `players` con `hero_id`?**
   - Si sí → hero draft es un feature disponible (mucho más fuerte que solo gold/kills)
   - Si no → estamos limitados a kills + gold + duration

3. **¿`duration` es game time o wall time?**
   - Si incluye pausas → necesitamos detectar pausas (duration no avanza entre polls) y descontar
   - Si es game time puro → usable directo para segmentos

4. **¿El response tiene algún timestamp interno del estado?**
   - Si sí → `data_age_ms` es medible directamente
   - Si no → `data_age_ms = null`, solo `poll_age_ms` como proxy

5. **Latencia real: ambos lados**
   - **Lado OpenDota:** Medir p50 y p95 de response time durante los polls de prueba. Si p95 > 10s → polling de 30s da <20s de ventana útil.
   - **Lado Polymarket:** Medir drift del mid price a T+5s y T+30s después de eventos grandes de gold/kills (delta gold >3k o delta kills >3 entre polls). Si el mercado se mueve más lento que tu polling, seguís teniendo ventana aunque OpenDota sea lento. **La latencia que importa es la relativa: tu delay vs delay del mercado en reaccionar.**

### Script de verificación

Hacer un script simple que:
- Pollee `/api/live` cada 30s durante horas pico de pro matches
- Guarde raw JSON con timestamps
- Cruce con calendario de Liquipedia para coverage por liga
- Al final: reporte cobertura (global + por liga), campos disponibles, latencia (p50/p95), response size

**Decision gate:**
- Cobertura pro global < 30% Y ninguna liga > 50% → PARAR o buscar alternativa.
- hero_id no disponible → continuar con gold/kills/duration pero prior más bajo.
- duration incluye pausas sin forma de detectarlas → segment assignment no confiable. Evaluar impacto o PARAR.
- Latencia OpenDota p95 > 10s Y mercado reacciona en <5s a eventos → sin ventana. PARAR.
- Latencia OpenDota p95 > 10s PERO mercado reacciona en >30s → ventana existe pese a latencia. Continuar.

---

## Paso 1: Edge Logger 🔲 PENDIENTE (post Paso 0.5)

**Módulo:** `src/context/dota2_opendota_logger.mjs`
**Output:** `state/journal/dota2_edge_log.jsonl`

### Tipos de registro

- **market_tick** (WS, ~5s): `recv_ts_local`, `msg_ts_raw`, `best_bid`, `best_ask`, `poll_age_ms`
- **game_frame** (OpenDota API, ~30s polling):
  - `radiant_score`, `dire_score` (kills)
  - `radiant_gold_adv` (gold lead neto)
  - `duration` (game clock en segundos)
  - `hero_ids` (array de hero_id por team, SI disponible — ver Paso 0.5)
  - `poll_age_ms`, `data_age_ms`
- **HTTP /book** en candidate windows (ask 0.70-0.95, spread <0.06): top 3 levels + `depth_to_ask_plus_1c`
- **mapping**: `match_id` (OpenDota), `condition_id` (Polymarket), `market_type` (map_specific | match_series), team names, team sides (radiant/dire), `mapping_signals`
- **outcome**: `winner` (radiant/dire). Missing → `outcome_status: "missing"` con `reason`.

### Campos de edad: poll_age_ms vs data_age_ms

- **poll_age_ms**: `recv_ts_local - last_poll_ts`. Staleness del polling.
- **data_age_ms**: Si hay timestamp interno en payload → `recv_ts_local - data_internal_ts`. Si no → `null`.
- **NUNCA mezclar semánticas.** En análisis, buckets separados.

### Matching Polymarket ↔ OpenDota (multi-señal)

**TODOS deben cumplirse:**

1. **Team names** — fuzzy match (Levenshtein o similar). Ambos teams.
2. **League/tournament** — si disponible, compatible con market title.
3. **Temporal alignment** — match activo dentro de ±2h del primer market_tick.
4. **match_id estable** — presente en ≥3 polls consecutivos.

Loguear `mapping_signals` con qué criterios pasaron/fallaron.
**Si no se puede mapear con confianza → NO mapear.** Mejor perder datos que contaminar.

### Unidad de verdad: serie vs mapa

- **map_specific** → mapea directo a match_id ✅
- **match_series** → EXCLUIDO de este pipeline. Loguear como `excluded_series_market`.
- **Journal separado de series excluidas:** `state/journal/dota2_excluded_series.jsonl` con `condition_id`, `market_title`, `tournament`, `timestamp`. Count por torneo para decidir si vale construir pipeline de series después. Si >50% de mercados son series → el pipeline de mapas cubre poco.

### Política de datos parciales (OpenDota down mid-match)

- Si OpenDota deja de responder >5 min durante un match activo → marcar como `data_gap: true` con timestamps del gap.
- Match sigue siendo válido para market_ticks (WS no depende de OpenDota).
- Para calibración por game state (gold, kills): excluir los segmentos del gap. No inventar interpolación.
- Si gap > 50% del match → excluir match completo de análisis de game state. Mantener para análisis de precio solo.

### Detección de pausas (si duration incluye wall time)

- Si duration no avanza entre 2+ polls consecutivos (delta ≤ 5s en >60s real) → match pausado.
- Descontar paused time de segment assignment.
- Loguear `pause_detected: true` con duración.

### Clock / Timestamps
- `duration` de OpenDota como clock para time segments (post validación en Paso 0.5).
- **Sanity check de monotonicidad:** duration debe crecer entre polls. Resets o saltos >60s hacia atrás → `segment_clock: corrupt`, excluir de segments.

### Segmentos de tiempo (Dota2)
- **early:** 0-15 min (laning phase)
- **mid:** 15-30 min (mid game, teamfights, Roshan timing)
- **late:** 30 min+ (late game, high ground, buyback fights)
- **Sanity check:** duration final <20 min o >80 min → excluir de segment analysis.

---

## Paso 2: Acumular datos

Mismo framework que LoL. Mismos targets (300-500 candidate windows, ≥20 games), misma definición de windows/episodes.

### Airtime: CINCO mediciones

1. **airtime_expected_polymarket:** mercados Dota2 activos en Polymarket (Gamma). "Mercados existen."
2. **airtime_expected_opendota_coverage:** proporción de esos mercados mapeados a match_id válido. "OpenDota cubre."
3. **airtime_seen:** market_ticks recibidos. "Collector los vio."
4. **airtime_opportunity_loose:** horas con ≥1 mercado mapeado con bid/ask válido. "Mercado vivo."
5. **airtime_opportunity_strict:** horas con ≥1 tick en candidate range. "Generó ventanas."

**Diagnósticos:**
- `seen / expected_polymarket < 0.7` → collector roto. FIXEAR.
- `opendota_coverage / expected_polymarket` baja → limitación de fuente. Reportar ligas perdidas. **NO es collector roto.**
- `opportunity_loose` alto, `strict` bajo → filtros estrechos. **No cambiar rangos por intuición.** Ver mini-gate abajo.

### Mini-gate para ajuste de rangos

**Si opportunity_loose alto Y opportunity_strict bajo:**
1. Generar histograma de spreads y asks en las horas de opportunity_loose (solo ticks con bid/ask válido).
2. Identificar dónde se concentra la actividad real: ¿spreads de 0.06-0.10? ¿asks de 0.65-0.70?
3. Elegir nuevos thresholds de candidate range basados en el histograma — con datos, no intuición.
4. Recalcular opportunity_strict con nuevos thresholds.
5. Si sigue bajo → el mercado tiene actividad pero no genera ventanas útiles en ningún rango razonable. PARAR.

### Mercados match_series excluidos
Reportar cantidad y proporción por torneo (del journal separado). Si >50% → evaluar pipeline de series o PARAR.

### Diferencia en granularidad
Polling 30s → ~2 game_frames/min (vs ~12 en LoL con WS). Candidate windows tienen menos data points. Ajustar expectativas.

---

## Paso 3: Análisis de edge

### Paso 0: Chequeo de integridad

Todo lo de LoL MÁS:

1. **Mapping único por match_id**
2. **Outcomes presentes** (missing → excluir, reportar frecuencia)
3. **Coherencia de sides** — winner debe ser radiant o dire del mapping
4. **market_type = map_specific** — si hay match_series en mapping → error en logger
5. **Clock coherence** — `recv_ts_local` vs `msg_ts_raw` drift < 5s promedio
6. **Duration monotonicidad** — debe crecer entre polls. Resets → excluir de segments.
7. **Pausas detectadas** — reportar frecuencia y duración total. Si paused_time > 20% del match → excluir de segments.
8. **Segment sanity** — duration <20 min o >80 min → excluir
9. **OpenDota coverage** — ratio coverage/expected, global Y por liga. Si global < 0.3 → muestra sesgada. Advertir.
10. **Mapping multi-señal** — revisar `mapping_signals`. Mappings con pocas señales → candidatos a falso positivo. Revisar manualmente.
11. **Data gaps** — matches con `data_gap: true`. Si gap > 50% → excluir de game state analysis.
12. **Hero data completeness** — si hero_id disponible: ¿presente en todos los frames? Matches sin hero data → excluir de análisis de draft.

### Regla transversal: dos vistas, game×segment como principal

Idéntico a LoL.
Segmentos: early (0-15min), mid (15-30min), late (30min+).
Clock: `duration` de OpenDota (game time, descontando pausas).

### 3d. Feasibility gate — idéntico a LoL

Depth sostenido ≥ $15 por game×segment. Share < 10% → PARAR.

### 3a. Calibración

**Tres calibraciones: A, B, B2.**

**Implied probability:**
- **A (Global):** mid cuando spread chico. P(win) vs ask Y vs mid, por spread bucket.
- **B (Triggered strict):** depth ≥ $15, spread < 0.06. Ask como implied.
- **B2 (Triggered loose):** depth ≥ $5, spread ≤ 0.10. Ask. Para mapear dónde vive el edge.

**Dimensiones base:**
- Bins de precio: 0.70-0.75, 0.75-0.80, 0.80-0.85, 0.85-0.90, 0.90-0.95
- Time segment: early/mid/late
- `poll_age_ms` / `data_age_ms` como covariables por buckets
- Playoffs vs regular

**Features exploratoria de game state (NO bins del gate principal):**

- **gold_adv_sign:** ¿team del mercado va ganando o perdiendo en gold? Binario.
- **abs_gold_adv bucketed:** 0-2k, 2k-5k, 5k-10k, >10k
- **kill_lead_sign:** ¿ganando o perdiendo en kills?
- **abs_kill_lead bucketed:** 0-3, 3-7, 7-15, >15
- **gold_momentum:** delta de gold_adv entre polls consecutivos (¿se está ampliando o cerrando la ventaja?)
- **Hero draft cluster** (si hero_id disponible): agrupar drafts por archetype (early-game vs late-game scaling, teamfight vs split-push). No bins de hero_id individual — demasiada dimensionalidad.

**Análisis de "cruce de cero":**
El edge puede vivir en el momento de inflexión — cuando gold_adv cruza de negativo a positivo (o viceversa). Definir concretamente:
- `gold_crossing`: gold_adv cambió de signo entre 2 polls consecutivos Y |delta| > 1k (evitar ruido de oscilación en cero)
- Medir P(win) en ticks inmediatamente post-cruce vs implied. Si hay asimetría → señal.

**Advertencia de dimensionalidad:** 5 price × 3 segments × 2 signs × 4 magnitudes = 120 solo para gold. Agregar draft clusters multiplica más. Control de consistencia CRÍTICO. No pescar.

**Decision gate — consistencia adaptativa (idéntico a LoL):**
- Ni A, B, ni B2 positivas → PARAR
- A sí, B no, B2 no → no capturable → PARAR
- A sí, B no, B2 sí → edge en condiciones feas. Adaptar o PARAR.
- B sí → ≥2 de 3 validaciones (playoffs/regular, temporal split, game×segment vs window)

**Gate "features insuficientes" — medible, no binario:**

Comparar baseline "precio solo" vs "precio + game state features":
- **Baseline:** calibración usando solo price bins × time segments (sin gold, kills, draft). Esto mide cuánto predice el precio por sí solo.
- **Con features:** calibración agregando gold_adv, kills, momentum, draft como covariables.
- **Test:** ¿el agregado de features reduce error de calibración (diferencia entre P(win) observada vs implied) de forma consistente por game×segment?
- **Consistencia:** la mejora debe aparecer en ≥2 de 3 validaciones (temporal split, game×segment vs window, bootstrap si aplica).
- **Si no mejora consistentemente → features no agregan señal sobre precio → PARAR.**

No requiere modelo sofisticado. Es comparar tablas de calibración con y sin features. Si la tabla con features no está mejor calibrada, los features son ruido.

### 3b. Slippage — idéntico a LoL

- `max_fill_usd_at_ask_plus_1c` por snapshot
- p25, p50, p75
- Sizing target = p25
- Segmentar por ask_bin, time_segment, playoffs/regular
- Vista: game×segment

### 3c. Drift adverso

**Adaptado a polling de 30s:**
- Precio (market_tick WS): drift a T+5s, T+30s, T+60s — medible directamente ✅
- **Correlación con game state:** solo medible a resolución de ~30s (polling). No intentar atribuir drift de 5s a cambio de game state — no tenemos esa resolución.
- Drift condicional: "drift en ticks donde el poll anterior mostraba gold_adv creciendo vs decreciendo". Resolución gruesa pero honesta.
- Condicionar a depth sostenido ≥ $15.

**Drift threshold = spread/2 + fee_roundtrip + slippage_esperado.** Idéntico a LoL.

**Vista:** game×segment.

**Decision gate:** Drift mediano por game×segment > costo total → PARAR o ajustar.

### 3e. Tasa de oportunidad — idéntico a LoL

- Windows (y episodes) por game×segment que pasan TODOS los filtros
- Reportar tasa por window agrupada Y por episode
- Promedio across games
- Si < 1 por game → ¿justifica desarrollo?
- Input, no hard gate.

---

## Paso 4: Definir reglas de trading

**Solo si Paso 3 OK en vista game×segment.**

### 4a. Context gate (adaptado a Dota2)
- Gold lead threshold (si mostró señal en calibración)
- Kill lead threshold (si mostró señal)
- Gold momentum / crossing (si mostró señal)
- Hero draft cluster (si mostró señal Y hero_id disponible)
- Game time mínimo del segmento con edge
- `poll_age_ms` threshold

### 4b. Entry range
- Bins con P(win) - implied > threshold
- Dinámico según game state

### 4c. Sizing
- p25 de slippage por ask_bin × time_segment
- Nunca más que p25 sin mover >1c

### 4d. Stop-loss
- Derivar de volatilidad intra-match del mid. No número mágico.
- Dota2 es más volátil que LoL (comebacks, buybacks) → SL probablemente más ancho
- Movimiento del mid en ventanas de 1min, 5min, 10min
- SL = fuera de rango normal (>2 std)

---

## Paso 5: Backtest

### Execution model (obligatorio, no negociable)
- **Entrada:** al ask. No al mid.
- **Salida:** al bid. No al mid.
- **Fill:** solo si depth sostenido ≥ sizing target en ese tick.
- **Fees:** en ambos lados. Fee real de Polymarket CLOB.
- **Slippage:** si sizing > depth al ask, excedente al ask+1c (o no llena).
- **Delay:** p75 del gap entre ticks + penalty de ejecución. Calibrar con latencia real del bot. Sin datos → penalty mínimo 2s. NUNCA fill en mismo tick de señal.

**Ajuste Dota2:** Con polling de 30s, el delay del simulador debe reflejar que game state se actualiza cada ~30s. El simulador no puede asumir que sabe el game state actual — sabe el del último poll.

**Si el simulador no respeta estos puntos → resultados no válidos.**

### Metodología
- **Walk-forward:** split por tiempo (fecha), no por games.
- **Significancia por game×segment**, no por window
- PnL con gate vs sin
- Métricas: win rate, avg PnL, max drawdown

---

## Paso 6: Deploy

1. Context gate en pipeline
2. Tests
3. **Shadow mode** — loguear, NO ejecutar
4. Shadow hasta ≥10 señales shadow o ≥2 semanas (lo que llegue primero)
5. Si valida → live
6. Post-deploy: review si WR diverge >15pp O avg PnL >30% del backtest, sobre ≥20 trades live. Si <20 → esperar.

---

## Decision Gates

```
Paso 0.5: ¿Viable técnicamente?
  → Coverage global < 30% Y ninguna liga > 50%: PARAR o alternativa.
  → Coverage global < 30% PERO ≥1 liga > 50%: piloto restringido a esa liga.
  → hero_id no disponible: continuar con gold/kills/duration, prior más bajo.
  → duration incluye pausas sin detección: evaluar impacto o PARAR.
  → Latencia OpenDota p95 > 10s Y mercado reacciona <5s: sin ventana. PARAR.
  → Latencia OpenDota p95 > 10s PERO mercado reacciona >30s: ventana existe. Continuar.

Paso 2: ¿opportunity_strict ≥ 50h, windows ≥ 300, games ≥ 20, seen/expected ≥ 0.7?
  → seen/expected < 0.7: collector roto. FIXEAR.
  → opendota_coverage baja: limitación de fuente (por liga). Reportar.
  → opportunity_loose alto, strict bajo: NO cambiar rangos por intuición.
    → Generar histograma de spreads/asks en loose.
    → Elegir nuevos thresholds con datos.
    → Recalcular strict. Si sigue bajo → PARAR.
  → >50% mercados son match_series (ver journal): pipeline cubre poco. PARAR o series.
  → Cumple todo: continuar.

Integridad: mapping, outcomes, sides, market_type, clocks, duration, pausas,
            segments, coverage (global + por liga), mapping signals, gaps, hero data.
  → Falla: fixear o descartar.

3d Feasibility (game×segment): ¿Depth sostenido ≥ $15 share > 10%?
  → NO: PARAR.

3a Calibración (game×segment): ¿Positiva con consistencia?
  → Ni A, B, ni B2: PARAR.
  → A sí, B no, B2 no: PARAR.
  → A sí, B no, B2 sí: edge en condiciones feas. Adaptar o PARAR.
  → B sí, <2 validaciones: falso positivo. NO continuar.
  → B sí, ≥2 validaciones: continuar.
  → Features insuficientes: baseline "precio solo" vs "precio + features".
    Si features no mejoran calibración consistentemente (≥2/3 validaciones) → PARAR.

3c Drift (game×segment): ¿< costo total?
  → NO: PARAR o ajustar.

5 Backtest: ¿Walk-forward profit?
  → NO: volver a 4 o PARAR.
  → SÍ: deploy.

6 Post-deploy: ¿WR >15pp O PnL >30% divergencia sobre ≥20 trades?
  → SÍ: pausar.
```

---

## Datos post-STOP

Logger sigue corriendo. Datos se conservan. Re-evaluar si cambian condiciones.

---

## Secuencia de ejecución

1. **Paso 0.5 primero** — verificar viabilidad técnica (~30 min de polling + análisis)
2. Si viable → construir logger → deploy paralelo con LoL
3. Ambos acumulan datos simultáneamente
4. **Análisis secuencial:** LoL primero. Dota2 espera.
5. Si LoL pasa → terminar LoL, después Dota2
6. Si LoL falla → pivotar a Dota2 con datos ya acumulados
