import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/index";
import { mongooseStore } from "../src/mongoose";
import type { SmsLog, SmsStore } from "../src/index";

const mk = (i: number, over: Partial<SmsLog> = {}): SmsLog => ({
  id: `id${i}`, gatewayMessageId: `gw${i}`, to: i % 2 ? "+923001111111" : "+923002222222", message: `m${i}`, status: "pending",
  attempts: 1, createdAt: new Date(Date.now() - (100 - i) * 1000).toISOString(), updatedAt: new Date().toISOString(), ...over
});

/** Shared contract tests: run against memoryStore here, and against mongooseStore when MONGODB_URI is set. */
export function storeContract(name: string, make: () => Promise<SmsStore> | SmsStore) {
  describe(`${name} store contract`, () => {
    it("create/get/update, get by gateway id", async () => {
      const s = await make();
      await s.create(mk(1));
      expect((await s.get("id1"))?.message).toBe("m1");
      expect((await s.get("gw1"))?.id).toBe("id1");
      expect(await s.get("zzz")).toBeNull();
      await s.update("id1", { status: "sent", error: "x" });
      expect(await s.get("id1")).toMatchObject({ status: "sent", error: "x" });
      await s.update("id1", { error: undefined });
      expect((await s.get("id1"))?.error).toBeUndefined();
    });
    it("pagination (newest first, no overlap)", async () => {
      const s = await make();
      for (let i = 1; i <= 7; i++) await s.create(mk(i));
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const r = await s.list({ limit: 3, cursor });
        seen.push(...r.items.map((x) => x.id));
        cursor = r.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual(["id7", "id6", "id5", "id4", "id3", "id2", "id1"]);
    });
    it("filters", async () => {
      const s = await make();
      const l1 = mk(1, { status: "sent", key: "k1:+923001111111" }), l2 = mk(2), l3 = mk(3);
      await s.create(l1);
      await s.create(l2);
      await s.create(l3);
      expect((await s.list({ status: "sent" })).items.map((x) => x.id)).toEqual(["id1"]);
      expect((await s.list({ to: "+923002222222" })).items).toHaveLength(1);
      expect((await s.list({ key: "k1" })).items.map((x) => x.id)).toEqual(["id1"]);
      const mid = l2.createdAt;
      expect((await s.list({ createdFrom: mid })).items.map((x) => x.id).sort()).toEqual(["id2", "id3"]);
      expect((await s.list({ createdTo: mid })).items.map((x) => x.id).sort()).toEqual(["id1", "id2"]);
    });
    it("counts", async () => {
      const s = await make();
      await s.create(mk(1)); await s.create(mk(2, { status: "failed" })); await s.create(mk(3, { status: "delivered" })); await s.create(mk(4, { status: "failed" }));
      expect(await s.counts()).toEqual({ total: 4, pending: 1, processed: 0, sent: 0, delivered: 1, failed: 2, cancelled: 0 });
    });
    it("listOpen: pending, processed, recent sent; oldest first; limit", async () => {
      const s = await make();
      const old = new Date(Date.now() - 25 * 3600_000).toISOString();
      await s.create(mk(1, { status: "processed" }));
      await s.create(mk(2, { status: "sent" }));
      await s.create(mk(3, { status: "sent", createdAt: old }));
      await s.create(mk(4, { status: "delivered" }));
      await s.create(mk(5));
      expect((await s.listOpen(100)).map((x) => x.id)).toEqual(["id1", "id2", "id5"]);
      expect(await s.listOpen(2)).toHaveLength(2);
    });
    it("findByKey", async () => {
      const s = await make();
      await s.create(mk(1, { key: "a:+923001111111" }));
      expect((await s.findByKey("a:+923001111111"))?.id).toBe("id1");
      expect(await s.findByKey("nope")).toBeNull();
    });
  });
}

storeContract("memory", () => memoryStore());

describe("memoryStore cap", () => {
  it("drops the oldest entries beyond maxEntries", async () => {
    const s = memoryStore({ maxEntries: 3 });
    for (let i = 1; i <= 5; i++) await s.create(mk(i));
    expect((await s.counts()).total).toBe(3);
    expect(await s.get("id1")).toBeNull();
    expect(await s.get("id5")).not.toBeNull();
  });
  it("returns copies, not internal references", async () => {
    const s = memoryStore();
    await s.create(mk(1));
    (await s.get("id1"))!.status = "failed";
    expect((await s.get("id1"))?.status).toBe("pending");
  });
});

describe("mongooseStore integration", () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    it.skip("skipped: set MONGODB_URI to run against a real MongoDB", () => {});
    return;
  }
  storeContract("mongoose", async () => {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
    const schema = new mongoose.Schema(
      {
        id: { type: String, required: true, unique: true },
        gatewayMessageId: { type: String, index: true },
        to: { type: String, index: true },
        message: String,
        status: { type: String, index: true },
        attempts: Number,
        meta: mongoose.Schema.Types.Mixed,
        key: { type: String, index: { unique: true, sparse: true } },
        providerId: String,
        error: String,
        createdAt: { type: String, index: true },
        updatedAt: String
      },
      { versionKey: false }
    );
    const name = "SmsLogTest" + Math.random().toString(36).slice(2);
    const model = mongoose.model(name, schema);
    await model.init();
    return mongooseStore({ model: model as any });
  });
});
