# Global WS Scanner — Optimization Report

**Fecha:** 2026-02-20 23:36 GMT-3  
**Balance:** ~$96 | Sizing: 10% equity (~$9.60/trade)  
**Estrategia:** Resolution harvesting (buy ≥0.98, collect $1.00)

---

## 1. Estado actual del universo (query live Gamma API)

| Filtro | Mercados con precio ≥ 0.98 |
|--------|---------------------------|
| Total activos en Polymarket | 29,751 |
| Precio ≥ 0.98 | 5,868 |
| endDate ≤ 6h (config actual) | **50** (42 con vol≥100, 8 sin) |
| endDate ≤ 12h | **102** (94 con vol≥100) |
| endDate ≤ 24h | **643** (532 con vol≥100) |
| endDate ≤ 48h | **769** (650 con vol≥100) |
| endDate pasado (ya vencidos) | 530 |

**Conclusión clave:** Con 6h solo hay **42 mercados elegibles** después del filtro de volumen. Es el cuello de botella #1.

---

## 2. Pipeline de filtros y análisis de cada gate

### Filter 1: `max_end_date_hours` = 6 ⭐ CUELLO DE BOTELLA PRINCIPAL

**Impacto:** Mata el 87% de los mercados potenciales (solo pasa 50 de ~400+ viables).

| Rango | Mercados | Incremento vs 6h |
|-------|----------|-------------------|
| ≤ 6h | 50 | baseline |
| ≤ 12h | 102 | +104% |
| ≤ 24h | 643 | +1186% |
| ≤ 48h | 769 | +1438% |

**Recomendación: Subir a 24h.** La mayoría de mercados deportivos se crean ~12-24h antes del partido. Con 6h estás perdiendo la gran mayoría. El riesgo de tener dinero atrapado 24h es mínimo a $9.60/trade — y si el precio es 0.98+, la resolución es casi segura.

### Filter 2: `min_volume_24h` = 100

**Impacto:** Mata 8 mercados dentro de 6h, y **111 mercados** si subieras a 24h.

Distribución de volumen (mercados ≤6h, precio ≥0.98):
- vol 0-10: 1
- vol 10-50: 4  
- vol 50-100: 3
- vol 100-500: 27
- vol 500+: 15

**Recomendación: Bajar a 0 (eliminar).** El volumen pasado no predice liquidez presente — ya tienes depth check ($200) que verifica liquidez real del order book. El volume filter es redundante y mata mercados pequeños que pueden tener liquidez suficiente para tu trade de $9.60. La excepción `isShortTerm` (<1h) ya existe pero solo cubre el último hora.

### Filter 3: `min_entry_depth_usd_ask` = 200 y `min_exit_depth_usd_bid` = 200

**Config actual (local.json):** 200 ask / 200 bid  
**Config defaults:** 1000 ask / 2000 bid  

**Cómo funciona en el scanner:** El scanner sobreescribe `max_entry_price` a 0.995 en `scannerCfg`, pero usa los valores de `local.json` para `min_entry_depth_usd_ask` (200) y `min_exit_depth_usd_bid` (200).

**Impacto:** Para trades de $9.60, exigir $200 de profundidad es ~20x lo necesario. Esto es conservador pero razonable — mercados sin $200 de liquidez son genuinamente peligrosos (spread manipulation).

**Recomendación: Mantener en 200, o bajar a 50-100.** Con $9.60/trade, $50 de ask depth es más que suficiente para no mover el mercado. Pero $200 da margen de seguridad. El impacto real depende de cuántos mercados mata — sin data de cada book individual no puedo cuantificarlo exactamente, pero probablemente mata 10-20% adicional.

### Filter 4: `max_spread` = 0.10

**Impacto:** Spread de 10 centavos es muy generoso. La mayoría de mercados con precio ≥0.98 tienen spreads ≤0.05. Este filtro probablemente no mata casi nada.

**Recomendación: Mantener en 0.10.** No es un problema.

### Filter 5: `min_price_filter` = 0.90 (pre-filtro discovery)

**Cómo funciona:** En discovery, solo se suscriben tokens con precio ≥0.90. Después, en `checkAndInject`, se filtra por 0.98-0.99.

**Impacto:** No mata mercados buenos — solo decide cuántos tokens se suscriben al WS. Con 0.90, suscribes más tokens de los necesarios.

**Recomendación: Subir a 0.95.** Reduce carga del WS sin perder nada. Un mercado que sube de 0.95 a 0.98 será capturado en el siguiente discovery cycle. Si discovery es cada 30s, es imposible perder algo.

### Filter 6: `discovery_interval_seconds` = 30

**Impacto:** Discovery cada 30s es bastante agresivo. Cada run pagina por TODOS los eventos activos (~60 requests de 500).

