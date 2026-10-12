import { describe, expect, it } from "vitest";
import { estimate, normalizePhone, renderTemplate, SmsError } from "../src/index";

describe("normalizePhone", () => {
  it("handles +, 00, local + country, spaces", () => {
    expect(normalizePhone("+92 300 1234567")).toBe("+923001234567");
    expect(normalizePhone("00923001234567")).toBe("+923001234567");
    expect(normalizePhone("0300 1234567", "92")).toBe("+923001234567");
    expect(normalizePhone("0300-1234567", "+92")).toBe("+923001234567");
    expect(normalizePhone("923001234567", "92")).toBe("+923001234567");
    expect(normalizePhone("3001234567", "92")).toBe("+923001234567");
  });
  it("rejects bad numbers", () => {
    for (const n of ["", "abc", "0300", "+1", "030012345678901234", "+0923001234567"]) {
      expect(() => normalizePhone(n, "92")).toThrow(SmsError);
    }
    expect(() => normalizePhone("03001234567")).toThrow(/Country code required/);
  });
});

describe("estimate", () => {
  const e = (n: number, ch = "a") => estimate(ch.repeat(n));
  it("GSM-7 160/161", () => {
    expect(e(160)).toEqual({ encoding: "GSM-7", length: 160, segments: 1, perSegment: 160 });
    expect(e(161)).toMatchObject({ encoding: "GSM-7", segments: 2, perSegment: 153 });
    expect(e(306).segments).toBe(2);
    expect(e(307).segments).toBe(3);
  });
  it("UCS-2 70/71 and Urdu", () => {
    expect(e(70, "ا")).toEqual({ encoding: "UCS-2", length: 70, segments: 1, perSegment: 70 });
    expect(e(71, "ا")).toMatchObject({ segments: 2, perSegment: 67 });
    expect(estimate("سلام، آپ کا آرڈر تیار ہے").encoding).toBe("UCS-2");
    expect(estimate("مرحبا").encoding).toBe("UCS-2");
  });
  it("emoji forces UCS-2 and counts 2 units", () => {
    expect(estimate("hi 😀")).toMatchObject({ encoding: "UCS-2", length: 5 });
  });
  it("GSM-7 extension chars count as 2", () => {
    for (const ch of "^{}\\[~]|€") expect(estimate(ch).length).toBe(2);
    expect(estimate("a".repeat(159) + "€")).toMatchObject({ length: 161, segments: 2 });
    expect(estimate("a".repeat(158) + "€").segments).toBe(1);
  });
});

describe("renderTemplate", () => {
  it("fills variables", () => {
    expect(renderTemplate("Hi {name}, Rs {amount}", { name: "Abid", amount: 5000 })).toBe("Hi Abid, Rs 5000");
  });
  it("throws on a missing variable", () => {
    expect(() => renderTemplate("Hi {name}", {})).toThrowError(expect.objectContaining({ code: "TEMPLATE_VARIABLE_MISSING" }));
  });
});
