import type { ListOptions, ListResult, SmsCounts, SmsLog, SmsStore } from "./types";

/** Minimal shape of a Mongoose model. smsfire does not import mongoose. */
export interface MongooseModelLike {
  create(doc: any): Promise<any>;
  updateOne(filter: any, update: any): Promise<any>;
  findOne(filter: any): { lean(): Promise<any> } & PromiseLike<any>;
  find(filter: any): {
    sort(s: any): { limit(n: number): { lean(): Promise<any[]> } };
  };
  aggregate(pipeline: any[]): Promise<any[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function clean(doc: any): SmsLog {
  const { _id, __v, ...rest } = doc;
  for (const k of Object.keys(rest)) if (rest[k] === null) delete rest[k];
  for (const k of ["createdAt", "updatedAt"]) if (rest[k] instanceof Date) rest[k] = rest[k].toISOString();
  return rest as SmsLog;
}

/**
 * Store logs in MongoDB via your own Mongoose model. The model needs the fields shown in the README
 * (`id` and `key` indexed, `key` unique + sparse, `timestamps: false`).
 */
export function mongooseStore(options: { model: MongooseModelLike }): SmsStore {
  const m = options.model;
  return {
    async create(log) {
      await m.create(log);
      return log;
    },
    async update(id, patch) {
      const $set: Record<string, unknown> = {};
      const $unset: Record<string, 1> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) $unset[k] = 1;
        else $set[k] = v;
      }
      const update: Record<string, unknown> = {};
      if (Object.keys($set).length) update.$set = $set;
      if (Object.keys($unset).length) update.$unset = $unset;
      if (Object.keys(update).length) await m.updateOne({ id }, update);
    },
    async get(id) {
      const doc = await m.findOne({ $or: [{ id }, { gatewayMessageId: id }] }).lean();
      return doc ? clean(doc) : null;
    },
    async list(o: ListOptions): Promise<ListResult> {
      const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
      const f: Record<string, unknown> = {};
      if (o.status) f.status = o.status;
      if (o.to) f.to = o.to;
      if (o.key) f.key = { $regex: `^${o.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:|$)` };
      if (o.createdFrom || o.createdTo) {
        f.createdAt = { ...(o.createdFrom ? { $gte: o.createdFrom } : {}), ...(o.createdTo ? { $lte: o.createdTo } : {}) };
      }
      if (o.cursor) f._id = { $lt: o.cursor };
      const docs = await m.find(f).sort({ _id: -1 }).limit(limit + 1).lean();
      const page = docs.slice(0, limit);
      const res: ListResult = { items: page.map(clean) };
      if (docs.length > limit) res.nextCursor = String(page[page.length - 1]._id);
      return res;
    },
    async counts() {
      const rows = await m.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
      const c: SmsCounts = { total: 0, pending: 0, processed: 0, sent: 0, delivered: 0, failed: 0, cancelled: 0 };
      for (const r of rows) {
        if (r._id in c && r._id !== "total") (c as any)[r._id] = r.n;
        c.total += r.n;
      }
      return c;
    },
    async listOpen(limit) {
      const cutoff = new Date(Date.now() - DAY_MS).toISOString();
      const docs = await m
        .find({ $or: [{ status: { $in: ["pending", "processed"] } }, { status: "sent", createdAt: { $gte: cutoff } }] })
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
      return docs.map(clean);
    },
    async findByKey(key) {
      const doc = await m.findOne({ key }).lean();
      return doc ? clean(doc) : null;
    }
  };
}
