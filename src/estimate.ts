const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

export interface Estimate {
  encoding: "GSM-7" | "UCS-2";
  length: number;
  segments: number;
  perSegment: number;
}

/** Estimate SMS encoding and segment count. */
export function estimate(text: string): Estimate {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXT.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return build("GSM-7", septets, 160, 153);
  return build("UCS-2", text.length, 70, 67);
}

function build(encoding: Estimate["encoding"], length: number, single: number, multi: number): Estimate {
  if (length === 0) return { encoding, length, segments: 0, perSegment: single };
  if (length <= single) return { encoding, length, segments: 1, perSegment: single };
  return { encoding, length, segments: Math.ceil(length / multi), perSegment: multi };
}
