import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import type { AnyBulkWriteOperation, Db, Document } from "mongodb";
import { createDiffBackend } from "./diff-backend.ts";
import type { LoadedData, WriteBatch } from "./diff-backend.ts";
import { LOGS, STORE_LAYOUTS } from "./layouts.ts";
import type { StoreLayout } from "./layouts.ts";
import { acquireLease, LEASE_ID, LEASE_MS, type LeaseCollection } from "./lease.ts";

export { holderGone } from "./lease.ts";

type Row = Document & { _id: string };
const RENEW_MS = 10_000, ACQUIRE_WAIT_MS = 75_000;
/** the date copy of a layout's `expireAt` field that its ttl index watches; never part of a store's state */
const EXPIRE_FIELD = "_expireAt";

export class LeaseLostError extends Error {
  constructor() { super("Another account service took over this database; this one stops so two writers never overwrite each other."); this.name = "LeaseLostError"; }
}

/** every collection a layout or log names, with its indexes; createIndexes is a no-op for ones that exist */
async function ensureIndexes(db: Db, layouts: Record<string, StoreLayout>) {
  const work: Array<Promise<unknown>> = [];
  for (const layout of Object.values(layouts)) for (const spec of Object.values(layout)) {
    const indexes = [{ key: { _n: 1 } as Document }, ...(spec.indexes ?? []).map(index => ({ key: index.keys as Document, ...(index.unique ? { unique: true } : {}), ...(index.partial ? { partialFilterExpression: index.partial } : {}) }))];
    if (spec.expireAt) indexes.push({ key: { [EXPIRE_FIELD]: 1 }, expireAfterSeconds: 0 } as (typeof indexes)[number]);
    work.push(db.collection(spec.collection).createIndexes(indexes));
  }
  for (const [log, indexes] of Object.entries(LOGS)) work.push(db.collection(log).createIndexes(indexes.map(index => ({ key: index.keys as Document }))));
  await Promise.all(work);
}

async function load(db: Db, layouts: Record<string, StoreLayout>): Promise<LoadedData> {
  const collections = [...new Set(Object.values(layouts).flatMap(layout => Object.values(layout).map(spec => spec.collection)))];
  const [roots, ...rows] = await Promise.all([db.collection<Document & { _id: string }>("stores").find().toArray(), ...collections.map(name => db.collection(name).find().toArray())]);
  const strip = (row: Document) => { const { [EXPIRE_FIELD]: _expire, ...rest } = row; return rest; };
  return { roots: new Map(roots.map(doc => [doc._id, doc])), rows: new Map(collections.map((name, index) => [name, rows[index]!.map(strip)])) };
}

/**
 * The account service's state in MongoDB. One process writes at a time: it holds a lease in `locks` (renewed every
 * 10 s, 30 s long) and every write checks the lease inside its transaction, so a process that lost it can never write.
 * Transactions need a replica set (mongod-madani runs as the one-node set rs-madani).
 */
export async function openMongoBackend(options: { uri: string; db: string; layouts?: Record<string, StoreLayout>; acquireWaitMs?: number; onLeaseLost?: (error: LeaseLostError) => void; log?: (line: string) => void }) {
  const layouts = options.layouts ?? STORE_LAYOUTS, log = options.log ?? (line => console.warn(`persistence: ${line}`));
  const client = new MongoClient(options.uri, { ignoreUndefined: true, maxPoolSize: 10, serverSelectionTimeoutMS: 10_000, appName: "madani-account" });
  await client.connect();
  const db = client.db(options.db);
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName) { await client.close(); throw new Error("MongoDB must run as a replica set (transactions): see docs/mongodb.md."); }
  const locks = db.collection<{ _id: string; owner: string; host: string; pid: number; expiresAt: Date }>("locks");
  const owner = `${hostname()}:${process.pid}:${randomBytes(6).toString("hex")}`;
  try {
    await acquireLease(locks as unknown as LeaseCollection, { owner, waitMs: options.acquireWaitMs ?? ACQUIRE_WAIT_MS, log });
  } catch (error) {
    await client.close();
    throw error;
  }
  let lost = false;
  const loseLease = () => {
    if (lost) return;
    lost = true;
    const error = new LeaseLostError();
    if (options.onLeaseLost) options.onLeaseLost(error); else throw error;
  };
  const renew = setInterval(() => {
    locks.updateOne({ _id: LEASE_ID, owner }, { $set: { expiresAt: new Date(Date.now() + LEASE_MS) } })
      .then(result => { if (result.matchedCount === 0) loseLease(); })
      .catch(() => log("writer lease renewal failed; retrying"));
  }, RENEW_MS);
  renew.unref();

  await ensureIndexes(db, layouts);
  const loaded = await load(db, layouts);
  const expiring = new Map(Object.values(layouts).flatMap(layout => Object.values(layout)).filter(spec => spec.expireAt).map(spec => [spec.collection, spec.expireAt!]));
  const writer = {
    async write(batch: WriteBatch) {
      if (lost) throw new LeaseLostError();
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const held = await locks.findOne({ _id: LEASE_ID, owner }, { session });
          if (!held) { loseLease(); throw new LeaseLostError(); }
          for (const [name, ops] of batch.collections) {
            const writes: AnyBulkWriteOperation<Row>[] = [];
            if (ops.deletes.length) writes.push({ deleteMany: { filter: { _id: { $in: ops.deletes } } } });
            const expireAt = expiring.get(name);
            for (const { _id, doc } of ops.upserts) {
              const at = expireAt ? Number(doc[expireAt]) : NaN;
              writes.push({ replaceOne: { filter: { _id }, replacement: Number.isFinite(at) ? { ...doc, [EXPIRE_FIELD]: new Date(at) } : doc, upsert: true } });
            }
            if (writes.length) await db.collection<Row>(name).bulkWrite(writes, { session, ordered: true });
          }
          for (const { _id, doc } of batch.roots) await db.collection<Document & { _id: string }>("stores").replaceOne({ _id }, doc, { session, upsert: true });
          const byLog = new Map<string, Document[]>();
          for (const { log: name, entry } of batch.appends) byLog.set(name, [...(byLog.get(name) ?? []), entry]);
          for (const [name, entries] of byLog) await db.collection(name).insertMany(entries.map(entry => ({ ...entry })), { session });
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      } finally {
        await session.endSession();
      }
    },
  };
  const backend = createDiffBackend({ loaded, writer, layouts });
  return {
    backend,
    db,
    /** another database on the same connection, read only by this service (the site's waitlist) */
    sibling: (name: string) => client.db(name),
    /** writes what is pending (for up to `flushMs`), gives the lease back and disconnects */
    async close(flushMs = 15_000) {
      clearInterval(renew);
      try { await backend.flush(flushMs); } catch { log("state was not fully written before shutdown"); }
      await locks.deleteOne({ _id: LEASE_ID, owner }).catch(() => {});
      await client.close();
    },
    async ping() { await db.command({ ping: 1 }); },
  };
}
