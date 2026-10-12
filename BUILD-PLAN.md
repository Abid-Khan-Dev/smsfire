# smsfire: final backend-first build plan (v3, corrected)

Owner: Abid. Unofficial package for SMS Gateway for Android™. **Small, not a framework.**

## Rules
- Zero runtime dependencies. No global singleton, no automatic background work (`sync()` / `watch()` are explicit).
- Non-goals: provider abstraction, Twilio, queues, Redis, Firebase, OTP, MMS, incoming SMS, dashboards, React UI, hosted proxy, workers, plugins, analytics, accounts, billing.
- Tie-break rule: fewer files, fewer abstractions, fewer dependencies, fewer moving parts, same reliability, simplest public API.

## Entry points
`smsfire`, `smsfire/client`, `smsfire/express`, `smsfire/fetch`, `smsfire/mongoose`, and CLI `smsfire doctor` (separate `bin` bundle). `package.json`: `type: module`, `sideEffects: false`, per-condition `types` listed first with `.d.ts` for ESM and `.d.cts` for CJS. Optional integrations (mongoose, express) are never imported by smsfire.

## Main entry exports
`createSms, estimate, normalizePhone, renderTemplate, memoryStore, verifyWebhook, SmsError`, public types. No `node:`, `Buffer` or unguarded `process` (checked in CI). Runtimes: Node 22+ (CI on 22 and 24), Bun, Deno, edge.

## Corrections made to the previous plan
1. **`mode`**: new optional `mode` config; otherwise detected from the URL (`/3rdparty/` => `/messages`, else Local `/message`). Local rejects JWT.
2. **Auth required** on server adapters (throws unless `unsafeNoAuth`); webhook is the only unauthenticated route; client input is whitelisted, everything else is set in `prepare`.
3. **Unknown outcome** (timeout/network): log stays `pending` with a "delivery state unknown" note. `sync()` looks it up by gateway id; a `404` after 5 minutes marks it `failed`, so it cannot stay pending forever, even if the gateway ignores custom ids.
4. **Exports map** puts `types` first and ships `.d.cts` for CJS.
5. **`verifyWebhook` / `handleWebhook` are async** (Web Crypto); documented as unavailable on runtimes without `crypto.subtle`.
6. **Doctor** verifies scopes by behavior (probe a random id: 404 ok / 401 / 403) and only tests `messages:send` when `--send-to` is given; no health endpoint until verified.
7. Node 18 dropped (EOL); Node 22+.
8. Adapter signature is `smsHandler(sms, options)` returning a handler (not `smsHandler(sms, req)`); auth is a single predicate for both adapters (`(req) => boolean | Promise<boolean>`).
9. Bulk: one recipient = one log = one gateway message = one gateway id; store failure on one bulk recipient yields a failed result for that recipient, a single send throws.
10. `store.get(id)` matches local id **or** gateway id (needed for webhooks when the gateway returns its own id).
11. Cut for v1 simplicity: `smsfire/react`, `kvStore`, `unsafe` browser/direct mode, `GET /health` route, local-endpoint fallback (`/messages` then `/message`).

## Behavior spec (unchanged essentials)
- Pipeline: validate => normalize/dedupe => render template => length check => idempotency lookup => create log **before** network => send with the log id as gateway id => update log => return `SendResult`.
- Retry only 429/502/503/504 (300 ms linear backoff, same gateway id). Network errors are not retried unless `retryNetworkErrors` (same id; duplicates still possible). `409` => fetch existing message, never resend.
- If `store.create` fails: nothing is sent. If `store.update` fails after the gateway accepted: return the result, call `onError`, never resend.
- Statuses: `pending, processed, sent, delivered, failed, cancelled`; `Cancelling` => `pending`; terminal statuses never regress.
- Idempotency key per recipient: `<key>:<normalized-phone>`; unique sparse index in Mongo; no distributed locking.
- Limits: 100 recipients per `send()`, 20 per HTTP request, 1600 chars, 20 kB body.

## Phases
0. **Gateway verification** on a real phone => `docs/GATEWAY-NOTES.md` (20-item checklist). *Open.*
1. Core (done, tested against fake gateway).
2. Mongoose store + routes + Express + Fetch + client (done; real MongoDB run still open).
3. Sync, watch, cancel, scheduling, webhooks (done).
4. Doctor + CLI (done).
5. Docs, examples, pack/install checks (done); real-phone smoke + npm publish (open).

## Release gate
`npm run verify`, `npm pack` into clean ESM and CJS projects, real-phone smoke (`scripts/smoke.mjs`), Mongo integration run, GATEWAY-NOTES completed, RELEASE-NOTES updated with anything still unverified.
