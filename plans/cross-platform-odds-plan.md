# Plan: Cross-Platform Odds Edge Measurement (Capa 1)

> **Parte del framework de 3 capas de edge measurement. Ver MEMORY.md para contexto.**

**Objetivo:** Determinar si los mercados esports de Polymarket son sistemáticamente ineficientes respecto a mercados de referencia (Betfair Exchange, Pinnacle), y si esa ineficiencia es capturable después de costos reales de ejecución.

**Principio:** Una diferencia de precio entre dos mercados NO es edge hasta que sobrevive al ajuste por costos de ejecución en ambos lados, matching verificado, y timing explícito.

---

## Hipótesis de edge

**¿Por qué Polymarket sería ineficiente vs sportsbooks en esports?**

1. **Pool de participantes distinto:** Polymarket atrae crypto-natives y generalistas. Sportsbooks tradicionales tienen sharp bettors profesionales que mueven la línea.
2. **Menor liquidez:** Orderbooks finos = más fricción = precios se ajustan más lento.
3. **Sin market makers profesionales (esports):** Los MM de Polymarket se concentran en política/crypto. Esports puede estar huérfano.
4. **Timing:** Polymarket puede reaccionar más lento porque tiene menos eyeballs en esports.

**Contra-hipótesis (por qué podría NO haber edge):**
- Polymarket tiene bots arbitrajistas que ya alinean con sportsbooks
- El spread + fees de Polymarket comen cualquier diferencia
- Esports en Polymarket es tan ilíquido que no podés ejecutar tamaño
- Pinnacle tampoco es eficiente en esports tier 2-3

---

## Paso 0: Definiciones críticas

### Referencia compuesta con quality flag

Betfair Exchange es la referencia preferida (orderbook, sin vig implícito), pero en esports puede tener mercados vacíos o con profundidad insuficiente. Pinnacle como fallback cuando Betfair no cumple umbral de liquidez.

**Lógica de selección de referencia (por snapshot):**

```
Si Betfair back_depth ≥ $50 AND lay_depth ≥ $50 AND betfair_spread ≤ 5%:
  → ref = betfair_mid (ajustado por comisión de cuenta)
  → ref_quality = "betfair_liquid"

Si Betfair existe pero no cumple umbral:
  → ref = pinnacle_devigged (normalización simple: 1/odds_a / sum(1/odds), solo 2-way)
  → ref_quality = "pinnacle_fallback"
  → loguear betfair raw de todas formas para comparar

Si ninguno disponible:
  → loguear snapshot de Polymarket pero NO incluir en análisis
  → ref_quality = "no_ref"
```

**Comisión de Betfair:** No es fija. Depende de la cuenta y del mercado. Se loguea `betfair_commission_rate` en cada snapshot, no se asume un valor global.

**Umbrales iniciales:** $50 depth y 5% spread son iniciales. Si Betfair en esports resulta sistemáticamente ilíquido (>70% de snapshots = `pinnacle_fallback`), Pinnacle se vuelve la referencia de facto y Betfair se descarta como fuente para este análisis.

**Segmentación por ref_quality obligatoria:** El análisis en Paso 3 se corre por separado para `betfair_liquid` y `pinnacle_fallback`. Si las conclusiones cambian entre ambos → red flag: la referencia importa más que el edge.

### Dos modos de costo de ejecución

La señal de Capa 1 es pre-match. Hay dos escenarios de salida con costos muy distintos:

**Modo A — Hold to resolution:**
```
cost_hold = spread_cost_entry + slippage_entry + fee_entry_polymarket

→ No hay exit cost (posición resuelve a $0 o $1)
→ No hay fee de salida en Polymarket para resolución
→ edge_neto_hold = edge_bruto - cost_hold
```

**Modo B — Trade out (exit antes de resolución):**
```
cost_trade = spread_cost_entry + slippage_entry + fee_entry_polymarket
           + spread_cost_exit + slippage_exit + fee_exit_polymarket

→ slippage_exit estimado con depth al momento del snapshot (peor caso)
→ spread_cost_exit estimado con spread actual (puede empeorar in-play)
→ edge_neto_trade = edge_bruto - cost_trade
```

**Ambos se calculan y loguean en CADA snapshot.** No se elige uno en el backtest — la distinción existe desde la recolección.

**Paso 3b usa `edge_neto_hold` como métrica principal** (hold es el caso natural para señales pre-match). `edge_neto_trade` se reporta como referencia para cuantificar el costo de cambiar de opinión.

**Si `edge_neto_hold > 0` pero `edge_neto_trade < 0`:** hay edge pero no podés salir si te equivocás. Se loguea como riesgo, no como PARAR automático.

