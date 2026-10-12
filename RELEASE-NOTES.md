# Release notes

## 0.1.0 (stable)

First stable release. Backend-first SMS client for SMS Gateway for Android (unofficial).

**Included:** `createSms` (send, bulk, templates, scheduling fields, retries, idempotency keys, logs, sync, watch, cancel, webhooks, doctor), `estimate`, `normalizePhone`, `renderTemplate`, `verifyWebhook`, `memoryStore`, `smsfire/mongoose`, `smsfire/express`, `smsfire/fetch`, `smsfire/client`, `npx smsfire doctor`.

**Verified (automated):** 88 tests against a scriptable fake gateway (202/401/403/404/409/429/502/503/504, timeouts, network errors, invalid JSON, status progression, cancel, webhooks), Express adapter over a real HTTP server, clean ESM and CJS installs from `npm pack`, TypeScript resolution under `nodenext`, main entry ~7 kB min+gzip with no Node-only APIs.

**Notes:**
- The project is working in the supported automated flows and is published as a stable 0.1.0 release.
- Real-device verification remains a deployment-specific check; see `docs/GATEWAY-NOTES.md` for compatibility notes.
- `mongooseStore` against a real MongoDB and Node 24/26 verification remain recommended follow-up checks for the specific environment you run in.

**Decisions that differ from the first plan:** no React entry, no KV store, no `unsafe` browser mode; `smsHandler(sms, options)` returns a `(Request) => Response` handler; `verifyWebhook` is async (Web Crypto); server auth is a single predicate `auth(req)`; the mode is inferred from the URL.
