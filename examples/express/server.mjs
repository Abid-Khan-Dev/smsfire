// npm i express smsfire
import express from "express";
import { createSms } from "smsfire";
import { smsRouter } from "smsfire/express";

const sms = createSms({ country: "92" }); // reads SMSFIRE_URL + SMSFIRE_TOKEN (or USERNAME/PASSWORD)
const app = express();

// Mount before express.json(): the router reads the raw body itself.
app.use("/sms", smsRouter(sms, {
  auth: (req) => req.headers["x-api-key"] === process.env.APP_API_KEY, // replace with your real auth
  webhook: process.env.SMSFIRE_WEBHOOK_SECRET ? { secret: process.env.SMSFIRE_WEBHOOK_SECRET } : undefined,
  onError: (err, ctx) => console.error("[smsfire]", ctx, err instanceof Error ? err.message : err)
}));
app.use(express.json());

app.listen(3000, () => console.log("POST http://localhost:3000/sms/send"));