**Costo de referencia de Betfair:** Comisión sobre profit, no sobre nocional.
```
betfair_effective_cost = commission_rate × max(0, payout - stake)
```

### Subset ultra-estricto para matching

**Solo loguear matches que cumplan TODOS:**
1. **Moneyline de match (series winner)** — no mapas individuales, no props, no handicaps
2. **Eventos tier 1** — ligas principales (LCK, LPL, LEC, LCS, ESL Pro, DPC Major, VCT)
3. **2-way market** — solo A gana vs B gana. No draws, no voided scenarios.
4. **Pre-match only** (inicialmente) — snapshot antes de que empiece. In-play agrega complejidad de timing.
5. **Match rules compatibles** — verificar que Polymarket y el sportsbook resuelven igual (Bo3 completo, no "primer mapa", no overtime rules diferentes)

**Loguear matches descartados** con reason (tier, market type, rule mismatch) para saber cuánto se pierde y si vale expandir después.

---

## Paso 1: Cross-Platform Odds Logger 🔲 PENDIENTE

**Módulo:** `src/context/cross_platform_odds_logger.mjs`
**Output:** `state/journal/cross_odds_log.jsonl`

### Fuentes de datos

**Betfair Exchange (preferida):**
- API gratis con cuenta (requiere registro)
- Endpoints: `listMarketCatalogue`, `listMarketBook`
- Datos: back/lay prices + depth por level, market status
- Limitaciones: rate limits, necesita session token refresh
- Comisión variable por cuenta/mercado

**The Odds API (para Pinnacle + otros):**
- Tier gratis: 500 requests/mes
- Agrega: Pinnacle, DraftKings, Bet365, etc.
- Datos: odds por outcome, timestamps
- Limitación: 500 req/mes → priorizar snapshots en T-1h y T-10min

**Polymarket (ya tenemos):**
- WS feed: bid/ask en real time
- HTTP /book: depth completo en candidate windows

### Tipos de registro

- **odds_snapshot**: timestamp, match_id, source (betfair|pinnacle|polymarket), market_type, outcomes con odds/prices, depth (si disponible), ref_quality
- **polymarket_book_snapshot**: top N levels del orderbook, spread, depth_to_ask_plus_1c. Tomado al mismo tiempo que odds_snapshot de referencia.
- **mapping**: match identifiers cross-platform, tournament, teams, market_type verificado, rule_check (pass/fail con detalles), matching_confidence
- **outcome**: resultado real del match. Para calcular calibración ex-post.
- **rejected**: matches descartados con reason (tier, market_type, rule_mismatch, no_ref, etc.)

### Campos de costo (en cada snapshot de Polymarket)

**Polymarket (ambos modos):**
- `implied_ask`: precio ask (lo que pagás)
- `implied_mid`: (bid+ask)/2
- `spread_cost_entry`: (ask - bid) / 2
- `depth_at_ask_usd`: cuánto podés comprar sin mover precio
- `depth_to_ask_plus_1c_usd`: cuánto hasta 1 centavo peor
- `fee_entry`: fee de Polymarket CLOB en entry
- `slippage_entry`: basado en sizing target vs depth
- `cost_hold`: spread_cost_entry + slippage_entry + fee_entry *(Modo A)*
- `spread_cost_exit`: estimado con spread actual
- `slippage_exit`: estimado con depth actual
- `fee_exit`: fee de Polymarket CLOB en exit
- `cost_trade`: cost_hold + spread_cost_exit + slippage_exit + fee_exit *(Modo B)*
- `edge_neto_hold`: edge_bruto - cost_hold
- `edge_neto_trade`: edge_bruto - cost_trade

**Betfair:**
- `back_price`, `lay_price`, `back_depth`, `lay_depth`
- `betfair_spread`: (lay - back) / back
- `betfair_commission_rate`: comisión real de la cuenta en ese mercado
- `betfair_effective_cost`: commission_rate × max(0, payout - stake)
- `implied_fair_mid`: mid ajustado por comisión

**Pinnacle:**
- `odds_a`, `odds_b`
- `overround`: sum(1/odds) - 1
- `implied_fair` (devigged): 1/odds_a / sum(1/odds)

### Dual bucketing temporal

**Eje 1 — Time to scheduled start (T-start):**
Ventanas: T-24h, T-6h, T-1h, T-10min, T-0

Basado en `scheduled_start` del match (de Polymarket o del sportsbook).

**Campos por snapshot:**
- `scheduled_start_at_snapshot`: valor de scheduled_start válido al tomar el snapshot
- `time_to_start_ms`: diferencia entre snapshot y scheduled_start
- `start_shifted`: true si scheduled_start cambió >30min respecto al snapshot anterior del mismo match

