import { SmsError } from "./errors";
import type { HeadersLike } from "./types";

export function getHeader(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Verify an SMS Gateway webhook: HMAC-SHA256(secret, rawBody + timestamp), hex,
 * sent in X-Signature with X-Timestamp. Throws SmsError("UNAUTHORIZED") if invalid.
 */
export async function verifyWebhook(rawBody: string, headers: HeadersLike, secret: string): Promise<true> {
  if (!secret) throw new SmsError("CONFIG", "Webhook secret is required.");
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new SmsError("CONFIG", "Web Crypto is not available in this runtime.");

  const signature = getHeader(headers, "x-signature");
  const timestamp = getHeader(headers, "x-timestamp");
  if (!signature || !timestamp) throw new SmsError("UNAUTHORIZED", "Missing webhook signature headers.");

  const t = Number(timestamp);
  if (!Number.isFinite(t)) throw new SmsError("UNAUTHORIZED", "Invalid webhook timestamp.");
  const ms = t > 1e11 ? t : t * 1000;
  if (Math.abs(Date.now() - ms) > MAX_AGE_MS) throw new SmsError("UNAUTHORIZED", "Webhook timestamp has expired.");

  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await subtle.sign("HMAC", key, enc.encode(rawBody + timestamp)));
  let hex = "";
  for (const b of mac) hex += b.toString(16).padStart(2, "0");
  if (!safeEqual(hex, signature.trim().toLowerCase())) throw new SmsError("UNAUTHORIZED", "Invalid webhook signature.");
  return true;
}
