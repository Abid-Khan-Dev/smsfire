import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createSms, memoryStore, type Sms } from "../src/index";
import { smsHandler } from "../src/fetch";
import { smsRouter } from "../src/express";
import { createSmsClient } from "../src/client";
import { accepted, fakeGateway, URL_CLOUD } from "./fake-gateway";

const TO = "+923001234567";
const authOk = (req: any) => (req.headers?.get ? req.headers.get("authorization") : req.headers.authorization) === "Bearer app";
const H = { authorization: "Bearer app", "content-type": "application/json" };

function make(replies: any = [accepted()]) {
  const gw = fakeGateway(replies);
  const sms = createSms({ url: URL_CLOUD, token: "gw-secret-token", fetch: gw.fetch, store: memoryStore(), templates: { due: "Hi {name}" } });
  return { gw, sms };
}
const post = (h: (r: Request) => Promise<Response>, path: string, body: unknown, headers: any = H) =>
  h(new Request("http://x" + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("adapter creation", () => {
  it("throws without auth unless unsafeNoAuth", () => {
    const { sms } = make();
    expect(() => smsHandler(sms, {} as any)).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    expect(() => smsRouter(sms, {} as any)).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    expect(() => smsHandler(sms, { unsafeNoAuth: true })).not.toThrow();
  });
});

describe("fetch handler", () => {
  it("auth: 401 without the right credentials, even for GET", async () => {
    const { sms, gw } = make();
    const h = smsHandler(sms, { auth: authOk });
    expect((await post(h, "/api/sms/send", { to: TO, message: "x" }, {})).status).toBe(401);
    expect((await h(new Request("http://x/api/sms/logs"))).status).toBe(401);
    expect(gw.calls).toHaveLength(0);
  });
  it("send / logs / get / sync / cancel", async () => {
    const { sms } = make((c: any) => (c.method === "POST" ? accepted() : c.method === "DELETE" ? { status: 202, body: { state: "Cancelling" } } : { status: 200, body: { state: "Sent" } }));
    const h = smsHandler(sms, { auth: authOk });
    const res = await post(h, "/api/sms/send", { to: TO, template: "due", vars: { name: "A" }, key: "k" });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const id = data.results[0].id;
    const logs = await (await h(new Request("http://x/api/sms/logs?status=pending&limit=5", { headers: H }))).json();
    expect(logs.data.items).toHaveLength(1);
    expect(logs.data.counts.pending).toBe(1);
    expect((await (await h(new Request(`http://x/api/sms/logs/${id}`, { headers: H }))).json()).data.id).toBe(id);
    expect((await h(new Request("http://x/api/sms/logs/nope", { headers: H }))).status).toBe(404);
    expect((await (await post(h, "/api/sms/sync", "")).json()).data.updated).toBe(1);
    expect((await post(h, `/api/sms/cancel/${id}`, "")).status).toBe(200); // "sent" is not terminal; the gateway accepts the cancel
    expect((await h(new Request("http://x/api/sms/nothing", { headers: H }))).status).toBe(404);
  });
  it("validation -> 400, bad JSON -> 400, too large -> 413", async () => {
    const { sms } = make();
    const h = smsHandler(sms, { auth: authOk });
    const bad = await post(h, "/s/send", { to: "abc", message: "x" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("INVALID_PHONE");
    expect((await post(h, "/s/send", "{nope")).status).toBe(400);
    expect((await post(h, "/s/send", { to: TO, message: "x".repeat(25_000) })).status).toBe(413);
    const noLen = new Request("http://x/s/send", { method: "POST", headers: H, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(30_000))); c.close(); } }), duplex: "half" } as any);
    expect((await h(noLen)).status).toBe(413);
  });
  it("all-recipient failure -> 502 with results; partial success -> 200", async () => {
    const { sms } = make([{ status: 400 }]);
    const h = smsHandler(sms, { auth: authOk });
    const r = await post(h, "/s/send", { to: [TO, "+923001234568"], message: "x" });
    expect(r.status).toBe(502);
    expect((await r.json()).data.results).toHaveLength(2);
    const { sms: s2 } = make([accepted(), { status: 400 }]);
    const r2 = await post(smsHandler(s2, { auth: authOk, maxRecipients: 5 }), "/s/send", { to: [TO, "+923001234568"], message: "x" });
    expect(r2.status).toBe(200);
  });
  it("maxRecipients and allowCustomMessage=false", async () => {
    const { sms, gw } = make();
    const h = smsHandler(sms, { auth: authOk, maxRecipients: 2, allowCustomMessage: false });
    expect((await post(h, "/s/send", { to: [TO, "+923001234568", "+923001234569"], template: "due", vars: { name: "A" } })).status).toBe(400);
    expect((await post(h, "/s/send", { to: TO, message: "free text" })).status).toBe(400);
    expect((await post(h, "/s/send", { to: TO, template: "due", vars: { name: "A" } })).status).toBe(200);
    expect(gw.calls).toHaveLength(1);
  });
  it("prepare() adds metadata, can restrict recipients, can reject; clients cannot set deviceId/ttl", async () => {
    const { sms, gw } = make();
    const h = smsHandler(sms, {
      auth: authOk,
      prepare: (req, input) => {
        if (input.to !== TO) throw new (class extends Error { name = "SmsError"; code = "INVALID_INPUT"; })("Recipient not allowed");
        return { ...input, meta: { ...input.meta, userId: 42 } };
      }
    });
    const ok = await post(h, "/s/send", { to: TO, message: "x", meta: { userId: 1 }, deviceId: "evil", ttl: 1, simNumber: 3, priority: 127 });
    expect(ok.status).toBe(200);
    const { id } = (await ok.json()).data.results[0];
    expect((await sms.get(id))?.meta).toEqual({ userId: 42 });
    expect(gw.calls[0]!.body.deviceId).toBeUndefined();
    expect(gw.calls[0]!.body.simNumber).toBeUndefined();
    expect(gw.calls[0]!.body.priority).toBeUndefined();
    const rej = await post(h, "/s/send", { to: "+923009999999", message: "x" });
    expect(rej.status).toBe(400);
  });
  it("unexpected errors give a generic 500, call onError and leak nothing", async () => {
    const { sms } = make();
    const onError = vi.fn();
    const boom = { ...sms, sync: async () => { throw new Error("secret gw-secret-token http://192.168.1.50"); } } as unknown as Sms;
    const h = smsHandler(boom, { auth: authOk, onError });
    const r = await post(h, "/s/sync", "");
    const text = await r.text();
    expect(r.status).toBe(500);
    expect(text).not.toMatch(/secret|192\.168|gw-/);
    expect(onError).toHaveBeenCalled();
  });
  it("a throwing auth function denies access", async () => {
    const { sms } = make();
    const h = smsHandler(sms, { auth: () => { throw new Error("x"); } });
    expect((await h(new Request("http://x/s/logs"))).status).toBe(401);
  });
  describe("webhook route", () => {
    async function sign(body: string, secret: string, ts: string) {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body + ts)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    it("is the only unauthenticated route; needs a valid fresh signature; 404 when not configured", async () => {
      const { sms } = make();
      const h = smsHandler(sms, { auth: authOk, webhook: { secret: "s" } });
      const sent = await post(h, "/s/send", { to: TO, message: "x" }, {});
      expect(sent.status).toBe(401);
      const ok = await post(h, "/s/send", { to: TO, message: "x" }, H);
      const msgId = (await ok.json()).data.results[0].id;
      const body = JSON.stringify({ event: "sms:sent", payload: { messageId: msgId } });
      const ts = String(Math.floor(Date.now() / 1000));
      const good = await post(h, "/s/webhook", body, { "x-timestamp": ts, "x-signature": await sign(body, "s", ts) });
      expect(good.status).toBe(200);
      expect((await sms.get(msgId))?.status).toBe("sent");
      expect((await post(h, "/s/webhook", body, { "x-timestamp": ts, "x-signature": "bad" })).status).toBe(401);
      expect((await post(smsHandler(sms, { auth: authOk }), "/s/webhook", body, {})).status).toBe(404);
    });
  });
});

