import { createRoutes, DEFAULT_MAX_BODY, type RouteOptions } from "./server/route";
import type { Sms } from "./types";

interface ReqLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: string | Uint8Array;
  on(event: string, cb: (...args: any[]) => void): unknown;
}
interface ResLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

export type SmsRouterOptions = RouteOptions<ReqLike>;

function readBody(req: ReqLike, limit: number): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Uint8Array | string) => {
      if (tooLarge) return;
      const b = typeof c === "string" ? Buffer.from(c) : c;
      size += b.byteLength;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(b);
    });
    req.on("end", () => resolve({ text: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"), tooLarge }));
    req.on("error", reject);
  });
}

/**
 * Express (and Connect-style) router. Mount it BEFORE express.json() so it can read the raw body
 * (needed for webhook signatures), e.g. app.use("/sms", smsRouter(sms, { auth })).
 */
export function smsRouter(
  sms: Pick<Sms, "send" | "logs" | "get" | "sync" | "cancel" | "handleWebhook">,
  options: SmsRouterOptions
): (req: ReqLike, res: ResLike, next?: (err?: unknown) => void) => Promise<void> {
  const handle = createRoutes<ReqLike>(sms, options);
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  return async (req, res, next) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = (req.method ?? "GET").toUpperCase();
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));

      let rawBody: string | undefined;
      let body: unknown;
      let bodyTooLarge = false;
      if (method !== "GET" && method !== "HEAD") {
        if (req.rawBody !== undefined) {
          rawBody = typeof req.rawBody === "string" ? req.rawBody : Buffer.from(req.rawBody).toString("utf8");
          if (Buffer.byteLength(rawBody) > limit) bodyTooLarge = true;
        } else if (req.body !== undefined && typeof req.body === "object") {
          body = req.body; // already parsed by express.json(); no raw body available
        } else {
          const b = await readBody(req, limit);
          rawBody = b.text;
          bodyTooLarge = b.tooLarge;
        }
      }
      const out = await handle({
        method,
        path: url.pathname,
        query,
        headers,
        native: req,
        bodyTooLarge,
        ...(rawBody !== undefined ? { rawBody } : {}),
        ...(body !== undefined ? { body } : {})
      });
      res.statusCode = out.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(out.body));
    } catch (e) {
      if (next) next(e);
      else {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: { code: "HTTP", message: "Internal server error." } }));
      }
    }
  };
}
