import type { ListOptions, ListResult, SmsCounts, SmsLog, SmsStore } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

export function memoryStore(options: { maxEntries?: number } = {}): SmsStore {
  const max = options.maxEntries ?? 500;
  let seq = 0;
  const rows = new Map<string, { seq: number; log: SmsLog }>();

  const clone = (l: SmsLog): SmsLog => ({ ...l, ...(l.meta ? { meta: { ...l.meta } } : {}) });

  return {
    async create(log) {
      rows.set(log.id, { seq: ++seq, log: clone(log) });
      while (rows.size > max) {
        const oldest = rows.keys().next().value as string;
        rows.delete(oldest);
      }
      return clone(log);
    },
    async update(id, patch) {
      const r = rows.get(id);
      if (r) r.log = { ...r.log, ...patch };
    },
    async get(id) {
      const r = rows.get(id);
      if (r) return clone(r.log);
      for (const x of rows.values()) if (x.log.gatewayMessageId === id) return clone(x.log);
      return null;
    },
    async list(o: ListOptions): Promise<ListResult> {
      const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
      const before = o.cursor !== undefined ? Number(o.cursor) : Infinity;
      const all = [...rows.values()]
        .filter((r) => r.seq < before)
        .filter((r) => (o.status ? r.log.status === o.status : true))
        .filter((r) => (o.to ? r.log.to === o.to : true))
        .filter((r) => (o.key ? r.log.key === o.key || r.log.key?.startsWith(o.key + ":") === true : true))
        .filter((r) => (o.createdFrom ? r.log.createdAt >= o.createdFrom : true))
        .filter((r) => (o.createdTo ? r.log.createdAt <= o.createdTo : true))
        .sort((a, b) => b.seq - a.seq);
      const page = all.slice(0, limit);
      const res: ListResult = { items: page.map((r) => clone(r.log)) };
      if (all.length > limit) res.nextCursor = String(page[page.length - 1]!.seq);
      return res;
    },
    async counts() {
      const c: SmsCounts = { total: 0, pending: 0, processed: 0, sent: 0, delivered: 0, failed: 0, cancelled: 0 };
      for (const r of rows.values()) {
        c.total++;
        c[r.log.status]++;
      }
      return c;
    },
    async listOpen(limit) {
      const cutoff = new Date(Date.now() - DAY_MS).toISOString();
      return [...rows.values()]
        .filter(
          (r) =>
            r.log.status === "pending" ||
            r.log.status === "processed" ||
            (r.log.status === "sent" && r.log.createdAt >= cutoff)
        )
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((r) => clone(r.log));
    },
    async findByKey(key) {
      for (const r of rows.values()) if (r.log.key === key) return clone(r.log);
      return null;
    }
  };
}
