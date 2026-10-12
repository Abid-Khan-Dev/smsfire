# smsfire

Small, **backend-first** SMS client for [SMS Gateway for Android™](https://sms-gate.app): send SMS from your own Android phone, keep local logs, track delivery.

> **Unofficial community package.** Not made, endorsed or supported by SMS Gateway for Android™ or its authors.
> **Status: 0.1.0 stable. Tested and working in project automation.** See [docs/GATEWAY-NOTES.md](docs/GATEWAY-NOTES.md) for compatibility notes and real-device verification guidance.

- Zero runtime dependencies, ~7 kB min+gzip, ESM + CJS + types
- Node 22+, Bun, Deno, edge runtimes (standard `fetch` + Web Crypto only; no `node:` imports in the core)
- Local, Cloud and Private server modes
- Logs in memory, MongoDB (via your Mongoose model) or your own store
- Retries that never create duplicate SMS, idempotency keys, status sync, cancel, webhooks
- Optional Express router, Fetch handler (Next.js/Hono/Bun) and a tiny frontend client

## Quickstart

```bash
npm install smsfire
```

```ts
import { createSms } from "smsfire";

const sms = createSms({
  url: process.env.SMSFIRE_URL,
  username: process.env.SMSFIRE_USERNAME,
  password: process.env.SMSFIRE_PASSWORD,
  country: "92" // lets you pass local numbers like 0300 1234567
});

const result = await sms.send({ to: "0300 1234567", message: "Hello from smsfire" });
console.log(result); // { id, to, status: "pending", ok: true, attempts: 1, ... }
```

`createSms()` with no arguments reads `SMSFIRE_URL` plus `SMSFIRE_TOKEN` **or** `SMSFIRE_USERNAME` + `SMSFIRE_PASSWORD`. Only connection settings come from the environment.

Try it without a phone: `createSms({ mock: true })` makes no network calls and marks messages as sent.

## Gateway modes

| Mode | `url` | Auth | Send endpoint |
|---|---|---|---|
| Local | `http://<phone-ip>:8080` | Basic (JWT is not available in Local mode) | `POST /message` |
| Cloud | `https://api.sms-gate.app/3rdparty/v1` | JWT (preferred) or Basic | `POST /messages` |
| Private | `https://your-server/api/3rdparty/v1` | JWT (preferred) or Basic | `POST /messages` |

The mode is inferred from the URL (`/3rdparty/` in the path means Cloud/Private, anything else is Local). Override with `mode: "local" | "cloud" | "private"` if needed.

## Architecture: use a backend

```
Browser / React / Mobile / Desktop  ->  your backend (smsfire)  ->  SMS Gateway  ->  your phone
```

Browsers should **not** call the gateway directly: the gateway API does not send CORS headers, and credentials would be exposed to every visitor. Use `smsfire/client` from the frontend against your own backend routes.

## Configuration

| Option | Default | Notes |
|---|---|---|
| `url` | env | Required unless `mock: true` |
| `token` / `username`+`password` | env | Exactly one auth style; incomplete credentials throw `CONFIG` |
| `mode` | inferred | `local`, `cloud`, `private` |
| `country` | none | Calling code (e.g. `"92"`) used for numbers without `+`/`00` |
| `store` | `memoryStore()` | See [Stores](#stores) |
| `templates` | `{}` | `{ name: "Hi {name}" }` |
| `ttl` | `86400` | Seconds; `null` disables |
| `deliveryReport` | `true` | Ask the gateway for delivery reports |
| `retries` | `2` | Retries for 429/502/503/504 |
| `retryNetworkErrors` | `false` | See [Retries](#retries-and-duplicates) |
| `timeoutMs` | `15000` | |
| `concurrency` | `5` | Parallel gateway requests during bulk sends |
| `mock` | `false` | No network |
| `fetch` | global | Custom fetch |
| `onError` | none | `(err, context) => void` for background/non-fatal errors |

## Sending

```ts
await sms.send({ to: "+923001234567", message: "Your order is ready." }); // -> SendResult
await sms.send({ to: ["+92300...", "+92301..."], message: "Hi" });          // -> SendResult[]
```

- Exactly one of `message` or `template`. Messages are trimmed; max 1600 characters.
- Up to 100 recipients. All numbers are normalised to E.164, validated and de-duplicated **before** anything is logged or sent; any invalid number throws and nothing is sent.
- Each recipient is its own gateway message, its own local log and its own message ID. A bulk send is N gateway calls.
- Delivery problems return `{ ok: false, status: "failed", error }`; they do not throw. Bad input/config throws `SmsError`.
- In a bulk send each recipient succeeds or fails on its own, so check every result.

Other fields: `meta`, `scheduleAt`, `ttl`, `validUntil`, `priority` (-128..127), `deviceId`, `simNumber`, `key`. `ttl` and `validUntil` are mutually exclusive; `validUntil` must be after `scheduleAt`. The gateway owns scheduling; smsfire has no scheduler.

### Templates

```ts
const sms = createSms({ ..., templates: { due: "Hi {name}, Rs {amount} is due." } });
await sms.send({ to, template: "due", vars: { name: "Abid", amount: 5000 } });
```
A missing template (`TEMPLATE_NOT_FOUND`) or variable (`TEMPLATE_VARIABLE_MISSING`) throws before sending. A literal `{name}` never reaches the gateway.

### Helpers

```ts
import { estimate, normalizePhone, renderTemplate } from "smsfire";
estimate("Hello €"); // { encoding: "GSM-7", length: 8, segments: 1, perSegment: 160 }
normalizePhone("0300 1234567", "92"); // "+923001234567"
```
`estimate` counts GSM-7 (160/153) and UCS-2 (70/67, e.g. Urdu, Arabic, emoji); `^ { } \ [ ] ~ | €` count as 2 characters. It is an estimate: carriers have the last word.

## Retries and duplicates

Every SMS gets one ID that is also sent as the gateway message ID, and the **same ID is reused on every retry**.

- Retried automatically: HTTP **429, 502, 503, 504** (backoff 300 ms, 600 ms, ...).
- Never retried: 400, 401, 403, 404, other 4xx.
- **Timeout / network error** (default): not retried, because the gateway may already have accepted the SMS. The log stays `pending` with the error *"Gateway response was not received; delivery state is unknown."* Call `sms.sync()`: it looks the message up by ID. If the gateway has no record of it after 5 minutes, it is marked `failed`.
- `retryNetworkErrors: true` retries with the same ID. A duplicate-ID `409` is resolved by reading the message state instead of sending again. Rare duplicates are still possible depending on gateway behaviour.
- If the log cannot be created, nothing is sent. If updating the log fails after a successful send, the result is still returned (and `onError` is called); the SMS is never resent because of a storage error.

### Idempotency keys

```ts
await sms.send({ to, message, key: `invoice-${id}` });
```
A repeat with the same key returns the existing result without sending again (double-clicks, cron reruns, client retries). For bulk sends the key is stored per recipient as `<key>:<phone>`. There is no distributed locking: with the memory store, two truly simultaneous identical requests can race; MongoDB's unique index covers that.

## Logs, sync, watch, cancel

```ts
await sms.logs({ status: "failed", limit: 20 }); // { items, nextCursor, counts }
await sms.get(id);                               // local store only
await sms.sync();                                // refresh open logs from the gateway -> number updated
const stop = sms.watch({ intervalMs: 15000 });   // optional polling; you start it, you stop it
await sms.cancel(id);                            // { id, ok, status, error? }
```

- `get()` and `logs()` read the store only and never call the gateway. `sync()` refreshes up to 100 open logs (`pending`, `processed`, and `sent` newer than 24 h when `deliveryReport` is on).
- Statuses: `pending`, `processed`, `sent`, `delivered`, `failed`, `cancelled`. Gateway "Cancelling" maps to `pending`. `delivered`, `failed` and `cancelled` are final and never regress.
- `watch()` never runs unless you call it, skips a tick if the previous sync is still running, and returns `stop()`.
- `cancel()` only works while the gateway allows it. A `409` is a normal `{ ok: false }` result, not an exception. `ok: true` means the request was accepted; run `sync()` to see the final state.

### pending / sent / delivered

`pending`: accepted by the gateway, not yet handed to the phone. `processed`: the phone picked it up. `sent`: the phone handed it to the carrier. `delivered`: the carrier confirmed delivery (needs `deliveryReport`, and not every carrier/network reports it).

## Stores

Logs live in a store. `createSms` never opens a database connection for you.

| Store | Use for |
|---|---|
| `memoryStore({ maxEntries: 500 })` (default) | tests, demos, temporary services (lost on restart) |
| `mongooseStore({ model })` from `smsfire/mongoose` | production MongoDB |
| your own `SmsStore` | anything else |

### MongoDB

smsfire does not import or install Mongoose; you own the connection and the model:

```ts
import mongoose from "mongoose";
import { createSms } from "smsfire";
import { mongooseStore } from "smsfire/mongoose";

const SmsLog = mongoose.model("SmsLog", new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  gatewayMessageId: { type: String, index: true },
  to: { type: String, index: true },
  message: String,
  status: { type: String, index: true },
  attempts: Number,
  meta: mongoose.Schema.Types.Mixed,
  key: { type: String, unique: true, sparse: true },
  providerId: String,
  error: String,
  createdAt: { type: String, index: true },
  updatedAt: String
}, { versionKey: false, minimize: false }));

const sms = createSms({ url, token, store: mongooseStore({ model: SmsLog }) });
```
Timestamps are ISO strings (do not enable Mongoose `timestamps`). Pagination uses `_id`.

### Custom store

Implement `SmsStore` (`create`, `update`, `get`, `list`, `counts`, `listOpen`, `findByKey`; see `src/types.ts`). `get(id)` must match the local id **or** the gateway message id; `update` on an unknown id must be a no-op.

## Backend routes

All routes are authenticated except `/webhook`. Creating an adapter without `auth` throws unless you pass `unsafeNoAuth: true` (development only).

| Route | Purpose |
|---|---|
| `POST /send` | send (body: `to`, `message`/`template`, `vars`, `meta`, `key`, `scheduleAt`) |
| `GET /logs` | list logs (`status`, `to`, `key`, `createdFrom`, `createdTo`, `limit`, `cursor`) |
| `GET /logs/:id` | one log |
| `POST /sync` | refresh status |
| `POST /cancel/:id` | cancel |
| `POST /webhook` | gateway webhooks (signature required, no `auth`) |

Options: `auth(req) => boolean | Promise<boolean>` (required), `maxRecipients` (20), `maxBodyBytes` (20480), `allowCustomMessage` (true; `false` forces templates), `prepare(req, input)` (add metadata, restrict recipients, or throw to reject), `webhook: { secret }`, `onError`.

Clients can only set `to`, `message`, `template`, `vars`, `meta`, `key`, `scheduleAt`. Anything else (`deviceId`, `ttl`, `priority`...) must be added in `prepare`. Client-supplied `meta` can be spoofed; overwrite sensitive keys in `prepare`.

Responses: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Validation errors are 400, auth 401, oversized body 413, all recipients failed 502 (with `data.results`), cancel conflict 409, anything unexpected a generic 500 (the real error goes to `onError`). Gateway URLs and credentials never appear in responses.

### Express

```ts
import express from "express";
import { smsRouter } from "smsfire/express";

const app = express();
// Mount BEFORE express.json(): the router reads the raw body itself (needed for webhook signatures).
app.use("/sms", smsRouter(sms, {
  auth: (req) => Boolean(req.headers.authorization), // use your real auth
  webhook: { secret: process.env.SMSFIRE_WEBHOOK_SECRET! }
}));
app.use(express.json());
```

### Next.js / Fetch (Hono, Bun, Deno, Workers)

```ts
// app/api/sms/[...path]/route.ts
import { smsHandler } from "smsfire/fetch";
import { sms } from "@/lib/sms";

const handler = smsHandler(sms, { auth: async (req) => (await getUser(req)) !== null });
export { handler as GET, handler as POST };
```
Routes are matched by the end of the path, so any mount point works. Hono: `app.all("/sms/*", (c) => handler(c.req.raw))`. Bun: `Bun.serve({ fetch: handler })`.

### Frontend client

```ts
import { createSmsClient } from "smsfire/client";
const client = createSmsClient({ baseUrl: "/api/sms", credentials: "include" });
await client.send({ to: "+923001234567", message: "Hello" });
const { items, counts } = await client.logs({ status: "failed" });
```
The client only talks to your backend and never knows the gateway URL or credentials. `client` and `sms` both satisfy `LogSource` (`logs()` and optional `sync()`), so you can render logs from either.

## Webhooks

Optional. Events handled: `sms:sent`, `sms:delivered`, `sms:failed`, `sms:cancelled`. Everything else, and unknown message IDs, is ignored. Final statuses are never overwritten.

```ts
await sms.handleWebhook(rawBody, headers, { secret }); // throws UNAUTHORIZED if invalid
```
Verification: HMAC-SHA256 over `rawBody + timestamp`, headers `X-Signature` and `X-Timestamp`, timestamps older than 5 minutes rejected, constant-time comparison. `verifyWebhook(rawBody, headers, secret)` is exported and **async** (Web Crypto). You must pass the raw, unparsed body. For multipart messages the gateway may report delivery per part, so smsfire records `sent` and lets `sync()` confirm the final `delivered`.

## Doctor

```bash
SMSFIRE_URL=... SMSFIRE_TOKEN=... npx smsfire doctor
npx smsfire doctor --send-to +923001234567   # also sends one test SMS
```
`sms.doctor()` returns `[{ check, ok, detail, hint? }]` and never throws. It checks configuration, reachability, authentication and read access (an authenticated lookup of a random ID, where a 404 means "all good"). Send access is only checked with `--send-to`; the cancel scope is not checked.

## Errors

One class, `SmsError`, with `code`: `INVALID_PHONE`, `INVALID_MESSAGE`, `INVALID_INPUT`, `TEMPLATE_NOT_FOUND`, `TEMPLATE_VARIABLE_MISSING`, `CONFIG`, `UNAUTHORIZED`, `FORBIDDEN_SCOPE`, `NETWORK`, `HTTP`. Error messages never contain credentials or the gateway URL.

## Gateway scopes (JWT)

`messages:send` to send, `messages:read` for `sync()`/`doctor()`, and the cancel scope listed in the gateway documentation for `cancel()`. Use the smallest set and short-lived tokens.

## Troubleshooting

- **401 vs 403**: 401 means bad or missing credentials (or JWT used against a Local server); 403 means valid credentials but a missing scope.
- **Local mode unreachable**: the server and the phone must be on the same network; check the IP, port 8080 and that Local Server is started in the app. From the internet use Cloud or Private mode.
- **CORS / mixed content**: don't call the gateway from a browser; an `https` page cannot call an `http://phone-ip` URL. Use your backend.
- **Messages stay `pending`**: the phone is offline, asleep, or the OS is restricting the app in the background. Disable battery optimisation for the SMS Gateway app and keep the phone connected.
- **Never reaches `delivered`**: `deliveryReport` is off or the carrier does not report delivery.
- **Mongo duplicate key errors**: the `key` index must be `sparse` so logs without a key don't collide.

## Compliance

SMS is regulated. You are responsible for consent, opt-out handling, sender/carrier rules and local laws (including limits on bulk or unsolicited messages). Carriers may throttle or block a personal SIM used for bulk sending. smsfire does not provide an OTP service, queues or campaign tooling on purpose.

## What smsfire does not do

No other providers, queues, campaigns, OTP, MMS, incoming SMS, dashboards, hosted proxy, token generation/refresh, or background work you did not start.

## License

MIT. Unofficial; "SMS Gateway for Android" is a trademark of its owners.
