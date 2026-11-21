import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// the account service restarted the way its supervisor does it (and the way that crash-looped production on
// 2026-11-20): two real processes on one database. needs a replica set: MADANI_TEST_MONGODB_URI, MADANI_TEST_MONGODB_DB (its
// collections are dropped; run apart from mongo.test.ts, which uses the same database)
const uri = process.env.MADANI_TEST_MONGODB_URI, dbName = process.env.MADANI_TEST_MONGODB_DB || "madani_test";
const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));

const freePort = () => new Promise<number>(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
const children: ChildProcess[] = [], dirs: string[] = [];

function start(port: number) {
  const data = mkdtempSync(join(tmpdir(), "madani-restart-")); dirs.push(data);
  const child = spawn(process.execPath, [MAIN], { env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: dbName, MADANI_DASHBOARD_PORT: String(port), MADANI_DASHBOARD_DATA: data,
    MADANI_DASHBOARD_PUBLIC_URL: `http://127.0.0.1:${port}`, MADANI_DASHBOARD_STATIC: "", MADANI_ALERTS: "off", MADANI_BILLING_PROVIDER: "preview", MADANI_OPS_TOKEN: "restart-test-".padEnd(40, "x") }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout!.on("data", chunk => { out += chunk; });
  child.stderr!.on("data", chunk => { out += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  const listening = async (ms: number) => { const until = Date.now() + ms; while (!out.includes("dashboard service listening")) { if (Date.now() > until) throw new Error(`not listening:\n${out}`); await new Promise(r => setTimeout(r, 100)); } };
  return { child, exited, listening, out: () => out };
}
const health = (port: number) => fetch(`http://127.0.0.1:${port}/v1/health`).then(r => r.status, () => 0);

async function empty() {
  const client = await MongoClient.connect(uri!), db = client.db(dbName);
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) await db.collection(name).drop();
  await client.close();
}

describe.skipIf(!uri)("the account service restarting", () => {
  beforeEach(empty);
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    await empty();
  });

  it("a start beside the running service waits (never exits), and takes over within seconds of a SIGTERM to the old one", async () => {
    const port = await freePort();
    const old = start(port);
    await old.listening(30_000);
    const next = start(port);
    await new Promise(r => setTimeout(r, 8_000));
    expect(next.child.exitCode).toBeNull();
    expect(next.out()).toMatch(/holds the writer lease; waiting/);
    const stoppedAt = Date.now();
    old.child.kill("SIGTERM");
    expect(await old.exited).toBe(0);
    // inside the supervisor's 5 s before its SIGKILL
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    await next.listening(15_000);
    expect(await health(port)).toBe(200);
    await new Promise(r => setTimeout(r, 3_000));
    expect(next.child.exitCode).toBeNull();
  }, 90_000);

  it("a start after the old one was killed outright takes the lease at once", async () => {
    const port = await freePort();
    const old = start(port);
    await old.listening(30_000);
    old.child.kill("SIGKILL");
    await old.exited;
    const startedAt = Date.now();
    const next = start(port);
    await next.listening(15_000);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(next.out()).toMatch(/took the writer lease from process/);
    expect(await health(port)).toBe(200);
  }, 60_000);
});
