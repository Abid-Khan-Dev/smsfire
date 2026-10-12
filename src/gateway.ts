import { SmsError } from "./errors";
import type { SmsStatus } from "./types";

export interface GatewayResponse {
  status: number;
  data: any;
}

export interface Gateway {
  send(body: unknown): Promise<GatewayResponse>;
  get(id: string): Promise<GatewayResponse>;
  cancel(id: string): Promise<GatewayResponse>;
}

export interface GatewayOptions {
  url: string;
  authHeader: string;
  local: boolean;
  timeoutMs: number;
  fetch: typeof fetch;
}

/** Local Server uses /message; Cloud and Private use /messages. */
export function createGateway(o: GatewayOptions): Gateway {
  const base = o.local ? "/message" : "/messages";

  async function request(method: string, path: string, body?: unknown): Promise<GatewayResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
    try {
      const res = await o.fetch(o.url + path, {
        method,
        headers: {
          Authorization: o.authHeader,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      return { status: res.status, data };
    } catch (e) {
      // Never include the URL, headers or the original message (may contain credentials).
      throw new SmsError("NETWORK", ctrl.signal.aborted ? "Gateway request timed out." : "Gateway request failed.", {
        cause: e
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    send: (body) => request("POST", base, body),
    get: (id) => request("GET", `${base}/${encodeURIComponent(id)}`),
    cancel: (id) => request("DELETE", `${base}/${encodeURIComponent(id)}`)
  };
}

export function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "Basic " + btoa(bin);
}

const STATE_MAP: Record<string, SmsStatus> = {
  pending: "pending",
  processed: "processed",
  sent: "sent",
  delivered: "delivered",
  failed: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
  cancelling: "pending"
};

export function mapState(state: unknown): SmsStatus | undefined {
  return typeof state === "string" ? STATE_MAP[state.toLowerCase()] : undefined;
}

/** Read status/error from a gateway message object. */
export function readState(data: any): { status?: SmsStatus; error?: string; id?: string } {
  const r = data?.recipients?.[0];
  const status = mapState(data?.state) ?? mapState(r?.state);
  const out: { status?: SmsStatus; error?: string; id?: string } = {};
  if (status) out.status = status;
  if (typeof r?.error === "string" && r.error) out.error = r.error.slice(0, 300);
  if (typeof data?.id === "string" && data.id) out.id = data.id;
  return out;
}

/** Safe, credential-free description of a failed gateway response. */
export function httpError(res: GatewayResponse): SmsError {
  const detail = typeof res.data?.message === "string" ? `: ${res.data.message.slice(0, 200)}` : "";
  if (res.status === 401) {
    return new SmsError("UNAUTHORIZED", "Gateway authentication failed (401). Check your credentials.", { status: 401 });
  }
  if (res.status === 403) {
    return new SmsError("FORBIDDEN_SCOPE", "Gateway denied access (403). The token is missing a required scope.", {
      status: 403
    });
  }
  return new SmsError("HTTP", `Gateway returned HTTP ${res.status}${detail}`, { status: res.status });
}
