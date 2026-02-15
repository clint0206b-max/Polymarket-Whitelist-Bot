// Phase 2: HTTP-only /book client (no WS)

export async function getBook(tokenId, cfg) {
  const token = String(tokenId || "");
  if (!token) return { ok: false, error_code: "bad_token", error: "missing tokenId", rawBook: null };

  const base = "https://clob.polymarket.com";
  const timeoutMs = Number(cfg?.polling?.http_timeout_ms || 2500);

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${base}/book?token_id=${encodeURIComponent(token)}`;
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });

    if (r.status === 429) {
      return { ok: false, error_code: "http_429", http_status: 429, error: "rate_limited", rawBook: null };
    }

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, error_code: "http_status", http_status: r.status, error: `${r.status} ${r.statusText}${body ? ` :: ${body.slice(0, 200)}` : ""}`, rawBook: null };
    }

    const j = await r.json();
    return { ok: true, rawBook: j, error: null };
  } catch (e) {
    const msg = e?.name === "AbortError" ? `timeout_after_${timeoutMs}ms` : (e?.message || String(e));
    return { ok: false, error_code: e?.name === "AbortError" ? "timeout" : "network", error: msg, rawBook: null };
  } finally {
    clearTimeout(to);
  }
}
