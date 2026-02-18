/**
 * telegram.mjs — Lightweight Telegram notifier.
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from env.
 * Never throws — logs errors silently so trading is never disrupted.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

export async function notifyTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      console.warn(`[TELEGRAM] send failed: ${r.status} ${r.statusText}`);
    }
  } catch (e) {
    console.warn(`[TELEGRAM] error: ${e.message}`);
  }
}