**Eje 2 — Time since first listed (T-listed):**
Ventanas: T+0h (recién listado), T+6h, T+12h, T+24h, T+48h

Basado en primera aparición del match en Polymarket.

**Campos por snapshot:**
- `first_listed_ts`: timestamp de primera aparición en Polymarket
- `time_since_listed_ms`: diferencia entre snapshot y first_listed_ts

**Ambos ejes se loguean en cada snapshot.**

El análisis usa T-start como eje principal. T-listed valida: si el edge aparece solo en mercados recién listados y desaparece con madurez → price discovery normal, no ineficiencia explotable.

Si `start_shifted = true` en >10% de snapshots para un esport/liga → reportar como problema de data quality y evaluar si T-start es confiable.

**Adicionalmente:** loguear hora UTC del snapshot para analizar patrones por timezone (mercados de Asia vs Europa vs NA).

### Matching cross-platform

**Multi-señal obligatorio:**
1. **Team names** — fuzzy match, ambos teams
2. **Tournament** — debe coincidir
3. **Date/time** — match day compatible (±24h para pre-match)
4. **Market type** — verificar que ambos son moneyline series (no mapa individual)
5. **Rule check** — verificar condiciones de resolución (Bo3 completo, overtime rules)

**Loguear `matching_confidence`:** high (5/5 criterios), medium (4/5), low (3/5).
**Solo usar high y medium para análisis.** Low → solo loguear para debugging.

---

## Paso 2: Acumular datos

### Target
- **≥100 matches con snapshots cross-platform completos** (ref_quality ≠ no_ref)
- **≥3 esports distintos** (LoL, CS2, Dota2 como mínimo)
- **≥4 semanas de calendario** (evitar sesgo de un solo torneo)

### Métricas de salud
- Matches logueados vs matches disponibles en Polymarket (coverage)
- Matches descartados por matching (por reason)
- Completeness de snapshots temporales (¿cuántos matches tienen las 5 ventanas T-start?)
- Distribución por esport, tier, tournament
- **ref_quality distribution**: ¿qué % es betfair_liquid vs pinnacle_fallback vs no_ref?
- **start_shifted rate**: ¿qué % de snapshots tiene start_shifted = true?

### Suficiencia
- ≥100 matches con al menos T-1h y T-10min snapshots
- ≥3 esports con ≥20 matches cada uno
- Matching confidence high en ≥80%
- ref_quality ≠ no_ref en ≥90% de snapshots usables

---

## Paso 3: Análisis

### 3.0: Integridad
1. Matching confidence distribution — ¿cuántos high/medium/low?
2. Outcomes presentes para cada match
3. Snapshots temporales completos (≥4 de 5 ventanas T-start por match)
4. ref_quality distribution — ¿Betfair es usable o todo es Pinnacle fallback?
5. Polymarket book snapshots presentes y con depth > 0
6. start_shifted rate por esport — ¿T-start es confiable?

### 3a. Discrepancia bruta

Para cada match × ventana temporal:
```
disc_bruta = implied_fair_ref - implied_ask_polymarket
```
(donde `implied_fair_ref` viene de Betfair o Pinnacle según ref_quality del snapshot)

Reportar:
- Distribución de disc_bruta por esport, tier, ventana temporal
- ¿Hay sesgo sistemático? (Polymarket sobrevalora o subvalora favoritos?)
- ¿Varía por ventana temporal? (T-24h vs T-10min)
- ¿Varía por esport?
- **¿Varía por ref_quality?** (betfair_liquid vs pinnacle_fallback → si cambian las conclusiones, red flag)

**Si disc_bruta mediana ≈ 0 en T-10min → mercados alineados. No hay edge bruto. PARAR.**

### 3b. Discrepancia neta (después de costos)

**Métrica principal: `edge_neto_hold`** (hold to resolution, caso natural para señales pre-match):
```
edge_neto_hold = disc_bruta - cost_hold
```

**Métrica secundaria: `edge_neto_trade`** (trade out, cuantifica costo de cambiar de opinión):
```
edge_neto_trade = disc_bruta - cost_trade
```

Reportar por esport × ventana temporal × direction (Polymarket overpriced vs underpriced).

**Decision gate:** Si `edge_neto_hold` mediana ≤ 0 en todas las combinaciones → PARAR. No hay edge capturable.

**Risk flag:** Si `edge_neto_hold > 0` pero `edge_neto_trade < 0` → hay edge pero sin salida si te equivocás. Loguear como riesgo, no PARAR automático.

### 3c. Calibración ex-post