**Recomendación: Mantener 30s si la API lo tolera. Subir a 60s si ves rate limits.** Con WS activo, el discovery solo necesita captar mercados NUEVOS. 30-60s está bien.

### Filter 7: `price_update_min_ask` = 0.80 (en local.json filters)

**Impacto en scanner:** NINGUNO. Este filtro es para el eval loop legacy, no para el global scanner. El scanner usa su propio `min_price_filter` (0.90) y `min_prob`/`max_entry_price` directamente.

### Filter 8: Entry price range 0.98-0.99

**Cómo funciona:** `checkAndInject` requiere `bestAsk >= 0.98 && bestAsk <= 0.99`.

**Recomendación: Considerar ampliar a 0.97-0.995.** Comprar a 0.97 da $0.03 profit/share vs $0.02 a 0.98. El riesgo marginal es mínimo en mercados que resuelven en <24h. El scanner ya sobreescribe `max_entry_price` a 0.995 para depth calc, pero el check en `checkAndInject` usa 0.99 de local.json.

### Filter 9: Already in watchlist / open position check

**Impacto:** Previene double-buying. Correcto y necesario. No tocar.

### Filter 10: `compute_depth_metrics` — `max_entry_price` para ask depth

**Bug potencial:** En `compute_depth_metrics`, el entry depth solo cuenta asks con `price <= maxEntryPx`. El scanner pasa `max_entry_price: 0.995`. Pero en defaults, es 0.97. Si `scannerCfg` override no funciona correctamente, podría contar 0 ask depth para asks de 0.98-0.99.

**Verificación:** El scanner construye `scannerCfg` así:
```js
const scannerCfg = {
  ...this.cfg,
  filters: { ...this.cfg?.filters, max_entry_price: Number(this.cfg?.global_scanner?.max_entry_price ?? 0.995) }
};
```
Esto debería funcionar — `this.cfg.filters.max_entry_price` es 0.99 (local.json), y se sobreescribe a 0.995. **OK, no es un bug.**

---

## 3. Config óptima recomendada

```json
{
  "global_scanner": {
    "enabled": true,
    "min_price_filter": 0.95,
    "discovery_interval_seconds": 30,
    "max_end_date_hours": 24,
    "min_volume_24h": 0,
    "max_entry_price": 0.995
  },
  "filters": {
    "min_prob": 0.97,
    "max_entry_price": 0.995,
    "max_spread": 0.10,
    "min_entry_depth_usd_ask": 100,
    "min_exit_depth_usd_bid": 100
  }
}
```

### Justificación de cada cambio

| Parámetro | Actual | Propuesto | Razón |
|-----------|--------|-----------|-------|
| `max_end_date_hours` | 6 | **24** | De 42 a ~532 mercados elegibles (+1167%) |
| `min_volume_24h` | 100 | **0** | Depth check ya valida liquidez real; +111 mercados |
| `min_price_filter` | 0.90 | **0.95** | Reduce tokens WS sin perder oportunidades |
| `min_prob` | 0.98 | **0.97** | +$0.01 profit/share, más mercados elegibles |
| `max_entry_price` | 0.99 | **0.995** | Captar mercados casi resueltos (0.99-0.995) |
| `min_entry_depth_usd_ask` | 200 | **100** | Trade es ~$10, $100 depth es 10x suficiente |
| `min_exit_depth_usd_bid` | 200 | **100** | Mismo razonamiento |

### Impacto estimado

- **Universo actual:** ~42 mercados elegibles → **~600+ mercados elegibles**
- **Mercados que pasan todos los filtros:** depende de depth/spread, pero ~14x más candidatos
- **Riesgo adicional:** Mínimo. Trades de $9.60 en mercados con precio 0.97+ que resuelven en <24h. Worst case con SL 0.90 = pérdida de $0.76/trade.

---

## 4. Cambio de mayor impacto (si solo pudieras hacer UNO)

**`max_end_date_hours`: 6 → 24**

Esto solo multiplica el universo por 12x. Todo lo demás es optimización incremental.

---

## 5. Riesgos a considerar

1. **Capital atrapado más tiempo:** Con 24h, un trade puede estar abierto hasta 24h. Con $9.60/trade y ~$96 de balance, puedes tener ~10 posiciones simultáneas. Si los 10 se abren a las 24h de resolución, tu capital está atrapado un día.

2. **Más trades = más fees:** Los fees de Polymarket CLOB son bajos/0 para takers en muchos mercados, pero verificar.

3. **Mercados que cambian de resultado:** Un mercado a 0.98 que resuelve en 24h tiene más tiempo para que algo cambie vs uno que resuelve en 2h. El SL de 0.90 mitiga esto.

---

*Reporte generado automáticamente. NO se modificó ningún archivo de configuración.*
