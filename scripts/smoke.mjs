// Manual real-phone smoke test. NOT part of CI.
// Usage: SMSFIRE_URL=... SMSFIRE_TOKEN=... (or SMSFIRE_USERNAME/SMSFIRE_PASSWORD) SMOKE_TO=+92... node scripts/smoke.mjs
import { createSms } from "../dist/index.js";

const to = process.env.SMOKE_TO;
if (!to) throw new Error("Set SMOKE_TO to your own phone number (E.164).");
const sms = createSms();

console.log("doctor:");
for (const c of await sms.doctor()) console.log(` ${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail}`);

const r = await sms.send({ to, message: `smsfire smoke test ${new Date().toISOString()}` });
console.log("send:", r);
if (!r.ok) process.exit(1);

for (let i = 0; i < 20; i++) {
  await new Promise((res) => setTimeout(res, 5000));
  await sms.sync();
  const log = await sms.get(r.id);
  console.log(` ${log.status}`);
  if (["delivered", "failed", "cancelled"].includes(log.status)) {
    console.log("final:", log);
    process.exit(log.status === "delivered" ? 0 : 1);
  }
}
console.log("Timed out waiting for a final status (delivery reports may be unavailable).");
