import { SmsError, isSmsError } from "../errors";
import type { SendInput, Sms, SmsStatus } from "../types";

export const DEFAULT_MAX_BODY = 20480;
const STATUSES: SmsStatus[] = ["pending", "processed", "sent", "delivered", "failed", "cancelled"];
const SEND_FIELDS = ["to", "message", "template", "vars", "meta", "key", "scheduleAt"] as const;

export interface RouteOptions<Req> {
  /** Required. Return true to allow the request. */
  auth?: (req: Req) => boolean | Promise<boolean>;
  /** Development only: disables authentication. */
  unsafeNoAuth?: boolean;
  maxRecipients?: number;
  maxBodyBytes?: number;
  allowCustomMessage?: boolean;
  /** Add metadata, restrict recipients, or throw to reject. Return the input to send. */
  prepare?: (req: Req, input: SendInput) => SendInput | void | Promise<SendInput | void>;
  webhook?: { secret: string };
  onError?: (err: unknown, context: string) => void;
}

export interface RouteRequest<Req> {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Already-parsed JSON body (e.g. from express.json()). */
  body?: unknown;
  rawBody?: string;
  bodyTooLarge?: boolean;
  headers: Record<string, string | undefined>;
  native: Req;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

type RouteName = "send" | "logs" | "log" | "sync" | "cancel" | "webhook";

export function matchRoute(method: string, path: string): { name: RouteName; id?: string } | null {
  const p = path.replace(/\/+$/, "");
  const m = method.toUpperCase();
  let r: RegExpMatchArray | null;
  if (m === "POST" && /\/send$/.test(p)) return { name: "send" };
  if (m === "POST" && /\/sync$/.test(p)) return { name: "sync" };
  if (m === "POST" && /\/webhook$/.test(p)) return { name: "webhook" };
  if (m === "POST" && (r = p.match(/\/cancel\/([^/]+)$/))) return { name: "cancel", id: decodeURIComponent(r[1]!) };
  if (m === "GET" && /\/logs$/.test(p)) return { name: "logs" };
  if (m === "GET" && (r = p.match(/\/logs\/([^/]+)$/))) return { name: "log", id: decodeURIComponent(r[1]!) };
  return null;
}

const ok = (data: unknown, status = 200): RouteResponse => ({ status, body: { ok: true, data } });
const fail = (status: number, code: string, message: string, data?: unknown): RouteResponse => ({
  status,
  body: { ok: false, error: { code, message }, ...(data !== undefined ? { data } : {}) }
});

const CLIENT_ERRORS = new Set(["INVALID_PHONE", "INVALID_MESSAGE", "INVALID_INPUT", "TEMPLATE_NOT_FOUND", "TEMPLATE_VARIABLE_MISSING"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createRoutes<Req>(
  sms: Pick<Sms, "send" | "logs" | "get" | "sync" | "cancel" | "handleWebhook">,
  o: RouteOptions<Req>
): (req: RouteRequest<Req>) => Promise<RouteResponse> {
  if (!o || (typeof o.auth !== "function" && o.unsafeNoAuth !== true)) {
    throw new SmsError("CONFIG", "An `auth` function is required. Use `unsafeNoAuth: true` only for local development.");
  }
  const maxRecipients = o.maxRecipients ?? 20;
  const allowCustomMessage = o.allowCustomMessage ?? true;
  const report = (e: unknown, ctx: string) => {
    try {
      o.onError?.(e, ctx);
    } catch {
      /* ignore */
    }
  };

  function parseBody(req: RouteRequest<Req>): unknown {
    if (req.body !== undefined) return req.body;
    if (!req.rawBody) return undefined;
    try {
      return JSON.parse(req.rawBody);
    } catch {
      throw new SmsError("INVALID_INPUT", "Request body is not valid JSON.");
    }
  }

  return async function handle(req) {
    try {
      const m = matchRoute(req.method, req.path);
      if (!m) return fail(404, "INVALID_INPUT", "Not found.");

      if (m.name === "webhook") {
        if (!o.webhook?.secret) return fail(404, "INVALID_INPUT", "Not found.");
        if (req.bodyTooLarge) return fail(413, "INVALID_INPUT", "Request body too large.");
        if (req.rawBody === undefined) {
          report(new Error("Webhook needs the raw body. Mount smsRouter before express.json() or set req.rawBody."), "webhook");
          return fail(500, "HTTP", "Internal server error.");
        }
        try {
          return ok(await sms.handleWebhook(req.rawBody, req.headers, { secret: o.webhook.secret }));
        } catch (e) {
          if (isSmsError(e) && e.code === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Invalid webhook signature.");
          throw e;
        }
      }

      if (o.unsafeNoAuth !== true) {
        let allowed = false;
        try {
          allowed = (await o.auth!(req.native)) === true;
        } catch (e) {
          report(e, "auth");
        }
        if (!allowed) return fail(401, "UNAUTHORIZED", "Unauthorized.");
      }
      if (req.bodyTooLarge) return fail(413, "INVALID_INPUT", "Request body too large.");

      switch (m.name) {
        case "send": {
          const raw = parseBody(req);
          if (!isObject(raw)) throw new SmsError("INVALID_INPUT", "A JSON body is required.");
          let input: SendInput = {} as SendInput;
          for (const k of SEND_FIELDS) if (raw[k] !== undefined) (input as unknown as Record<string, unknown>)[k] = raw[k];
          if (o.prepare) {
            const out = await o.prepare(req.native, input);
            if (out) input = out;
          }
          const list = Array.isArray(input.to) ? input.to : [input.to];
          if (list.length > maxRecipients) throw new SmsError("INVALID_INPUT", `At most ${maxRecipients} recipients per request.`);
          if (!allowCustomMessage && input.message !== undefined) throw new SmsError("INVALID_INPUT", "Custom messages are disabled; use a template.");
          const out = await sms.send(input);
          const results = Array.isArray(out) ? out : [out];
          if (results.length > 0 && results.every((r) => !r.ok)) return fail(502, "HTTP", "All messages failed.", { results });
          return ok({ results });
        }
        case "logs": {
          const q = req.query;
          const query: Record<string, unknown> = {};
          if (q.status) {
            if (!STATUSES.includes(q.status as SmsStatus)) throw new SmsError("INVALID_INPUT", "Invalid status filter.");
            query.status = q.status;
          }
          for (const k of ["to", "key", "createdFrom", "createdTo", "cursor"]) if (q[k]) query[k] = q[k];
          if (q.limit) {
            const n = Number(q.limit);
            if (!Number.isInteger(n) || n < 1) throw new SmsError("INVALID_INPUT", "Invalid limit.");
            query.limit = n;
          }
          return ok(await sms.logs(query));
        }
        case "log": {
          const log = await sms.get(m.id!);
          return log ? ok(log) : fail(404, "INVALID_INPUT", "Not found.");
        }
        case "sync":
          return ok({ updated: await sms.sync() });
        case "cancel": {
          const r = await sms.cancel(m.id!);
          return r.ok ? ok(r) : fail(409, "HTTP", r.error ?? "Could not cancel.", r);
        }
      }
      return fail(404, "INVALID_INPUT", "Not found.");
    } catch (e) {
      if (isSmsError(e) && CLIENT_ERRORS.has(e.code)) return fail(400, e.code, e.message);
      report(e, "route");
      return fail(500, "HTTP", "Internal server error.");
    }
  };
}
