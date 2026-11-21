import { MongoClient, type Db } from "mongodb";
import { readonlySink, type AnalyticsSink } from "../analytics/sink.ts";
import type { Account, Identity } from "../auth/store.ts";
import type { Money } from "./payments.ts";
import type { InfraDay } from "./infra.ts";
import type { OpsDaily } from "./ops/store.ts";

/** another service's analytics the admin reads, never writes: preview's admin showing madani.bot's visitors, sessions and
 *  sign-ups from madani_prod. its money, clouds and devices stay on that service's own admin. */
export interface LiveData {
  label: string;
  sink: AnalyticsSink;
  /** that service's accounts, only what the analytics pages name people with */
  accounts(): Promise<Account[]>;
  /** that service's sign-in identities: provider, its name and email, never the subject's tokens */
  identities?(): Promise<Array<Pick<Identity, "accountId" | "provider" | "label" | "email" | "addedAt">>>;
  /** that service's billing records, for its payments; records without a mode stamp were made in live mode */
  money?(): Promise<Money>;
  /** that service's madani cloud usage days and its ops daily counters ("mail"), for the ops page's top accounts */
  infra(fromDay: string, toDay: string): Promise<InfraDay[]>;
  daily(source: string, fromDay: string, toDay: string): Promise<OpsDaily[]>;
  /** one ops_latest entry's data, null when there is none */
  latest(source: string): Promise<unknown>;
}

export function liveData(db: Db, label: string, now: () => number = Date.now, ttlMs = 30_000): LiveData {
  const rows = db.collection<Account>("accounts");
  let cached: { at: number; list: Promise<Account[]> } | null = null;
  /** one read shared by every caller for `ttlMs`; a failed read is not kept */
  function kept<T>(read: () => Promise<T>): () => Promise<T> {
    let entry: { at: number; value: Promise<T> } | null = null;
    return () => {
      if (!entry || now() - entry.at > ttlMs) {
        const value = read();
        entry = { at: now(), value };
        value.catch(() => { if (entry?.value === value) entry = null; });
      }
      return entry.value;
    };
  }
  const plain = <T>(name: string, projection: Record<string, 0 | 1> = {}) => db.collection(name).find({}, { projection: { _id: 0, _n: 0, _expireAt: 0, ...projection } }).limit(100_000).toArray() as unknown as Promise<T[]>;
  const identities = kept(() => db.collection<Identity>("identities").find({}, { projection: { _id: 0, accountId: 1, provider: 1, label: 1, email: 1, addedAt: 1 } }).limit(100_000).toArray());
  const money = kept(async (): Promise<Money> => {
    const [customers, checkouts, subscriptions, invoices, refunds, ledger, webhookEvents] = await Promise.all([plain<Money["customers"][number]>("billing_customers"),
      plain<Money["checkouts"][number]>("billing_checkouts", { url: 0 }), plain<Money["subscriptions"][number]>("billing_subscriptions"), plain<Money["invoices"][number]>("billing_invoices"),
      plain<NonNullable<Money["refunds"]>[number]>("billing_refunds"), plain<NonNullable<Money["ledger"]>[number]>("billing_ledger"),
      db.collection("billing_webhook_events").find({ type: "refund.succeeded" }, { projection: { _id: 0, id: 1, at: 1, type: 1 } }).sort({ at: 1 }).limit(100_000).toArray() as unknown as Promise<Money["webhookEvents"]>]);
    return { customers, checkouts, subscriptions, invoices, refunds, ledger, webhookEvents };
  });
  return {
    label, sink: readonlySink(db), identities, money,
    accounts() {
      if (!cached || now() - cached.at > ttlMs) {
        const list = rows.find({}, { projection: { _id: 0, id: 1, email: 1, name: 1, createdAt: 1, avatarUrl: 1, avatar: 1, onboardedAt: 1 } }).sort({ _n: 1 }).limit(100_000).toArray()
          .then(docs => docs.map(doc => ({ id: doc.id, email: doc.email, name: doc.name ?? null, createdAt: doc.createdAt, ...(doc.avatarUrl ? { avatarUrl: doc.avatarUrl } : {}),
            ...(doc.avatar ? { avatar: doc.avatar } : {}), ...(doc.onboardedAt ? { onboardedAt: doc.onboardedAt } : {}) })));
        cached = { at: now(), list };
        list.catch(() => { if (cached?.list === list) cached = null; });
      }
      return cached.list;
    },
    async infra(fromDay, toDay) {
      const docs = await db.collection("infra_usage_daily").find({ day: { $gte: fromDay, $lte: toDay } }, { projection: { _id: 0 } }).limit(50_000).toArray();
      return docs.map(doc => ({ ...doc, collectedAt: doc.collectedAt instanceof Date ? doc.collectedAt.getTime() : Number(doc.collectedAt) || 0 }) as unknown as InfraDay);
    },
    async latest(source) {
      const doc = await db.collection<{ _id: string; data: unknown }>("ops_latest").findOne({ _id: source });
      return doc?.data ?? null;
    },
    async daily(source, fromDay, toDay) {
      const docs = await db.collection("ops_daily").find({ source, day: { $gte: fromDay, $lte: toDay } }).limit(50_000).toArray();
      return docs.map(doc => ({ source: doc.source, day: doc.day, key: doc.key, accountId: doc.accountId ?? null, values: doc.values ?? {} }));
    },
  };
}

/** MADANI_ADMIN_ANALYTICS_URI names a user with only `read` on MADANI_ADMIN_ANALYTICS_DB */
export async function openLiveData(uri: string, dbName: string, label: string): Promise<LiveData> {
  if (!/^[a-z0-9_]{1,40}$/.test(dbName)) throw new Error("MADANI_ADMIN_ANALYTICS_DB must be a database name.");
  const client = new MongoClient(uri, { maxPoolSize: 4, serverSelectionTimeoutMS: 10_000, appName: "madani-admin-live" });
  await client.connect();
  const db = client.db(dbName);
  await db.command({ ping: 1 });
  return liveData(db, label);
}
