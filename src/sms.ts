import { SmsError, isSmsError } from "./errors";
import { basicAuth, createGateway, httpError, mapState, readState, type Gateway } from "./gateway";
import { normalizePhone } from "./phone";
import { estimate } from "./estimate";
import { renderTemplate } from "./template";
import { memoryStore } from "./stores/memory";
import { verifyWebhook } from "./webhook";
import type {
  CancelResult,
  DoctorCheck,
  HeadersLike,
  LogsQuery,
  LogsResult,
  SendInput,
  SendResult,
  Sms,
  SmsConfig,
  SmsLog,
  SmsStatus,
  WebhookResult
} from "./types";

const MAX_RECIPIENTS = 100;
const MAX_MESSAGE = 1600;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const UNKNOWN_OUTCOME = "Gateway response was not received; delivery state is unknown.";
const NO_RECORD_GRACE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const RANK: Record<SmsStatus, number> = { pending: 0, processed: 1, sent: 2, delivered: 3, failed: 3, cancelled: 3 };
const TERMINAL = new Set<SmsStatus>(["delivered", "failed", "cancelled"]);

/** Terminal statuses never change; open statuses never move backwards. */
function canMove(from: SmsStatus, to: SmsStatus): boolean {
  if (from === to) return false;
  if (TERMINAL.has(from)) return false;
  return RANK[to] >= RANK[from];
}

function readEnv(): Record<string, string | undefined> {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env ?? {};
}

function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  throw new SmsError("CONFIG", "crypto.randomUUID is not available in this runtime.");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toIso(v: Date | string | undefined, name: string): string | undefined {
  if (v === undefined) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new SmsError("INVALID_INPUT", `${name} is not a valid date.`);
  return d.toISOString();
}

