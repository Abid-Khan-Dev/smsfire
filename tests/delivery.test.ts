import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSms, memoryStore, verifyWebhook, type SmsLog } from "../src/index";
import { accepted, fakeGateway, URL_CLOUD } from "./fake-gateway";

const TO = "+923001234567";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const state = (s: string, error?: string) => ({ status: 200, body: { id: "gw-1", state: s, recipients: [{ state: s, ...(error ? { error } : {}) }] } });

function setup(replies: any, extra: object = {}) {
  const gw = fakeGateway(replies);
  const store = memoryStore();
  const sms = createSms({ url: URL_CLOUD, token: "t", fetch: gw.fetch, store, ...extra });
  return { gw, store, sms };
}

describe("sync", () => {
  it("202 -> pending -> sync -> sent -> delivered, and counts updates", async () => {
    let step = 0;
    const seq = ["Processed", "Sent", "Delivered"];
    const { gw, sms } = setup((c: any) => (c.method === "POST" ? accepted() : state(seq[step++]!)));
    const r = await sms.send({ to: TO, message: "x" });
    expect(r.status).toBe("pending");
    expect(await sms.sync()).toBe(1);
    expect((await sms.get(r.id))?.status).toBe("processed");
    expect(await sms.sync()).toBe(1);
    expect((await sms.get(r.id))?.status).toBe("sent");
    expect(await sms.sync()).toBe(1);
    expect((await sms.get(r.id))?.status).toBe("delivered");
    expect(await sms.sync()).toBe(0); // terminal logs are never polled again
    expect(gw.calls.filter((c) => c.method === "GET")).toHaveLength(3);
    expect(gw.calls[1]!.url).toBe(`${URL_CLOUD}/messages/${r.id}`);
  });
  it("delivered never regresses; failed stores the reason", async () => {
    const { store, sms } = setup((c: any) => (c.method === "POST" ? accepted() : state("Sent")));
    const r = await sms.send({ to: TO, message: "x" });
    await store.update(r.id, { status: "delivered" });
    expect(await sms.sync()).toBe(0);
    expect((await sms.get(r.id))?.status).toBe("delivered");

    const b = setup((c: any) => (c.method === "POST" ? accepted() : state("Failed", "Radio off")));
    const r2 = await b.sms.send({ to: TO, message: "x" });
    await b.sms.sync();
    expect(await b.sms.get(r2.id)).toMatchObject({ status: "failed", error: "Radio off" });
  });
  it("Cancelling maps to pending (no change)", async () => {
    const { sms } = setup((c: any) => (c.method === "POST" ? accepted() : state("Cancelling")));
    const r = await sms.send({ to: TO, message: "x" });
    expect(await sms.sync()).toBe(0);
    expect((await sms.get(r.id))?.status).toBe("pending");
  });
  it("does not poll sent logs when deliveryReport=false, and skips old sent logs", async () => {
    const a = setup((c: any) => (c.method === "POST" ? accepted("Sent") : state("Delivered")), { deliveryReport: false });
    await a.sms.send({ to: TO, message: "x" });
    expect(await a.sms.sync()).toBe(0);
    expect(a.gw.calls.filter((c) => c.method === "GET")).toHaveLength(0);

    const b = setup((c: any) => (c.method === "POST" ? accepted("Sent") : state("Delivered")));
    await b.sms.send({ to: TO, message: "x" });
    vi.setSystemTime(Date.now() + 25 * 3600 * 1000);
    expect(await b.sms.sync()).toBe(0);
  });
  it("unknown-outcome log: 404 after the grace period means failed, before it stays pending", async () => {
    const { sms } = setup((c: any) => (c.method === "POST" ? "network" : { status: 404 }));
    const r = await sms.send({ to: TO, message: "x" });
    expect(r.status).toBe("pending");
    expect(await sms.sync()).toBe(0);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    expect(await sms.sync()).toBe(1);
    expect(await sms.get(r.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/no record/) });
  });
  it("unknown-outcome log that the gateway accepted resolves and clears the error", async () => {
    const { sms } = setup((c: any) => (c.method === "POST" ? "network" : state("Sent")));
    const r = await sms.send({ to: TO, message: "x" });
    await sms.sync();
    const log = await sms.get(r.id);
    expect(log?.status).toBe("sent");
    expect(log?.error).toBeUndefined();
  });
  it("one failing lookup does not stop the rest (and is reported)", async () => {
    const onError = vi.fn();
    let n = 0;
    const { sms } = setup((c: any) => (c.method === "POST" ? accepted() : ++n === 1 ? "network" : state("Sent")), { onError });
    await sms.send({ to: [TO, "+923001234568"], message: "x" });
    expect(await sms.sync()).toBe(1);
    expect(onError).toHaveBeenCalled();
  });
});

