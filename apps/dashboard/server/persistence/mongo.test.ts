import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { holderGone, openMongoBackend } from "./mongo.ts";

// needs a replica set; MADANI_TEST_MONGODB_URI names a server whose user may drop MADANI_TEST_MONGODB_DB (default madani_test)
const uri = process.env.MADANI_TEST_MONGODB_URI, dbName = process.env.MADANI_TEST_MONGODB_DB || "madani_test";
const layouts = { auth: { accounts: { collection: "accounts", key: (row: Record<string, unknown>) => row.id as string, indexes: [{ keys: { email: 1 as const }, unique: true }] } } };
type Auth = { accounts: Array<{ id: string; email: string }>; v: number };
const valid = (value: unknown): value is Auth => !!value && Array.isArray((value as Auth).accounts);

async function empty() {
  const client = await MongoClient.connect(uri!), db = client.db(dbName);
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) await db.collection(name).drop();
  await client.close();
}

describe("the writer lease's holder", () => {
  it("is gone only when it ran on this host as a process that no longer runs", () => {
    expect(holderGone({ host: "box", pid: 41 }, "box", () => false)).toBe(true);
    expect(holderGone({ host: "box", pid: 41 }, "box", () => true)).toBe(false);
    expect(holderGone({ host: "other", pid: 41 }, "box", () => false)).toBe(false);
    expect(holderGone({ host: "box", pid: process.pid }, "box", () => false)).toBe(false);
    expect(holderGone({ host: "box" }, "box", () => false)).toBe(false);
    // the real check: this process runs, a pid far past any real one does not
    expect(holderGone({ host: "box", pid: process.pid + 0 }, "box")).toBe(false);
    expect(holderGone({ host: "box", pid: 2 ** 22 + 7 }, "box")).toBe(true);
  });
});

describe.skipIf(!uri)("mongodb backend", () => {
  afterAll(empty);

  it("persists across processes, holds one writer at a time, and enforces unique indexes", async () => {
    await empty();
    const first = await openMongoBackend({ uri: uri!, db: dbName, layouts, log: () => {} });
    const store = first.backend.open<Auth>("auth", () => ({ accounts: [], v: 1 }), valid);
    store.state.accounts.push({ id: "a1", email: "one@example.test" });
    store.commit();
    await first.backend.settled();

    await expect(openMongoBackend({ uri: uri!, db: dbName, layouts, log: () => {}, acquireWaitMs: 3000 })).rejects.toThrow(/writer lease/);

    store.state.accounts.push({ id: "a2", email: "one@example.test" });
    store.commit();
    await expect(first.backend.settled(1500)).rejects.toThrow();
    expect(first.backend.health().ok).toBe(false);
    store.state.accounts.pop();
    store.commit();
    await first.backend.settled(15_000);
    await first.close();

    const second = await openMongoBackend({ uri: uri!, db: dbName, layouts, log: () => {} });
    const again = second.backend.open<Auth>("auth", () => ({ accounts: [], v: 1 }), valid);
    expect(again.state).toEqual({ v: 1, accounts: [{ id: "a1", email: "one@example.test" }] });
    await second.close();
  }, 90_000);

  it("a start that died holding the lease on this host is not waited out", async () => {
    await empty();
    const client = await MongoClient.connect(uri!);
    await client.db(dbName).collection<{ _id: string }>("locks").insertOne({ _id: "account-service", owner: "crashed", host: (await import("node:os")).hostname(), pid: 2 ** 22 + 7, expiresAt: new Date(Date.now() + 30_000) } as never);
    await client.close();
    const lines: string[] = [];
    const started = Date.now();
    const next = await openMongoBackend({ uri: uri!, db: dbName, layouts, log: line => lines.push(line), acquireWaitMs: 3000 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lines.join("\n")).toMatch(/took the writer lease/);
    await next.close();
  }, 30_000);
});
