export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}
export type Reply = { status: number; json?: unknown; body?: unknown; text?: string } | "timeout" | "network";

/** A scriptable fake gateway. Replies are consumed in order; the last one repeats. */
export function fakeGateway(script: Reply[] | ((call: Call, n: number) => Reply)) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: any) => {
    const call: Call = {
      method: init.method,
      url,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined
    };
    calls.push(call);
    const n = calls.length - 1;
    const reply = typeof script === "function" ? script(call, n) : script[Math.min(n, script.length - 1)]!;
    if (reply === "network") throw new TypeError("fetch failed");
    if (reply === "timeout") {
      return new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    }
    const payload = reply.json !== undefined ? reply.json : reply.body;
    const text = reply.text ?? (payload !== undefined ? JSON.stringify(payload) : "");
    return new Response(text, { status: reply.status });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

export const accepted = (st = "Pending", id?: string) => ({
  status: 202,
  json: { ...(id ? { id } : {}), state: st, recipients: [{ phoneNumber: "+923001234567", state: st }] }
});
export const state = (s: string, error?: string) => ({
  status: 200,
  json: { state: s, recipients: [{ state: s, ...(error ? { error } : {}) }] }
});

export const CLOUD = "https://api.sms-gate.app/3rdparty/v1";
export const URL_CLOUD = CLOUD;
export const URL_LOCAL = "http://192.168.1.50:8080";
export const AUTH = { username: "user", password: "pass" };