describe("gateway id", () => {
  it("uses the id returned by the gateway for later lookups when it differs from ours", async () => {
    const { gw, sms } = setup((c: any) => (c.method === "POST" ? { status: 202, body: { id: "gw-9", state: "Pending" } } : state("Sent")));
    const r = await sms.send({ to: TO, message: "x" });
    expect(await sms.get(r.id)).toMatchObject({ gatewayMessageId: "gw-9", providerId: "gw-9" });
    expect(await sms.get("gw-9")).toMatchObject({ id: r.id });
    await sms.sync();
    expect(gw.calls.at(-1)!.url).toBe(`${URL_CLOUD}/messages/gw-9`);
  });
});

describe("watch", () => {
  it("only runs when started, skips overlapping ticks, and stops", async () => {
    let gets = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gw = fakeGateway((c) => (c.method === "POST" ? accepted() : state("Sent")));
    const slow: typeof fetch = (async (u: any, i: any) => { if (i.method === "GET") { gets++; await gate; } return gw.fetch(u, i); }) as any;
    const sms = createSms({ url: URL_CLOUD, token: "t", fetch: slow });
    await sms.send({ to: TO, message: "x" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gets).toBe(0); // nothing automatic
    const stop = sms.watch({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(gets).toBe(1); // later ticks skipped while the first sync is still running
    release();
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    const after = gets;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gets).toBe(after);
  });
});

describe("cancel", () => {
  it("accepted", async () => {
    const { gw, sms } = setup((c: any) => (c.method === "POST" ? accepted() : c.method === "DELETE" ? { status: 202, body: { state: "Cancelling" } } : state("Cancelled")));
    const r = await sms.send({ to: TO, message: "x" });
    expect(await sms.cancel(r.id)).toMatchObject({ ok: true, status: "pending" });
    expect(gw.calls.at(-1)).toMatchObject({ method: "DELETE", url: `${URL_CLOUD}/messages/${r.id}` });
    await sms.sync();
    expect((await sms.get(r.id))?.status).toBe("cancelled");
  });
  it("409 is a normal failure result, not a crash", async () => {
    const { sms } = setup((c: any) => (c.method === "POST" ? accepted() : { status: 409 }));
    const r = await sms.send({ to: TO, message: "x" });
    expect(await sms.cancel(r.id)).toMatchObject({ ok: false, status: "pending", error: expect.stringMatching(/no longer allows/) });
  });
  it("terminal logs, unknown ids and network errors", async () => {
    const { store, sms } = setup((c: any) => (c.method === "POST" ? accepted() : "network"));
    const r = await sms.send({ to: TO, message: "x" });
    expect(await sms.cancel(r.id)).toMatchObject({ ok: false, error: expect.stringMatching(/unknown/) });
    await store.update(r.id, { status: "delivered" });
    expect(await sms.cancel(r.id)).toMatchObject({ ok: false, status: "delivered" });
    await expect(sms.cancel("nope")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

// ---- webhooks ----
async function sign(body: string, secret: string, ts: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body + ts)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const evt = (event: string, messageId: string, extra: object = {}) => JSON.stringify({ deviceId: "d", event, id: "w1", webhookId: "w", payload: { messageId, phoneNumber: TO, ...extra } });
const ts = () => String(Math.floor(Date.now() / 1000));

describe("webhooks", () => {
  const secret = "s3cret";
  it("valid signature passes; headers can be Headers or a plain object", async () => {
    const body = evt("sms:sent", "x"), t = ts(), sig = await sign(body, secret, t);
    await expect(verifyWebhook(body, { "X-Signature": sig, "X-Timestamp": t }, secret)).resolves.toBe(true);
    await expect(verifyWebhook(body, new Headers({ "x-signature": sig, "x-timestamp": t }), secret)).resolves.toBe(true);
  });
  it("rejects invalid, tampered, missing and expired", async () => {
    const body = evt("sms:sent", "x"), t = ts(), sig = await sign(body, secret, t);
    const unauth = { code: "UNAUTHORIZED" };
    await expect(verifyWebhook(body, { "x-signature": "00" + sig.slice(2), "x-timestamp": t }, secret)).rejects.toMatchObject(unauth);
    await expect(verifyWebhook(body + " ", { "x-signature": sig, "x-timestamp": t }, secret)).rejects.toMatchObject(unauth);
    await expect(verifyWebhook(body, {}, secret)).rejects.toMatchObject(unauth);
    const old = String(Math.floor(Date.now() / 1000) - 301);
    await expect(verifyWebhook(body, { "x-signature": await sign(body, secret, old), "x-timestamp": old }, secret)).rejects.toMatchObject({ code: "UNAUTHORIZED", message: expect.stringMatching(/expired/) });
    await expect(verifyWebhook(body, { "x-signature": sig, "x-timestamp": t }, "other")).rejects.toMatchObject(unauth);
  });
  async function hook(sms: any, body: string) {
    const t = ts();
    return sms.handleWebhook(body, { "x-signature": await sign(body, secret, t), "x-timestamp": t }, { secret });
  }
  it("updates logs, ignores unknown events/ids, protects terminal states", async () => {
    const { sms } = setup([accepted()]);
    const r = await sms.send({ to: TO, message: "short" });
    expect(await hook(sms, evt("sms:sent", r.id))).toMatchObject({ handled: true, status: "sent" });
    expect(await hook(sms, evt("sms:delivered", r.id))).toMatchObject({ handled: true, status: "delivered" });
    expect(await hook(sms, evt("sms:sent", r.id))).toMatchObject({ handled: true, status: "delivered" }); // no regression
    expect(await hook(sms, evt("sms:failed", r.id, { reason: "late" }))).toMatchObject({ status: "delivered" });
    expect((await sms.get(r.id))?.status).toBe("delivered");
    expect(await hook(sms, evt("sms:received", r.id))).toEqual({ handled: false });
    expect(await hook(sms, evt("system:ping", r.id))).toEqual({ handled: false });
    expect(await hook(sms, evt("sms:sent", "unknown-id"))).toEqual({ handled: false });
    expect(await hook(sms, JSON.stringify({ event: "sms:sent" }))).toEqual({ handled: false });
  });
  it("failed event stores the reason; cancelled works", async () => {
    const { sms } = setup([accepted()]);
    const a = await sms.send({ to: TO, message: "x" });
    await hook(sms, evt("sms:failed", a.id, { reason: "No credit" }));
    expect(await sms.get(a.id)).toMatchObject({ status: "failed", error: "No credit" });
    const b = await sms.send({ to: TO, message: "y" });
    await hook(sms, evt("sms:cancelled", b.id));
    expect((await sms.get(b.id))?.status).toBe("cancelled");
  });
  it("multipart delivered events only advance to sent; sync confirms delivery", async () => {
    const { sms } = setup([accepted()]);
    const r = await sms.send({ to: TO, message: "a".repeat(300) });
    expect(await hook(sms, evt("sms:delivered", r.id))).toMatchObject({ status: "sent" });
  });
  it("rejects bad signatures and invalid JSON through handleWebhook", async () => {
    const { sms } = setup([accepted()]);
    await expect(sms.handleWebhook("{}", { "x-signature": "a", "x-timestamp": ts() }, { secret })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(hook(sms, "not json")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
