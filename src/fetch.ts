import { createRoutes, DEFAULT_MAX_BODY, type RouteOptions } from "./server/route";
import type { Sms } from "./types";

export type SmsHandlerOptions = RouteOptions<Request>;

async function readLimited(req: Request, limit: number): Promise<{ text: string; tooLarge: boolean }> {
  const cl = Number(req.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > limit) return { text: "", tooLarge: true };
  if (!req.body) return { text: "", tooLarge: false };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return { text: "", tooLarge: true };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder().decode(all), tooLarge: false };
}

/**
 * Framework-neutral handler for Next.js route handlers, Hono, Bun, Deno, Workers.
 * Routes are matched by the end of the URL path: /send, /logs, /logs/:id, /sync, /cancel/:id, /webhook.
 */
export function smsHandler(
  sms: Pick<Sms, "send" | "logs" | "get" | "sync" | "cancel" | "handleWebhook">,
  options: SmsHandlerOptions
): (req: Request) => Promise<Response> {
  const handle = createRoutes<Request>(sms, options);
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  return async (req) => {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const b = hasBody ? await readLimited(req, limit) : { text: "", tooLarge: false };
    const res = await handle({
      method: req.method,
      path: url.pathname,
      query,
      headers,
      native: req,
      ...(hasBody && !b.tooLarge ? { rawBody: b.text } : {}),
      bodyTooLarge: b.tooLarge
    });
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  };
}
