# Security

## Reporting a vulnerability
Please report security issues privately to the maintainer (Abid Khan) rather than opening a public issue. Include steps to reproduce and the affected version. You will get an acknowledgement as soon as possible.

## Design rules
1. Gateway credentials stay on your backend. Never put a token or password in browser code; browsers should use `smsfire/client` against your own routes.
2. Server adapters require `auth`. Creating one without it throws unless `unsafeNoAuth: true` (development only).
3. `/webhook` is the only unauthenticated route; it needs a secret, the raw body, a valid HMAC-SHA256 signature and a timestamp within 5 minutes (constant-time comparison).
4. Credentials and the gateway URL never appear in errors, results, logs or HTTP responses; unexpected server errors return a generic 500 and go to `onError`.
5. Limits: 100 recipients (core), 20 per HTTP request by default, 1600 characters, 20 KB request body.
6. Use the minimum JWT scopes (`messages:send`, `messages:read`, plus cancel only if needed) and short-lived tokens.
7. Prefer HTTPS (Cloud/Private). Local Server is plain HTTP on your LAN; do not expose it to the internet.
8. Clients can only set `to`, `message`, `template`, `vars`, `meta`, `key`, `scheduleAt` over HTTP. Use `prepare()` to enforce recipient allow-lists and to overwrite `meta` values you rely on.
9. Rate-limit your own `/send` route (smsfire has no client-side rate limiting). Each SMS costs real money/SIM reputation.
