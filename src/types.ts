export type SmsStatus = "pending" | "processed" | "sent" | "delivered" | "failed" | "cancelled";

export interface SmsLog {
  id: string;
  gatewayMessageId: string;
  to: string;
  message: string;
  status: SmsStatus;
  attempts: number;
  meta?: Record<string, unknown>;
  key?: string;
  providerId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SmsCounts {
  total: number;
  pending: number;
  processed: number;
  sent: number;
  delivered: number;
  failed: number;
  cancelled: number;
}

export interface ListOptions {
  status?: SmsStatus;
  to?: string;
  key?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  cursor?: string;
}

export interface ListResult {
  items: SmsLog[];
  nextCursor?: string;
}

/**
 * Storage contract. Implement this to use any database.
 * - `get(id)` must match the local id OR the gateway message id.
 * - `update` on an unknown id must be a no-op.
 * - `list` returns newest first; `listOpen` returns oldest first.
 * - `listOpen(limit)` returns logs that are `pending`, `processed`, or `sent` within the last 24h.
 */
export interface SmsStore {
  create(log: SmsLog): Promise<SmsLog>;
  update(id: string, patch: Partial<SmsLog>): Promise<void>;
  get(id: string): Promise<SmsLog | null>;
  list(options: ListOptions): Promise<ListResult>;
  counts(): Promise<SmsCounts>;
  listOpen(limit: number): Promise<SmsLog[]>;
  findByKey(key: string): Promise<SmsLog | null>;
}

export interface SendInput {
  to: string | string[];
  message?: string;
  template?: string;
  vars?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  scheduleAt?: Date | string;
  ttl?: number | null;
  validUntil?: Date | string;
  priority?: number;
  deviceId?: string;
  simNumber?: number;
  key?: string;
}

export interface SendResult {
  id: string;
  to: string;
  status: SmsStatus;
  ok: boolean;
  providerId?: string;
  error?: string;
  attempts: number;
}

export interface CancelResult {
  id: string;
  ok: boolean;
  status: SmsStatus;
  error?: string;
}

export interface SmsConfig {
  url?: string;
  mode?: "local" | "cloud" | "private";
  token?: string;
  username?: string;
  password?: string;
  country?: string;
  store?: SmsStore;
  templates?: Record<string, string>;
  ttl?: number | null;
  deliveryReport?: boolean;
  retries?: number;
  retryNetworkErrors?: boolean;
  timeoutMs?: number;
  concurrency?: number;
  mock?: boolean;
  fetch?: typeof fetch;
  onError?: (err: unknown, context: string) => void;
}

export interface LogsQuery extends ListOptions {}

export interface LogsResult {
  items: SmsLog[];
  nextCursor?: string;
  counts: SmsCounts;
}

/** Anything that can serve logs: a direct `Sms` or an `SmsClient`. */
export interface LogSource {
  logs(query?: LogsQuery): Promise<LogsResult>;
  sync?(): Promise<number>;
}

export interface DoctorCheck {
  check: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface WebhookResult {
  handled: boolean;
  id?: string;
  status?: SmsStatus;
}

export interface Sms extends LogSource {
  send(input: SendInput & { to: string[] }): Promise<SendResult[]>;
  send(input: SendInput & { to: string }): Promise<SendResult>;
  send(input: SendInput): Promise<SendResult | SendResult[]>;
  get(id: string): Promise<SmsLog | null>;
  logs(query?: LogsQuery): Promise<LogsResult>;
  sync(): Promise<number>;
  watch(options?: { intervalMs?: number }): () => void;
  cancel(id: string): Promise<CancelResult>;
  handleWebhook(rawBody: string, headers: HeadersLike, options: { secret: string }): Promise<WebhookResult>;
  doctor(options?: { sendTo?: string }): Promise<DoctorCheck[]>;
}

export type HeadersLike =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };
