import { SmsError } from "./errors";

/** Normalise a phone number to E.164 (`+<digits>`). Not a full phone parser. */
export function normalizePhone(number: string, country?: string): string {
  if (typeof number !== "string") throw new SmsError("INVALID_PHONE", "Phone number must be a string.");
  const raw = number.trim().replace(/[\s\-().]/g, "");
  if (!raw || !/^\+?\d+$/.test(raw)) throw new SmsError("INVALID_PHONE", `Invalid phone number: ${number}`);

  let digits: string;
  if (raw.startsWith("+")) {
    digits = raw.slice(1);
  } else if (raw.startsWith("00")) {
    digits = raw.slice(2);
  } else {
    const cc = (country ?? "").replace(/^\+/, "");
    if (!/^\d{1,3}$/.test(cc)) {
      throw new SmsError("INVALID_PHONE", `Country code required for number without + or 00: ${number}`);
    }
    if (raw.startsWith("0")) {
      digits = cc + raw.slice(1);
    } else if (raw.startsWith(cc) && raw.length - cc.length >= 8) {
      digits = raw; // already carries the country code
    } else {
      digits = cc + raw;
    }
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw new SmsError("INVALID_PHONE", `Invalid phone number: ${number}`);
  return "+" + digits;
}
