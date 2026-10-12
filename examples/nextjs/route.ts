// app/api/sms/[...path]/route.ts
import { createSms } from "smsfire";
import { smsHandler } from "smsfire/fetch";

const sms = createSms({ country: "92" });

const handler = smsHandler(sms, {
  auth: async (req) => req.headers.get("x-api-key") === process.env.APP_API_KEY // use your real session check
});

export { handler as GET, handler as POST };
