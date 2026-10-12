import { describe, expect, it } from "vitest";
import { createSms } from "../src/index";
import { accepted, AUTH, fakeGateway, URL_CLOUD, URL_LOCAL } from "./fake-gateway";

describe("doctor", () => {
  it("passes against a healthy gateway (404 on the probe id is the success signal)", async () => {
    const gw = fakeGateway((c) => (c.method === "GET" ? { status: 404 } : accepted()));
    const checks = await createSms({ url: URL_CLOUD, token: "t", fetch: gw.fetch }).doctor();
    expect(checks.map((c) => [c.check, c.ok])).toEqual([["Configuration", true], ["Gateway reachable", true], ["Authentication", true], ["Read scope", true]]);
  });
  it("401 -> auth failure with a hint", async () => {
    const gw = fakeGateway([{ status: 401 }]);
    const checks = await createSms({ url: URL_LOCAL, ...AUTH, fetch: gw.fetch }).doctor();
    expect(checks.find((c) => c.check === "Authentication")).toMatchObject({ ok: false, hint: expect.any(String) });
  });
  it("403 -> missing scope", async () => {
    const gw = fakeGateway([{ status: 403 }]);
    const checks = await createSms({ url: URL_CLOUD, token: "t", fetch: gw.fetch }).doctor();
    expect(checks.find((c) => c.check === "Read scope")).toMatchObject({ ok: false, hint: expect.stringMatching(/messages:read/) });
  });
  it("unreachable gateway -> failed check, never throws, no secrets in output", async () => {
    const gw = fakeGateway(["network"]);
    const checks = await createSms({ url: URL_LOCAL, username: "secretuser", password: "secretpass", fetch: gw.fetch }).doctor();
    expect(checks.find((c) => c.check === "Gateway reachable")).toMatchObject({ ok: false });
    expect(JSON.stringify(checks)).not.toMatch(/secret|192\.168/);
  });
  it("optional test send", async () => {
    const gw = fakeGateway((c) => (c.method === "GET" ? { status: 404 } : accepted()));
    const checks = await createSms({ url: URL_CLOUD, token: "t", fetch: gw.fetch }).doctor({ sendTo: "+923001234567" });
    expect(checks.at(-1)).toMatchObject({ check: "Send", ok: true });
    const bad = await createSms({ url: URL_CLOUD, token: "t", fetch: gw.fetch }).doctor({ sendTo: "garbage" });
    expect(bad.at(-1)).toMatchObject({ check: "Send", ok: false });
  });
  it("mock mode", async () => {
    expect(await createSms({ mock: true }).doctor()).toEqual([{ check: "Configuration", ok: true, detail: "Mock mode (no network)" }]);
  });
});
