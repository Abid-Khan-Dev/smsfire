import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSms, memoryStore, SmsError, type SmsStore } from "../src/index";
import { accepted, CLOUD, fakeGateway, state } from "./fake-gateway";

const TO = "+923001234567";
const make = (script: any, extra: any = {}) => {
  const gw = fakeGateway(script);
  const sms = createSms({ url: CLOUD, token: "secret-jwt", fetch: gw.fetch, ...extra });
  return { gw, sms };
};

describe("config", () => {
  it("validates", () => {
    expect(() => createSms({ url: CLOUD })).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    expect(() => createSms({ url: CLOUD, username: "u" })).toThrow(/username and password/);
    expect(() => createSms({ url: CLOUD, token: "t", username: "u", password: "p" })).toThrow(/not both/);
    expect(() => createSms({ token: "t" })).toThrow(/url is required/);
    expect(() => createSms({ url: "ftp://x", token: "t" })).toThrow(/http/);
    expect(() => createSms({ url: CLOUD, token: "t", retries: -1 })).toThrow(SmsError);
  });
  it("reads env when no config is given", () => {
    process.env.SMSFIRE_URL = CLOUD;
    process.env.SMSFIRE_TOKEN = "t";
    expect(() => createSms({})).not.toThrow();
    delete process.env.SMSFIRE_URL;
    delete process.env.SMSFIRE_TOKEN;
  });
  it("mock mode needs nothing and never touches the network", async () => {
    const sms = createSms({ mock: true });
    const r = await sms.send({ to: TO, message: "hi" });
    expect(r).toMatchObject({ ok: true, status: "sent", attempts: 1, to: TO });
    expect((await sms.logs()).counts.sent).toBe(1);
    expect(await sms.sync()).toBe(0);
  });
});

describe("endpoints and auth", () => {
  it("cloud/private use /messages, local uses /message", async () => {
    const a = make([accepted()]);
    await a.sms.send({ to: TO, message: "x" });
    expect(a.gw.calls[0]!.url).toBe(`${CLOUD}/messages`);

    const b = make([accepted()], { url: "https://sms.example.com/api/3rdparty/v1/" });
    await b.sms.send({ to: TO, message: "x" });
    expect(b.gw.calls[0]!.url).toBe("https://sms.example.com/api/3rdparty/v1/messages");

    const c = make([accepted()], { url: "http://192.168.1.50:8080", token: undefined, username: "u", password: "p" });
    await c.sms.send({ to: TO, message: "x" });
    expect(c.gw.calls[0]!.url).toBe("http://192.168.1.50:8080/message");
    expect(c.gw.calls[0]!.headers.Authorization).toBe("Basic " + btoa("u:p"));
  });
  it("sends bearer token and the expected body", async () => {
    const { gw, sms } = make([accepted("Pending", "id")]);
    await sms.send({ to: TO, message: "  hello  ", priority: 5, simNumber: 2 });
    const c = gw.calls[0]!;
    expect(c.headers.Authorization).toBe("Bearer secret-jwt");
    expect(c.body).toMatchObject({ textMessage: { text: "hello" }, phoneNumbers: [TO], ttl: 86400, withDeliveryReport: true, priority: 5, simNumber: 2 });
    expect(typeof c.body.id).toBe("string");
  });
  it("never leaks credentials or the URL in errors/results", async () => {
    const { sms } = make([{ status: 500, json: { message: "boom" } }]);
    const r = await sms.send({ to: TO, message: "x" });
    expect(JSON.stringify(r)).not.toMatch(/secret-jwt|sms-gate/);
    const n = make(["network"]);
    const errors: unknown[] = [];
    const sms2 = createSms({ url: CLOUD, token: "secret-jwt", fetch: n.gw.fetch, onError: (e) => errors.push(e) });
    await sms2.send({ to: TO, message: "x" });
    expect(String((errors[0] as Error).message)).not.toMatch(/secret-jwt|sms-gate/);
  });
});