async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const n = i++;
      out[n] = await fn(items[n]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function toResult(l: SmsLog): SendResult {
  const r: SendResult = { id: l.id, to: l.to, status: l.status, ok: l.status !== "failed", attempts: l.attempts };
  if (l.providerId) r.providerId = l.providerId;
  if (l.error) r.error = l.error;
  return r;
}

interface Prepared {
  recipients: string[];
  text: string;
  ttl: number | null;
  validUntil?: string;
  scheduleAt?: string;
  priority?: number;
  deviceId?: string;
  simNumber?: number;
  meta?: Record<string, unknown>;
  key?: string;
}

export function createSms(config: SmsConfig = {}): Sms {
  const env = readEnv();
  const cfg: SmsConfig = { ...config };

  if (!cfg.mock) {
    cfg.url ??= env.SMSFIRE_URL;
    if (!cfg.token && !cfg.username && !cfg.password) {
      cfg.token = env.SMSFIRE_TOKEN;
      cfg.username = env.SMSFIRE_USERNAME;
      cfg.password = env.SMSFIRE_PASSWORD;
    }
  }

  const retries = cfg.retries ?? 2;
  const timeoutMs = cfg.timeoutMs ?? 15000;
  const concurrency = cfg.concurrency ?? 5;
  const deliveryReport = cfg.deliveryReport ?? true;
  const defaultTtl = cfg.ttl === undefined ? 86400 : cfg.ttl;
  const retryNetworkErrors = cfg.retryNetworkErrors ?? false;
  const templates = cfg.templates ?? {};
  const store = cfg.store ?? memoryStore();
  const mock = cfg.mock === true;
  const report = (e: unknown, ctx: string) => {
    try {
      cfg.onError?.(e, ctx);
    } catch {
      /* never let a hook break sending */
    }
  };

  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new SmsError("CONFIG", "retries must be an integer from 0 to 10.");
  if (!(timeoutMs > 0)) throw new SmsError("CONFIG", "timeoutMs must be greater than 0.");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new SmsError("CONFIG", "concurrency must be an integer from 1 to 20.");
  if (defaultTtl !== null && (!Number.isInteger(defaultTtl) || defaultTtl <= 0)) throw new SmsError("CONFIG", "ttl must be a positive integer or null.");

  let gateway: Gateway | undefined;
  let modeLabel: string = "mock";
  let authLabel = "none";

  if (!mock) {
    if (!cfg.url) throw new SmsError("CONFIG", "Gateway url is required (or set SMSFIRE_URL). Use mock: true for no gateway.");
    let parsed: URL;
    try {
      parsed = new URL(cfg.url);
    } catch {
      throw new SmsError("CONFIG", "Gateway url is not a valid URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new SmsError("CONFIG", "Gateway url must start with http:// or https://.");
    const hasToken = !!cfg.token;
    const hasUser = !!cfg.username;
    const hasPass = !!cfg.password;
    if (hasToken && (hasUser || hasPass)) throw new SmsError("CONFIG", "Provide either token or username/password, not both.");
    if (!hasToken && !(hasUser && hasPass)) throw new SmsError("CONFIG", "Provide a token, or both username and password.");

    const mode = cfg.mode ?? (parsed.pathname.includes("/3rdparty/") ? "cloud" : "local");
    modeLabel = mode;
    authLabel = hasToken ? "JWT" : "Basic";
    const f = cfg.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) throw new SmsError("CONFIG", "No fetch implementation available. Pass config.fetch.");
    gateway = createGateway({
      url: cfg.url.replace(/\/+$/, ""),
      authHeader: hasToken ? `Bearer ${cfg.token}` : basicAuth(cfg.username!, cfg.password!),
      local: mode === "local",
      timeoutMs,
      fetch: f.bind(globalThis)
    });
  }

  // ---------- validation (nothing is logged or sent if this throws) ----------
  function prepare(input: SendInput): Prepared {
    if (!input || typeof input !== "object") throw new SmsError("INVALID_INPUT", "send() needs an input object.");
    const list = Array.isArray(input.to) ? input.to : [input.to];
    if (list.length === 0 || list[0] === undefined) throw new SmsError("INVALID_INPUT", "`to` is required.");
    if (list.length > MAX_RECIPIENTS) throw new SmsError("INVALID_INPUT", `At most ${MAX_RECIPIENTS} recipients per send().`);
    const recipients = [...new Set(list.map((n) => normalizePhone(n, cfg.country)))];

    const hasMsg = input.message !== undefined;
    const hasTpl = input.template !== undefined;
    if (hasMsg === hasTpl) throw new SmsError("INVALID_INPUT", "Provide exactly one of `message` or `template`.");
    let text: string;
    if (hasTpl) {
      const tpl = Object.prototype.hasOwnProperty.call(templates, input.template!) ? templates[input.template!] : undefined;
      if (tpl === undefined) throw new SmsError("TEMPLATE_NOT_FOUND", `Template not found: ${input.template}`);
      text = renderTemplate(tpl, input.vars ?? {});
    } else {
      if (typeof input.message !== "string") throw new SmsError("INVALID_MESSAGE", "`message` must be a string.");
      text = input.message;
    }
    text = text.trim();
    if (!text) throw new SmsError("INVALID_MESSAGE", "Message is empty.");
    if (text.length > MAX_MESSAGE) throw new SmsError("INVALID_MESSAGE", `Message is longer than ${MAX_MESSAGE} characters.`);

    if (input.ttl !== undefined && input.validUntil !== undefined) throw new SmsError("INVALID_INPUT", "Use either ttl or validUntil, not both.");
    const scheduleAt = toIso(input.scheduleAt, "scheduleAt");
    const validUntil = toIso(input.validUntil, "validUntil");
    if (validUntil && Date.parse(validUntil) <= Date.now()) throw new SmsError("INVALID_INPUT", "validUntil is in the past.");
    if (scheduleAt && validUntil && Date.parse(validUntil) <= Date.parse(scheduleAt)) throw new SmsError("INVALID_INPUT", "validUntil must be after scheduleAt.");
    if (input.ttl !== undefined && input.ttl !== null && (!Number.isInteger(input.ttl) || input.ttl <= 0)) throw new SmsError("INVALID_INPUT", "ttl must be a positive integer or null.");
    if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < -128 || input.priority > 127)) throw new SmsError("INVALID_INPUT", "priority must be an integer from -128 to 127.");
    if (input.simNumber !== undefined && (!Number.isInteger(input.simNumber) || input.simNumber < 1)) throw new SmsError("INVALID_INPUT", "simNumber must be a positive integer.");
    if (input.deviceId !== undefined && (typeof input.deviceId !== "string" || !input.deviceId)) throw new SmsError("INVALID_INPUT", "deviceId must be a non-empty string.");
    if (input.meta !== undefined && (typeof input.meta !== "object" || input.meta === null || Array.isArray(input.meta))) throw new SmsError("INVALID_INPUT", "meta must be an object.");
    if (input.key !== undefined && (typeof input.key !== "string" || !input.key || input.key.length > 200)) throw new SmsError("INVALID_INPUT", "key must be a string of 1-200 characters.");

    const p: Prepared = {
      recipients,
      text,
      ttl: input.ttl !== undefined ? input.ttl : validUntil ? null : defaultTtl
    };
    if (validUntil) p.validUntil = validUntil;
    if (scheduleAt) p.scheduleAt = scheduleAt;
    if (input.priority !== undefined) p.priority = input.priority;
    if (input.deviceId) p.deviceId = input.deviceId;
    if (input.simNumber !== undefined) p.simNumber = input.simNumber;
    if (input.meta) p.meta = input.meta;
    if (input.key) p.key = input.key;
    return p;
  }

  function body(id: string, to: string, p: Prepared): Record<string, unknown> {
    const b: Record<string, unknown> = { id, textMessage: { text: p.text }, phoneNumbers: [to], withDeliveryReport: deliveryReport };
    if (p.ttl !== null) b.ttl = p.ttl;
    if (p.validUntil) b.validUntil = p.validUntil;
    if (p.scheduleAt) b.scheduleAt = p.scheduleAt;
    if (p.priority !== undefined) b.priority = p.priority;
    if (p.deviceId) b.deviceId = p.deviceId;
    if (p.simNumber !== undefined) b.simNumber = p.simNumber;
    return b;
  }

  // ---------- send ----------
  async function sendOne(to: string, p: Prepared, strict: boolean): Promise<SendResult> {
    const effKey = p.key ? `${p.key}:${to}` : undefined;
    try {
      if (effKey) {
        const existing = await store.findByKey(effKey);
        if (existing) return toResult(existing);
      }
    } catch (e) {
      report(e, "store.findByKey");
      return storeFailure(e, strict, to);
    }

    const id = newId();
    const now = new Date().toISOString();
    const log: SmsLog = { id, gatewayMessageId: id, to, message: p.text, status: "pending", attempts: 0, createdAt: now, updatedAt: now };
    if (p.meta) log.meta = p.meta;
    if (effKey) log.key = effKey;

    try {
      await store.create(log);
    } catch (e) {
      if (effKey) {
        const dup = await store.findByKey(effKey).catch(() => null);
        if (dup) return toResult(dup); // lost a race with an identical request
      }
      report(e, "store.create");
      return storeFailure(e, strict, to, id);
    }

    let patch: Partial<SmsLog>;
    let attempts = 0;

    if (mock || !gateway) {
      attempts = 1;
      patch = { status: "sent" };
    } else {
      for (;;) {
        attempts++;
        let res;
        try {
          res = await gateway.send(body(id, to, p));
        } catch (e) {
          if (retryNetworkErrors && attempts <= retries) {
            await sleep(300 * attempts);
            continue;
          }
          report(e, "gateway.send");
          patch = { status: "pending", error: UNKNOWN_OUTCOME };
          break;
        }
        if (res.status >= 200 && res.status < 300) {
          const s = readState(res.data);
          patch = { status: s.status ?? "pending" };
          if (s.id) {
            patch.providerId = s.id;
            patch.gatewayMessageId = s.id;
          }
          if (s.error) patch.error = s.error;
          if (patch.status === "failed" && !patch.error) patch.error = "Gateway reported a failure.";
          break;
        }
        if (res.status === 409) {
          patch = await resolveDuplicate(id);
          break;
        }
        if (RETRY_STATUSES.has(res.status) && attempts <= retries) {
          await sleep(300 * attempts);
          continue;
        }
        patch = { status: "failed", error: httpError(res).message };
        break;
      }
    }

    patch.attempts = attempts;
    patch.updatedAt = new Date().toISOString();
    try {
      await store.update(id, patch);
    } catch (e) {
      report(e, "store.update"); // the SMS is already sent: never resend because of a log failure
    }
    return toResult({ ...log, ...patch });
  }

  function storeFailure(e: unknown, strict: boolean, to: string, id = ""): SendResult {
    const msg = "Could not save the SMS log, so nothing was sent.";
    if (strict) throw new SmsError("CONFIG", msg, { cause: e });
    return { id, to, status: "failed", ok: false, error: msg, attempts: 0 };
  }

  async function resolveDuplicate(id: string): Promise<Partial<SmsLog>> {
    try {
      const res = await gateway!.get(id);
      if (res.status === 200) {
        const s = readState(res.data);
        return { status: s.status ?? "pending", providerId: id, ...(s.error ? { error: s.error } : {}) };
      }
    } catch (e) {
      report(e, "gateway.get");
      return { status: "pending", error: UNKNOWN_OUTCOME };
    }
    return { status: "failed", error: "Gateway rejected the message id (HTTP 409)." };
  }

  async function send(input: SendInput): Promise<SendResult | SendResult[]> {
    const p = prepare(input);
    const strict = p.recipients.length === 1;
    const results = await pool(p.recipients, concurrency, (to) => sendOne(to, p, strict));
    return Array.isArray(input.to) ? results : results[0]!;
  }

  // ---------- logs ----------
  async function logs(q: LogsQuery = {}): Promise<LogsResult> {
    const [list, counts] = await Promise.all([store.list(q), store.counts()]);
    const out: LogsResult = { items: list.items, counts };
    if (list.nextCursor) out.nextCursor = list.nextCursor;
    return out;
  }

  // ---------- sync ----------
  async function sync(): Promise<number> {
    if (mock || !gateway) return 0;
    const open = await store.listOpen(100);
    const now = Date.now();
    const todo = open.filter((l) => {
      if (l.status !== "sent") return true;
      return deliveryReport && now - Date.parse(l.createdAt) < DAY_MS;
    });
    let updated = 0;
    await pool(todo, concurrency, async (log) => {
      try {
        const res = await gateway!.get(log.gatewayMessageId);
        const patch: Partial<SmsLog> = {};
        if (res.status === 200) {
          const s = readState(res.data);
          if (s.status && canMove(log.status, s.status)) {
            patch.status = s.status;
            if (s.status === "failed") patch.error = s.error ?? "Gateway reported a failure.";
            else if (log.error) patch.error = undefined;
          }
        } else if (res.status === 404) {
          if (now - Date.parse(log.createdAt) > NO_RECORD_GRACE_MS && canMove(log.status, "failed")) {
            patch.status = "failed";
            patch.error = "The gateway has no record of this message.";
          }
        } else {
          report(httpError(res), "sync");
        }
        if (patch.status) {
          patch.updatedAt = new Date().toISOString();
          await store.update(log.id, patch);
          updated++;
        }
      } catch (e) {
        report(e, "sync");
      }
    });
    return updated;
  }

  function watch(options: { intervalMs?: number } = {}): () => void {
    const intervalMs = options.intervalMs ?? 15000;
    if (!(intervalMs >= 1000)) throw new SmsError("INVALID_INPUT", "intervalMs must be at least 1000.");
    let running = false;
    let stopped = false;
    const timer = setInterval(async () => {
      if (running || stopped) return;
      running = true;
      try {
        await sync();
      } catch (e) {
        report(e, "watch");
      } finally {
        running = false;
      }
    }, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  // ---------- cancel ----------
  async function cancel(id: string): Promise<CancelResult> {
    if (typeof id !== "string" || !id) throw new SmsError("INVALID_INPUT", "A message id is required.");
    const log = await store.get(id);
    if (!log) throw new SmsError("INVALID_INPUT", "Message not found.");
    if (TERMINAL.has(log.status)) {
      return { id: log.id, ok: false, status: log.status, error: `Message is already ${log.status}.` };
    }
    if (mock || !gateway) {
      await store.update(log.id, { status: "cancelled", updatedAt: new Date().toISOString() });
      return { id: log.id, ok: true, status: "cancelled" };
    }
    try {
      const res = await gateway.cancel(log.gatewayMessageId);
      if (res.status >= 200 && res.status < 300) {
        const s = readState(res.data).status;
        const status = s && canMove(log.status, s) ? s : log.status;
        if (status !== log.status) await store.update(log.id, { status, updatedAt: new Date().toISOString() });
        return { id: log.id, ok: true, status };
      }
      const error = res.status === 409 ? "The gateway no longer allows cancelling this message." : res.status === 404 ? "The gateway has no record of this message." : httpError(res).message;
      return { id: log.id, ok: false, status: log.status, error };
    } catch (e) {
      report(e, "gateway.cancel");
      return { id: log.id, ok: false, status: log.status, error: "No response from the gateway; the cancellation state is unknown." };
    }
  }

  // ---------- webhook ----------
  const EVENTS: Record<string, SmsStatus> = { "sms:sent": "sent", "sms:delivered": "delivered", "sms:failed": "failed", "sms:cancelled": "cancelled" };

  async function handleWebhook(rawBody: string, headers: HeadersLike, options: { secret: string }): Promise<WebhookResult> {
    await verifyWebhook(rawBody, headers, options?.secret);
    let evt: any;
    try {
      evt = JSON.parse(rawBody);
    } catch {
      throw new SmsError("INVALID_INPUT", "Webhook body is not valid JSON.");
    }
    let next = typeof evt?.event === "string" ? EVENTS[evt.event] : undefined;
    const messageId = evt?.payload?.messageId;
    if (!next || typeof messageId !== "string") return { handled: false };
    const log = await store.get(messageId);
    if (!log) return { handled: false };

    // Delivery reports can arrive per message part: only trust "delivered" for single-part
    // messages. For multipart, record "sent" and let sync() read the gateway's final state.
    if (next === "delivered" && estimate(log.message).segments > 1) next = "sent";

    if (!canMove(log.status, next)) return { handled: true, id: log.id, status: log.status };
    const patch: Partial<SmsLog> = { status: next, updatedAt: new Date().toISOString() };
    if (next === "failed") patch.error = typeof evt.payload.reason === "string" ? evt.payload.reason.slice(0, 300) : "Gateway reported a failure.";
    await store.update(log.id, patch);
    return { handled: true, id: log.id, status: next };
  }

  // ---------- doctor ----------
  async function doctor(options: { sendTo?: string } = {}): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [{ check: "Configuration", ok: true, detail: mock ? "Mock mode (no network)" : `${modeLabel} mode, ${authLabel} auth.` }];
    if (mock || !gateway) return checks;
    try {
      const res = await gateway.get(newId()); // an unknown id: 404 proves reachable + authenticated + read access
      checks.push({ check: "Gateway reachable", ok: true, detail: `Gateway answered with HTTP ${res.status}.` });
      if (res.status === 401) {
        checks.push({ check: "Authentication", ok: false, detail: "Gateway rejected the credentials (401).", hint: modeLabel === "local" ? "Local Server supports Basic auth only; check the username and password in the app." : "Check the token or username/password." });
      } else {
        checks.push({ check: "Authentication", ok: true, detail: "Credentials accepted." });
        if (res.status === 403) checks.push({ check: "Read scope", ok: false, detail: "Read access denied (403).", hint: "Add the messages:read scope to the token." });
        else checks.push({ check: "Read scope", ok: true, detail: "Read access OK (messages:read)." });
      }
    } catch (e) {
      checks.push({
        check: "Gateway reachable",
        ok: false,
        detail: isSmsError(e) ? e.message : "Gateway request failed.",
        hint: modeLabel === "local" ? "The server and the phone must be on the same network. Check the IP, port 8080 and that Local Server is started in the app." : "Check the URL, your network and that the phone is online."
      });
    }
    if (options.sendTo) {
      try {
        const r = (await send({ to: options.sendTo, message: "smsfire doctor test" })) as SendResult;
        checks.push({ check: "Send", ok: r.ok, detail: r.ok ? `Test SMS accepted (status: ${r.status}).` : (r.error ?? "Send failed."), ...(r.ok ? {} : { hint: "Send needs the messages:send scope. The phone must be online." }) });
      } catch (e) {
        checks.push({ check: "Send", ok: false, detail: isSmsError(e) ? e.message : "Send failed." });
      }
    }
    return checks;
  }

  return {
    send: send as Sms["send"],
    get: (id) => store.get(id),
    logs,
    sync,
    watch,
    cancel,
    handleWebhook,
    doctor: async (o) => {
      try {
        return await doctor(o);
      } catch (e) {
        return [{ check: "Doctor", ok: false, detail: isSmsError(e) ? e.message : "Unexpected error." }];
      }
    }
  };
}
