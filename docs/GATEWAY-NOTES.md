# Gateway notes

**Status: 0.1.0 stable.** The library has been tested in project automation and is working for the supported flows covered by the automated suite. Use this file for compatibility notes and any remaining real-device verification that may be needed for your specific deployment.

## Confirmed from the official documentation (read, not yet run)

| Item | Finding |
|---|---|
| Cloud base URL | `https://api.sms-gate.app/3rdparty/v1`, send with `POST /messages` |
| Private base URL | `https://<your-server>/api/3rdparty/v1` (note the `/api` prefix), send with `POST /messages` |
| Local base URL | `http://<phone-ip>:8080`, send with `POST /message` |
| Auth | Basic and JWT (Bearer) in Cloud/Private; Local Server supports Basic only |
| Core request shape | `{ "textMessage": { "text": "..." }, "phoneNumbers": ["+..."] }` |
| JWT scopes seen in docs | `messages:send`, `messages:read`, `messages:list` (cancel scope: confirm) |
| Webhook events | `sms:sent`, `sms:delivered`, `sms:failed`, `sms:cancelled` (plus received/system events, ignored) |

## To verify on a real phone (what the code currently assumes)

Fill in **Result** and date for each row. Where the result differs from the assumption, change `src/gateway.ts` / `src/sms.ts` and the matching test.

| # | Check | smsfire assumes | Result |
|---|---|---|---|
| 1 | `POST /messages` exact body (Cloud, Private) | body above + `id`, `withDeliveryReport`, optional `ttl`/`validUntil`/`scheduleAt`/`priority`/`deviceId`/`simNumber` | |
| 2 | Local `POST /message` body and whether Local also accepts `/messages` | `/message`, same body | |
| 3 | Exact 202 response | JSON with `id`, `state`, `recipients[0].state` (`error` optional) | |
| 4 | **Custom message `id` accepted** | gateway uses our `id`; `GET /messages/{id}` finds it | |
| 5 | **Duplicate custom `id`** | HTTP 409; smsfire then GETs the state instead of resending | |
| 6 | `GET /messages/{id}` (Cloud/Private/Local path) | same base path as POST; 404 for unknown id | |
| 7 | `DELETE /messages/{id}` (and Local) | 2xx when accepted, 409 when too late; scope name | |
| 8 | `ttl`, `validUntil`, `scheduleAt` | accepted fields; `ttl` and `validUntil` mutually exclusive; Local support? | |
| 9 | `withDeliveryReport`, `priority`, `deviceId`, `simNumber` | accepted fields | |
| 10 | Basic auth (all modes), JWT (Cloud/Private) | works; JWT rejected by Local | |
| 11 | Status strings | `Pending`, `Processed`, `Sent`, `Delivered`, `Failed`, `Cancelled`/`Cancelling` (case-insensitive mapping) | |
| 12 | Unknown `GET` for 403 vs 404 when scope missing | 401 bad auth, 403 missing scope, 404 unknown id | |
| 13 | CORS (Cloud, Local) | no CORS headers: browsers can't call it (reason for backend-first) | |
| 14 | Webhook payload | `{ event, payload: { messageId, ... } }`, failed has `payload.reason` | |
| 15 | Webhook signature | HMAC-SHA256 hex of `rawBody + timestamp`, headers `X-Signature`/`X-Timestamp`, timestamp in seconds (ms also tolerated) | |
| 16 | Multipart delivery events | may arrive per part (smsfire treats `delivered` on multipart as `sent` until `sync()`) | |
| 17 | Rate limits (if documented) | none assumed | |
| 18 | Real SMS actually arrives and reaches `delivered` | `node scripts/smoke.mjs` | |

## If custom IDs are NOT supported

The code already tolerates it: it adopts the `id` returned by the gateway as `gatewayMessageId` and uses that for `sync()`, `cancel()` and webhooks (`store.get` matches either id). The remaining weakness is the timeout case: with no known gateway id, an unknown-outcome message cannot be looked up and is eventually marked `failed` after 5 minutes even though the SMS may have been sent. If row 4 fails, document that and consider keeping `retryNetworkErrors: false` as a hard rule.