describe("validation happens before anything is sent or logged", () => {
  it("validate-all-before-send", async () => {
    const store = memoryStore();
    const { gw, sms } = make([accepted()], { store });
    await expect(sms.send({ to: [TO, "bad"], message: "x" })).rejects.toMatchObject({ code: "INVALID_PHONE" });
    await expect(sms.send({ to: TO })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(sms.send({ to: TO, message: "a", template: "b" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(sms.send({ to: TO, message: "   " })).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
    await expect(sms.send({ to: TO, message: "x".repeat(1601) })).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
    await expect(sms.send({ to: TO, template: "nope" })).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    await expect(sms.send({ to: Array(101).fill(TO), message: "x" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(sms.send({ to: TO, message: "x", ttl: 10, validUntil: new Date(Date.now() + 1e6) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(sms.send({ to: TO, message: "x", scheduleAt: new Date(Date.now() + 1e7), validUntil: new Date(Date.now() + 1e6) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(gw.calls).toHaveLength(0);
    expect((await store.counts()).total).toBe(0);
  });
  it("templates: missing variable never reaches the gateway", async () => {
    const { gw, sms } = make([accepted()], { templates: { due: "Hi {name}, Rs {amount} is due." } });
    await expect(sms.send({ to: TO, template: "due", vars: { name: "A" } })).rejects.toMatchObject({ code: "TEMPLATE_VARIABLE_MISSING" });
    expect(gw.calls).toHaveLength(0);
    await sms.send({ to: TO, template: "due", vars: { name: "A", amount: 10 } });
    expect(gw.calls[0]!.body.textMessage.text).toBe("Hi A, Rs 10 is due.");
  });
  it("normalizes with country, dedupes, one request per recipient", async () => {
    const { gw, sms } = make((_c, n) => accepted("Pending", "g" + n), { country: "92" });
    const r = await sms.send({ to: ["0300 1234567", "+923001234567", "0301 1111111"], message: "x" });
    expect(Array.isArray(r)).toBe(true);
    expect(r).toHaveLength(2);
    expect(gw.calls).toHaveLength(2);
    expect(gw.calls.map((c) => c.body.phoneNumbers[0]).sort()).toEqual(["+923001234567", "+923011111111"]);
  });
  it("bulk respects concurrency", async () => {
    let active = 0;
    let peak = 0;
    const fetchFn = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response(JSON.stringify({ state: "Pending" }), { status: 202 });
    }) as unknown as typeof fetch;
    const sms = createSms({ url: CLOUD, token: "t", fetch: fetchFn, concurrency: 3 });
    const to = Array.from({ length: 12 }, (_, i) => `+92300${String(1000000 + i)}`);
    const r = await sms.send({ to, message: "x" });
    expect(r).toHaveLength(12);
    expect(peak).toBe(3);
  });
});

describe("store failure rules", () => {
  const broken = (over: Partial<SmsStore>): SmsStore => ({ ...memoryStore(), ...over });
  it("no-send-when-store-create-fails", async () => {
    const { gw, sms } = make([accepted()], { store: broken({ create: async () => { throw new Error("db down"); } }) });
    await expect(sms.send({ to: TO, message: "x" })).rejects.toMatchObject({ code: "CONFIG" });
    expect(gw.calls).toHaveLength(0);
  });
  it("bulk store failure becomes per-recipient failed results", async () => {
    const { gw, sms } = make([accepted()], { store: broken({ create: async () => { throw new Error("db down"); } }) });
    const r = (await sms.send({ to: [TO, "+923011111111"], message: "x" })) as any[];
    expect(r.every((x) => !x.ok && x.attempts === 0)).toBe(true);
    expect(gw.calls).toHaveLength(0);
  });
  it("send-result-survives-store-update-failure (and does not resend)", async () => {
    const errors: string[] = [];
    const { gw, sms } = make([accepted()], { store: broken({ update: async () => { throw new Error("db down"); } }), onError: (_e: unknown, c: string) => errors.push(c) });
    const r = await sms.send({ to: TO, message: "x" });
    expect(r.ok).toBe(true);
    expect(gw.calls).toHaveLength(1);
    expect(errors).toContain("store.update");
  });
});

describe("retries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const run = async (p: Promise<any>) => {
    await vi.runAllTimersAsync();
    return p;
  };

  it("retries only 429/502/503/504 and reuses the same gateway id", async () => {
    for (const status of [429, 502, 503, 504]) {
      const { gw, sms } = make([{ status }, { status }, accepted()]);
      const r = await run(sms.send({ to: TO, message: "x" }));
      expect(r).toMatchObject({ ok: true, attempts: 3 });
      expect(new Set(gw.calls.map((c) => c.body.id)).size).toBe(1);
    }
  });
  it("gives up after `retries` and marks failed", async () => {
    const { gw, sms } = make([{ status: 503 }]);
    const r = await run(sms.send({ to: TO, message: "x" }));
    expect(r).toMatchObject({ ok: false, status: "failed", attempts: 3 });
    expect(gw.calls).toHaveLength(3);
  });
  it("backoff is 300ms then 600ms", async () => {
    const { gw, sms } = make([{ status: 503 }]);
    const p = sms.send({ to: TO, message: "x" });
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(gw.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gw.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(599);
    expect(gw.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(gw.calls).toHaveLength(3);
    await p;
  });
  it("does not retry 400/401/403/404/409-other statuses", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const { gw, sms } = make([{ status }]);
      const r = await run(sms.send({ to: TO, message: "x" }));
      expect(r).toMatchObject({ ok: false, status: "failed", attempts: 1 });
      expect(gw.calls).toHaveLength(1);
    }
  });
  it("401/403 give clear, credential-free messages", async () => {
    expect((await run(make([{ status: 401 }]).sms.send({ to: TO, message: "x" }))).error).toMatch(/authentication failed/);
    expect((await run(make([{ status: 403 }]).sms.send({ to: TO, message: "x" }))).error).toMatch(/scope/);
  });
  it("network error is NOT retried by default and stays pending/unknown", async () => {
    const { gw, sms } = make(["network"]);
    const r = await run(sms.send({ to: TO, message: "x" }));
    expect(gw.calls).toHaveLength(1);
    expect(r).toMatchObject({ status: "pending", ok: true, attempts: 1 });
    expect(r.error).toMatch(/delivery state is unknown/);
  });
  it("timeout is treated like a network error", async () => {
    const { gw, sms } = make(["timeout"], { timeoutMs: 1000 });
    const r = await run(sms.send({ to: TO, message: "x" }));
    expect(gw.calls).toHaveLength(1);
    expect(r.status).toBe("pending");
  });
  it("retryNetworkErrors=true retries with the SAME id", async () => {
    const { gw, sms } = make(["network", "timeout", accepted()], { retryNetworkErrors: true, timeoutMs: 1000 });
    const r = await run(sms.send({ to: TO, message: "x" }));
    expect(r).toMatchObject({ ok: true, attempts: 3 });
    expect(new Set(gw.calls.map((c) => c.body.id)).size).toBe(1);
  });
  it("duplicate id (409) after a retry reads the gateway state instead of resending", async () => {
    const { gw, sms } = make([{ status: 503 }, { status: 409 }, state("Sent")]);
    const r = await run(sms.send({ to: TO, message: "x" }));
    expect(r).toMatchObject({ ok: true, status: "sent" });
    expect(gw.calls.map((c) => c.method)).toEqual(["POST", "POST", "GET"]);
  });
  it("tolerates invalid JSON in a 202", async () => {
    const { sms } = make([{ status: 202, text: "<html>" }]);
    expect(await run(sms.send({ to: TO, message: "x" }))).toMatchObject({ ok: true, status: "pending" });
  });
});

describe("idempotency key", () => {
  it("returns the existing log and does not send again", async () => {
    const { gw, sms } = make([accepted()]);
    const a = (await sms.send({ to: TO, message: "x", key: "inv-1" })) as any;
    const b = (await sms.send({ to: TO, message: "x", key: "inv-1" })) as any;
    expect(b.id).toBe(a.id);
    expect(gw.calls).toHaveLength(1);
  });
  it("bulk uses one effective key per recipient", async () => {
    const { gw, sms } = make([accepted()]);
    const to = [TO, "+923011111111"];
    await sms.send({ to, message: "x", key: "inv-2" });
    await sms.send({ to: [...to, "+923022222222"], message: "x", key: "inv-2" });
    expect(gw.calls).toHaveLength(3);
    expect((await sms.logs({ key: "inv-2" })).items.map((l) => l.key).sort()).toEqual(["inv-2:+923001234567", "inv-2:+923011111111", "inv-2:+923022222222"]);
  });
  it("concurrent identical keys: a unique-key race returns the winner", async () => {
    const real = memoryStore();
    let first = true;
    const racy: SmsStore = {
      ...real,
      create: async (l) => {
        if (first) {
          first = false;
          await real.create({ ...l, id: "winner", gatewayMessageId: "winner" });
          throw new Error("E11000 duplicate key");
        }
        return real.create(l);
      }
    };
    const { gw, sms } = make([accepted()], { store: racy });
    const r = (await sms.send({ to: TO, message: "x", key: "k" })) as any;
    expect(r.id).toBe("winner");
    expect(gw.calls).toHaveLength(0);
  });
});