¿Quién predice mejor?
- P(win) según ref (Betfair mid o Pinnacle devigged) vs P(win) según Polymarket ask vs resultado real
- Calibration plot por bins de probabilidad
- Si la referencia está mejor calibrada que Polymarket → señal de referencia tiene valor predictivo
- **Separar por ref_quality**: ¿Betfair calibra mejor que Pinnacle como referencia?

### 3d. Persistencia temporal

- ¿`edge_neto_hold` en T-10min predice valor? (matches donde edge_neto_hold > X → ¿win rate real > implied ask?)
- ¿Cuánto tamaño podés ejecutar a ese precio? (depth real en T-10min)
- Si edge_neto_hold > 0 pero depth < $5 → edge existe pero no es ejecutable
- **T-listed validation**: si el edge aparece solo en T-listed < 6h y desaparece después → es price discovery, no ineficiencia

### 3e. Segmentación

- Por esport: ¿CS2 más ineficiente que LoL?
- Por tier: ¿tier 2 más ineficiente que tier 1?
- Por hora del día: ¿mercados asiáticos vs europeos?
- Por liquidez de Polymarket: ¿mercados con poco volume más ineficientes?
- Por ref_quality: ¿conclusiones estables entre betfair_liquid y pinnacle_fallback?

**Advertencia de dimensionalidad:** 3+ esports × 5 ventanas × 2 directions × 2 ref_quality × tiers = muchas combinaciones. Consistencia obligatoria (≥2 de 3 validaciones).

---

## Paso 4: Definir reglas

**Solo si Paso 3 muestra edge_neto_hold > 0 persistente y ejecutable.**

- Threshold de edge_neto_hold para entrar
- Sizing basado en depth real del orderbook
- Timing de entrada (¿en qué ventana temporal T-start?)
- Qué referencia usar (Betfair, Pinnacle, o combo) basado en resultados de ref_quality segmentation
- Hold vs trade out: decidir basado en relación edge_neto_hold vs edge_neto_trade

---

## Paso 5: Backtest

- **Walk-forward** por fecha
- **Execution model realista:** entry al ask de Polymarket, sizing limitado por depth, fees en entry
- **Sin asumir fill al mid**
- **Modo hold**: PnL = outcome × shares - cost_entry
- **Modo trade**: PnL = exit_price × shares - cost_entry - cost_exit (solo si hay señal de salida)
- PnL vs no-trade baseline

---

## Paso 6: Deploy

Shadow → live → post-deploy review (mismo framework que los otros planes).

---

## Decision Gates

```
Paso 2: ¿≥100 matches, ≥3 esports, ≥4 semanas, matching high ≥80%, ref ≠ no_ref ≥90%?
  → No: esperar o expandir sources.

Integridad: outcomes, snapshots completos, ref_quality, start_shifted.
  → Falla: fixear.

3a Discrepancia bruta: ¿Existe sesgo sistemático?
  → disc_bruta ≈ 0 en T-10min: mercados alineados. PARAR.
  → disc_bruta > 0: continuar.
  → Cambia entre ref_quality: RED FLAG — evaluar si referencia es confiable.

3b Discrepancia neta: ¿Sobrevive a costos?
  → edge_neto_hold ≤ 0: edge comido por costos. PARAR.
  → edge_neto_hold > 0: continuar.
  → edge_neto_hold > 0 pero edge_neto_trade < 0: RISK FLAG (no podés salir).

3c Calibración: ¿Referencia predice mejor que Polymarket?
  → No: la discrepancia es ruido. PARAR.
  → Sí: continuar.

3d Persistencia: ¿edge_neto_hold > 0 predice valor real?
  → No: PARAR.
  → Sí pero depth < $5: no ejecutable. PARAR.
  → Sí pero solo en T-listed < 6h: price discovery, no edge. PARAR.
  → Sí con depth y persistente: continuar.

5 Backtest: ¿Walk-forward profit con execution realista?
  → No: PARAR.
  → Sí: deploy.
```

---

## Relación con las otras capas

- **Capa 1 (esta)** responde: ¿Polymarket es ineficiente vs mercados de referencia?
- **Capa 2 (pre-match model)** responde: ¿podemos generar nuestra propia "fair prob" que sea mejor que el mercado?
- **Capa 3 (in-game LoL)** responde: ¿el mercado incorpora eventos in-game eficientemente?

Las tres son independientes. Un edge en Capa 1 no invalida buscar edge en Capa 3 y viceversa. Pero si Capa 1 muestra que Polymarket está bien calibrado vs Betfair, eso reduce el prior de Capa 2 (si el mercado ya es eficiente, un modelo simple probablemente no sea mejor).
