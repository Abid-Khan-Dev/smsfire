import { SmsError } from "./errors";
import type { CancelResult, LogsQuery, LogsResult, LogSource, SendInput, SendResult, SmsLog } from "./types";

export interface SmsClientConfig {
  /** URL of your backend routes, e.g. "/api/sms". */
  baseUrl: string;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
}

export interface SmsClient extends LogSource {
  send(input: SendInput & { to: string[] }): Promise<SendResult[]>;
  send(input: SendInput & { to: string }): Promise<SendResult>;
  send(input: SendInput): Promise<SendResult | SendResult[]>;
  logs(query?: LogsQuery): Promise<LogsResult>;
  get(id: string): Promise<SmsLog | null>;
  sync(): Promise<number>;
  cancel(id: string): Promise<CancelResult>;
}

/** Talks to YOUR backend (smsRouter / smsHandler), never to the SMS gateway. */
export function createSmsClient(config: SmsClientConfig): SmsClient {
  const base = config.baseUrl.replace(/\/+$/, "");
  const f = config.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (!f) throw new SmsError("CONFIG", "No fetch implementation available.");

  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const extra = typeof config.headers === "function" ? await config.headers() : (config.headers ?? {});
    let res: Response;
    try {
      res = await f!(base + path, {
        method,
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extra },
        ...(config.credentials ? { credentials: config.credentials } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch (e) {
      throw new SmsError("NETWORK", "Could not reach the server.", { cause: e });
    }
    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new SmsError("HTTP", `Unexpected response (HTTP ${res.status}).`, { status: res.status });
    }
    return { json, status: res.status };
  }

  function unwrap({ json, status }: { json: any; status: number }): any {
    if (json?.ok === true) return json.data;
    const code = json?.error?.code ?? "HTTP";
    throw new SmsError(code, json?.error?.message ?? `Request failed (HTTP ${status}).`, { status });
  }

  return {
    async send(input: SendInput): Promise<any> {
      const r = await call("POST", "/send", input);
      const results = r.json?.data?.results; // 502 (all failed) still carries per-recipient results
      if (!Array.isArray(results)) unwrap(r);
      return Array.isArray(input.to) ? results : results[0];
    },
    async logs(query = {}) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
      const s = qs.toString();
      return unwrap(await call("GET", "/logs" + (s ? "?" + s : "")));
    },
    async get(id) {
      const r = await call("GET", `/logs/${encodeURIComponent(id)}`);
      if (r.status === 404) return null;
      return unwrap(r);
    },
    async sync() {
      return unwrap(await call("POST", "/sync", {})).updated;
    },
    async cancel(id) {
      const r = await call("POST", `/cancel/${encodeURIComponent(id)}`, {});
      if (r.json?.data && typeof r.json.data.ok === "boolean") return r.json.data;
      return unwrap(r);
    }
  } as SmsClient;
}
