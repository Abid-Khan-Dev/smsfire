#!/usr/bin/env node
import { createSms } from "./sms";
import { isSmsError } from "./errors";

const proc = (globalThis as any).process;
const args: string[] = proc.argv.slice(2);

function usage(): void {
  console.log("Usage: smsfire doctor [--send-to +923001234567]\n\nReads SMSFIRE_URL and SMSFIRE_TOKEN (or SMSFIRE_USERNAME / SMSFIRE_PASSWORD).");
  proc.exit(args.length ? 1 : 0);
}

async function main() {
  if (args[0] !== "doctor") return usage();
  const i = args.indexOf("--send-to");
  const sendTo = i >= 0 ? args[i + 1] : undefined;
  if (i >= 0 && !sendTo) return usage();

  let checks;
  try {
    const sms = createSms();
    checks = await sms.doctor(sendTo ? { sendTo } : {});
  } catch (e) {
    checks = [{ check: "Configuration", ok: false, detail: isSmsError(e) ? e.message : "Unexpected error.", hint: "Set SMSFIRE_URL and SMSFIRE_TOKEN (or SMSFIRE_USERNAME and SMSFIRE_PASSWORD)." }];
  }
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail}`);
    if (!c.ok && c.hint) console.log(`    hint: ${c.hint}`);
  }
  proc.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main();
