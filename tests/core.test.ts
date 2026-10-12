import { describe, expect, it } from "vitest";
import { estimate, normalizePhone, renderTemplate, SmsError } from "../src/index";

describe("estimate", () => {
  it("GSM-7 160 / 161", () => {
    expect(estimate("a".repeat(160))).toEqual({ encoding: "GSM-7", length: 160, segments: 1, perSegment: 160 });
    expect(estimate("a".repeat(161))).toEqual({ encoding: "GSM-7", length: 161, segments: 2, perSegment: 153 });
    expect(estimate("a".repeat(306)).segments).toBe(2);
    expect(estimate("a".repeat(307)).segments).toBe(3);
  });
  it("UCS-2 70 / 71 and Urdu", () => {
    expect(estimate("ا".repeat(70))).toEqual({ encoding: "UCS-2", length: 70, segments: 1, perSegment: 70 });
    expect(estimate("ا".repeat(71))).toEqual({ encoding: "UCS-2", length: 71, segments: 2, perSegment: 67 });
    expect(estimate("آپ کا آرڈر تیار ہے").encoding).toBe("UCS-2");
  });
  it("GSM extension characters count as 2", () => {
    expect(estimate("€").length).toBe(2);
    expect(estimate("^{}\\[~]|").length).toBe(16);
    expect(estimate("a".repeat(159) + "€").segments).toBe(2); // 161 septets
  });
  it("emoji forces UCS-2", () => {
    const e = estimate("hi 😀");
    expect(e.encoding).toBe("UCS-2");
    expect(e.length).toBe(5);
  });
});

describe("normalizePhone", () => {
  it("handles +, 00, local with country", () => {
    expect(normalizePhone("+923001234567")).toBe("+923001234567");
    expect(normalizePhone("00923001234567")).toBe("+923001234567");
    expect(normalizePhone("0300 1234567", "92")).toBe("+923001234567");
    expect(normalizePhone("0300-123-4567", "+92")).toBe("+923001234567");
  });
  it("recognises already-prefixed numbers", () => {
    expect(normalizePhone("923001234567", "92")).toBe("+923001234567");
    expect(normalizePhone("3001234567", "92")).toBe("+923001234567");
  });
  it("rejects bad input", () => {
    expect(() => normalizePhone("03001234567")).toThrow(SmsError);
    expect(() => normalizePhone("abc", "92")).toThrow(/Invalid/);
    expect(() => normalizePhone("+12345")).toThrow(SmsError);
    expect(() => normalizePhone("+1234567890123456")).toThrow(SmsError);
    expect(() => normalizePhone("")).toThrow(SmsError);
  });
});

describe("renderTemplate", () => {
  it("renders and throws on missing variables", () => {
    expect(renderTemplate("Hi {name}, Rs {amount}", { name: "Abid", amount: 5000 })).toBe("Hi Abid, Rs 5000");
    expect(() => renderTemplate("Hi {name}", {})).toThrowError(expect.objectContaining({ code: "TEMPLATE_VARIABLE_MISSING" }));
  });
});
