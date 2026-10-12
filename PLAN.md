# smsfire: build plan v3 (corrected, backend-first, deliberately small)

Rule: when two designs work, pick the one with fewer files, abstractions, dependencies and moving parts. smsfire is a small npm package, not a framework.

## Scope
Entry points: `smsfire`, `smsfire/client`, `smsfire/express`, `smsfire/fetch`, `smsfire/mongoose`; CLI `smsfire doctor`. No React, KV store, queues, workers, providers, OTP, MMS, incoming SMS, dashboards, hosted proxy, token refresh.

## Fixes applied to the previous plan
1. **Mode**: optional `mode` option; otherwise inferred (`/3rdparty/` in the URL path = Cloud/Private using `/messages`, else Local using `/message`). No automatic endpoint fallback.
2. **Server auth is mandatory**: adapters throw at creation without `auth` unless `unsafeNoAuth: true`. `/webhook` is the only unauthenticated route and needs a secret.
3. **Unknown outcome**: timeout/network error leaves the log `pending` with an "unknown" error and never auto-retries. `sync()` looks the message up by ID; a 404 after 5 minutes becomes `failed`. If the gateway ignores custom IDs, the returned ID is adopted.
4. **Package exports**: `types` first in each condition, separate `.d.ts` / `.d.cts`, optional integrations never imported (no `dependencies`).
5. **`verifyWebhook` is async** (Web Crypto, no `node:` imports).
6. **Scopes** documented as `messages:send`, `messages:read`, and the cancel scope to be confirmed in Phase 0.
7. Bulk: documented as N gateway calls; per-recipient results; a store failure in bulk becomes per-recipient failed results.
8. Node 22+ (Node 18/20 dropped; CI on 22 and 24, 26 optional).
9. `smsHandler(sms, options)` returns a handler (so it can be exported as `GET`/`POST`).

## Reliability rules (unchanged)
Validate everything before logging/sending; create the log before the gateway call; one recipient = one log = one gateway message = one ID; reuse the ID on every retry; retry only 429/502/503/504 (300 ms linear backoff); idempotency key `<key>:<phone>`; terminal statuses never regress; a store failure before send blocks the send, a store failure after send never resends.

## Phases
0. **Gateway spike** on the real phone → fill `docs/GATEWAY-NOTES.md` (blocks release). 1. Core (done). 2. Mongoose store, routes, Express, Fetch, client (done). 3. Sync, watch, cancel, scheduling, webhooks (done). 4. Doctor + CLI (done). 5. Docs, examples, packaging (done), then **real-phone smoke + Mongo run + publish**.

## Release gate
Local and Cloud tested on a real phone; one SMS delivered; GATEWAY-NOTES complete; `MONGODB_URI` test run; `npm run verify`; clean ESM/CJS install; `node scripts/smoke.mjs`.
