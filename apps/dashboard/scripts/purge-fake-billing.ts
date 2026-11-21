// Removes made-up billing records from an account service database: checkouts the in-process fake provider made
// (fake_ sessions) with their subscriptions, invoices, refunds and ledger rows, fixture ledger rows, and billing
// customers left with nothing real. Counts only, unless --apply. Never run against production.
//   node --env-file=<env file> apps/dashboard/scripts/purge-fake-billing.ts [--apply] [--live]
// --apply refuses while the account service holds the writer lease (it keeps state in memory and could write the rows
// back); --live deletes anyway, and the service must be restarted at once (deploy restart <name>).
// MONGODB_TUNNEL=127.0.0.1:<port> swaps the URI's host for a local SSH tunnel to it.
import { parseArgs } from "node:util";
import { MongoClient, type Document } from "mongodb";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, live: { type: "boolean", default: false } } });
const raw = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB;
if (!raw || !dbName) { console.error("MONGODB_URI and MONGODB_DB are required."); process.exit(2); }
if (process.env.MADANI_ENVIRONMENT === "production" || /prod/i.test(dbName)) { console.error("refused: this is a production database."); process.exit(2); }
let uri = raw;
if (process.env.MONGODB_TUNNEL) {
  const scheme = raw.slice(0, raw.indexOf("://")), parsed = new URL(raw.replace(/^[^:]+:/, "http:"));
  parsed.host = process.env.MONGODB_TUNNEL;
  uri = `${scheme}://${parsed.toString().slice("http://".length)}`;
}

const client = await MongoClient.connect(uri, { directConnection: !!process.env.MONGODB_TUNNEL, serverSelectionTimeoutMS: 10_000 });
try {
  const db = client.db(dbName), ids = (docs: Document[], key = "id") => docs.map(doc => doc[key] as string);
  const checkouts = await db.collection("billing_checkouts").find({ providerSessionId: /^fake_/ }, { projection: { id: 1, accountId: 1 } }).toArray();
  const checkoutIds = ids(checkouts);
  const subs = await db.collection("billing_subscriptions").find({ checkoutId: { $in: checkoutIds } }, { projection: { id: 1 } }).toArray();
  const subIds = ids(subs);
  const invoices = await db.collection("billing_invoices").find({ $or: [{ checkoutId: { $in: checkoutIds } }, { subscriptionId: { $in: subIds } }] }, { projection: { id: 1, providerPaymentId: 1 } }).toArray();
  const paymentIds = ids(invoices, "providerPaymentId");
  const fakeAccounts = [...new Set(checkouts.map(row => row.accountId as string))];
  // a customer stays while anything real still names the account
  const realCheckouts = await db.collection("billing_checkouts").distinct("accountId", { accountId: { $in: fakeAccounts }, id: { $nin: checkoutIds } });
  const plan: Array<[string, Document]> = [
    ["billing_checkouts", { id: { $in: checkoutIds } }],
    ["billing_subscriptions", { id: { $in: subIds } }],
    ["billing_invoices", { id: { $in: ids(invoices) } }],
    ["billing_refunds", { paymentId: { $in: paymentIds } }],
    ["billing_ledger", { $or: [{ via: "fixture" }, { subscriptionId: { $in: subIds } }, { providerPaymentId: { $in: paymentIds } }] }],
    ["billing_customers", { accountId: { $in: fakeAccounts.filter(id => !realCheckouts.includes(id)) } }],
  ];
  const counts = await Promise.all(plan.map(([name, filter]) => db.collection(name).countDocuments(filter)));
  for (const [i, [name]] of plan.entries()) console.log(`${name}: ${counts[i]}`);
  if (!values.apply) { console.log("dry run: nothing deleted (add --apply)"); process.exit(0); }

  const lease = await db.collection<{ _id: string; expiresAt: Date }>("locks").findOne({ _id: "account-service" });
  if (lease && lease.expiresAt.getTime() > Date.now() && !values.live) {
    console.error("refused: the account service is running (it holds the writer lease). Stop it first, or pass --live and restart it at once.");
    process.exit(3);
  }
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const [name, filter] of plan) console.log(`deleted ${name}: ${(await db.collection(name).deleteMany(filter, { session })).deletedCount}`);
    });
  } finally { await session.endSession(); }
} finally {
  await client.close();
}