describe("express adapter (real http server)", () => {
  let server: Server;
  let base: string;
  const { sms, gw } = make((c: any) => (c.method === "POST" ? accepted() : { status: 200, body: { state: "Delivered" } }));
  const secret = "whsec";

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function start() {
    const app = express();
    app.use("/sms", smsRouter(sms, { auth: authOk, webhook: { secret } }));
    app.use(express.json());
    app.get("/other", (_req, res) => res.json({ other: true }));
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves routes mounted at /sms, leaves other routes alone", async () => {
    await start();
    const j = (p: string, init: any = {}) => fetch(base + p, { headers: H, ...init });
    expect((await fetch(base + "/other")).status).toBe(200);
    expect((await fetch(base + "/sms/logs")).status).toBe(401);
    const r = await j("/sms/send", { method: "POST", body: JSON.stringify({ to: TO, message: "hi" }) });
    expect(r.status).toBe(200);
    const id = (await r.json()).data.results[0].id;
    expect((await (await j("/sms/logs")).json()).data.items[0].id).toBe(id);
    expect((await (await j("/sms/sync", { method: "POST" })).json()).data.updated).toBe(1);
    expect((await (await j(`/sms/logs/${id}`)).json()).data.status).toBe("delivered");
    expect((await j("/sms/send", { method: "POST", body: "{bad" })).status).toBe(400);
    expect((await j("/sms/send", { method: "POST", body: JSON.stringify({ to: TO, message: "x".repeat(30_000) }) })).status).toBe(413);
    expect(gw.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("verifies webhook signatures against the raw body", async () => {
    const created = await sms.send({ to: TO, message: "w" });
    const body = JSON.stringify({ event: "sms:failed", payload: { messageId: created.id, reason: "x" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body + ts)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const ok = await fetch(base + "/sms/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig } });
    expect(ok.status).toBe(200);
    expect((await sms.get(created.id))?.status).toBe("failed");
    const bad = await fetch(base + "/sms/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": "0".repeat(64) } });
    expect(bad.status).toBe(401);
  });
});

describe("client", () => {
  it("round-trips through the fetch handler without ever knowing gateway details", async () => {
    const { sms } = make((c: any) => (c.method === "POST" ? accepted() : c.method === "DELETE" ? { status: 409 } : { status: 200, body: { state: "Sent" } }));
    const handler = smsHandler(sms, { auth: authOk });
    const client = createSmsClient({
      baseUrl: "http://app.test/api/sms/",
      headers: () => ({ authorization: "Bearer app" }),
      fetch: ((u: any, i: any) => handler(new Request(u, i))) as any
    });
    const one = await client.send({ to: TO, message: "hi" });
    expect(Array.isArray(one)).toBe(false);
    expect(one).toMatchObject({ ok: true, status: "pending" });
    const many = await client.send({ to: [TO, "+923001234568"], message: "hi" });
    expect(many).toHaveLength(2);
    const logs = await client.logs({ status: "pending", limit: 1 });
    expect(logs.items).toHaveLength(1);
    expect(logs.nextCursor).toBeTruthy();
    expect(await client.sync()).toBe(3);
    expect((await client.get(one.id))?.status).toBe("sent");
    expect(await client.get("missing")).toBeNull();
    expect(await client.cancel(one.id)).toMatchObject({ ok: false });
  });
  it("throws SmsError for auth/validation failures", async () => {
    const { sms } = make();
    const handler = smsHandler(sms, { auth: authOk });
    const f = ((u: any, i: any) => handler(new Request(u, i))) as any;
    await expect(createSmsClient({ baseUrl: "http://a/s", fetch: f }).logs()).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    await expect(createSmsClient({ baseUrl: "http://a/s", headers: { authorization: "Bearer app" }, fetch: f }).send({ to: "x", message: "y" })).rejects.toMatchObject({ code: "INVALID_PHONE" });
    await expect(createSmsClient({ baseUrl: "http://a/s", fetch: (async () => { throw new Error("down"); }) as any }).sync()).rejects.toMatchObject({ code: "NETWORK" });
  });
});
