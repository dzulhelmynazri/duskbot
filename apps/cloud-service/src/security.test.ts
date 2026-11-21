// Every way in that could delete a managed cloud, tried: none deletes anything before 30 days of no plan and a verified
// final backup, and the owner's own request deletes only after an emailed link and a 7-day undo window.
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../../../shared/account-api.ts";
import { createBilling } from "../../dashboard/server/billing/index.ts";
import { createDashboardApp } from "../../dashboard/server/app.ts";
import { memoryMailer } from "../../dashboard/server/auth/mail.ts";
import type { BillingState } from "../../dashboard/server/billing/store.ts";
import { startFakeInstaboxApi } from "./fake-instabox-api.ts";
import { DAY_MS, deletionVerdict } from "./retention.ts";

vi.mock("../../dashboard/server/billing/index.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../../dashboard/server/billing/index.ts")>();
  return { ...actual, createBilling: vi.fn(actual.createBilling) };
});
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "madani-app-security-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let time = Date.UTC(2026, 10, 9, 12);
  const now = () => time, mailer = memoryMailer();
  const api = await startFakeInstaboxApi({ now }); cleanup.push(() => api.close());
  api.onExec(({ machine, cmd }) => {
    if (cmd.includes("omb-home start") && !machine.volume.size) {
      machine.volume.set("data/.omb-cloud-home.json", Buffer.from(JSON.stringify({ version: 1, machine: machine.metadata["omb.cloud"] })));
      machine.volume.set(`data/${CLOUD_HOME.dataName}/config.json`, Buffer.from("{}"));
    }
    return null;
  });
  for (const key of ["MADANI_BILLING_PROVIDER", "MADANI_CLOUD_PROVIDER", "MADANI_POOL_DRIVER", "MADANI_CLOUD_SEAL_KEY", "MADANI_DODO_PRODUCTS"]) vi.stubEnv(key, undefined);
  vi.stubEnv("MADANI_MANAGED", "1"); vi.stubEnv("INSTABOX_API_KEY", api.key); vi.stubEnv("INSTABOX_BASE_URL", api.baseUrl);
  vi.stubEnv("MADANI_MANAGED_HOME_PACKAGE_URL", "https://packages.example.test/home.tgz"); vi.stubEnv("MADANI_MANAGED_HOME_PACKAGE_SHA256", "b".repeat(64));
  // the homes answer their signed reads; nothing else leaves the machine
  let idle = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname.endsWith(".instabox.tech")) {
      const body = url.pathname === "/api/cloud/health" ? { v: 1 } : url.pathname === "/api/cloud/power" ? { v: 1, idle, busy: idle ? [] : ["turn"], nextDueAt: null }
        : url.pathname === "/api/cloud/power/sleep" ? { ok: idle } : url.pathname === "/api/cloud/entitlement" ? { ok: true, expiresAt: now() + 86_400_000 } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  };
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address.");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const app = createDashboardApp({ dataDir: dir, publicUrl: origin, mailer, staticDir: null, now, fetch: fetcher });
  cleanup.push(() => app.close());
  server.on("request", app.handle);
  const billing = vi.mocked(createBilling).mock.results.at(-1)!.value as ReturnType<typeof createBilling>;
  const csrf = new Map<string, string>();
  function page(path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) {
    return fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie, [CSRF_HEADER]: csrf.get(cookie) ?? "" } : {}), origin, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function login(email: string) {
    const { attempt } = await (await page("/v1/auth/start", { email })).json() as { attempt: string };
    const code = mailer.outbox.findLast(m => m.to === email && /\b\d{8}\b/.test(m.text))!.text.match(/\b\d{8}\b/)![0];
    const verify = await page("/v1/auth/verify", { attempt, code });
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }
  const snapshot = () => JSON.parse(readFileSync(join(dir, "billing.json"), "utf8")) as BillingState;
  async function buy(cookie: string) {
    const checkout = await page("/v1/billing/checkout", { kind: "cart", cart: { interval: "month", license: { kind: "none" }, desktop: { kind: "shared_s", region: "us-west-2" } } }, cookie);
    expect(checkout.status).toBe(200);
    const stored = snapshot().checkouts.at(-1)!;
    for (const delivery of billing.fake!.complete(stored.providerSessionId!)) {
      const answer = await fetch(`${origin}/v1/billing/webhooks/dodo`, { method: "POST", headers: { "content-type": "application/json", ...delivery.headers }, body: new Uint8Array(delivery.body) });
      expect(answer.status).toBe(200);
    }
    const cloud = billing.clouds.get(stored.cloudId!)!;
    for (let n = 0; n < 20 && cloud.status !== "running"; n++) { cloud.nextAttemptAt = 0; await billing.clouds.reconcile(); }
    expect(cloud).toMatchObject({ backend: "managed", status: "running" });
    return { cloud, subscriptionId: snapshot().subscriptions.at(-1)!.providerSubscriptionId! };
  }
  const clouds: Array<{ nextAttemptAt: number }> = [];
  async function settle(times = 6) { for (let n = 0; n < times; n++) { for (const c of clouds) c.nextAttemptAt = 0; await billing.clouds.reconcile(); } }
  return { api, billing, mailer, page, login, buy: async (cookie: string) => { const bought = await buy(cookie); clouds.push(bought.cloud); return bought; }, settle, origin, csrf, setIdle: (v: boolean) => { idle = v; }, advance: (ms: number) => { time += ms; }, now };
}

it("no route, webhook, forged request or account action deletes a managed cloud inside 30 days", async () => {
  const f = await fixture();
  const owner = await f.login("owner@example.test"), other = await f.login("other@example.test");
  const { cloud, subscriptionId } = await f.buy(owner);
  const id = cloud.id;
  const deleteAttempts: Array<[string, unknown, string | undefined, Record<string, string>?]> = [
    [`/v1/clouds/${id}/delete-data`, {}, undefined],
    [`/v1/clouds/${id}/delete-data`, {}, other],
    [`/v1/clouds/${id}/delete-data/confirm`, { token: "x".repeat(43) }, owner],
    [`/v1/clouds/${id}/delete-data/confirm`, { token: "x".repeat(43) }, other],
    [`/v1/clouds/${id}/power`, { action: "off" }, other],
    [`/v1/clouds/${id}`, { name: "x" }, other, { "x-http-method-override": "DELETE" }],
  ];
  for (const [path, body, cookie, extra] of deleteAttempts) expect((await f.page(path, body, cookie, extra)).status).toBeGreaterThanOrEqual(400);
  // without its CSRF header the owner's own cookie is refused
  expect((await fetch(`${f.origin}/v1/clouds/${id}/delete-data`, { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: "{}" })).status).toBe(403);
  for (const method of ["DELETE", "PUT", "PATCH"]) expect((await fetch(`${f.origin}/v1/clouds/${id}/delete-data`, { method, headers: { cookie: owner, [CSRF_HEADER]: f.csrf.get(owner)! } })).status).toBeGreaterThanOrEqual(400);
  // a forged billing webhook: refused before it is read
  expect((await fetch(`${f.origin}/v1/billing/webhooks/dodo`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "evt_forged", "webhook-timestamp": String(Math.floor(f.now() / 1000)), "webhook-signature": "v1,forged" },
    body: JSON.stringify({ type: "subscription.expired", data: { subscription_id: subscriptionId } }) })).status).toBe(401);
  // the owner's subscription is still paid: even a fresh owner request is refused
  expect((await f.page(`/v1/clouds/${id}/delete-data`, {}, owner)).status).toBe(409);
  // a genuine expiry (signed), and an account deletion that asks to destroy desktops now: the clock starts, nothing is deleted
  for (const delivery of f.billing.fake!.expire(subscriptionId)) await fetch(`${f.origin}/v1/billing/webhooks/dodo`, { method: "POST", headers: { "content-type": "application/json", ...delivery.headers }, body: new Uint8Array(delivery.body) });
  f.billing.clouds.end(id, f.now()); f.billing.clouds.scheduleDestroy(id, f.now());
  await f.settle(10);
  expect(cloud.status).toBe("stopped");
  // retention runs from the latest the plan was paid to, never shorter than 30 days from its end
  const endedAt = f.now(), deleteAt = f.billing.clouds.view(cloud).destroyAt!;
  expect(deleteAt - endedAt).toBeGreaterThanOrEqual(30 * DAY_MS);
  while (f.now() + DAY_MS < deleteAt) { f.advance(DAY_MS); await f.settle(2); }
  expect(f.api.deletes()).toHaveLength(0);
  expect(cloud.status).toBe("stopped");
  const kinds = f.mailer.outbox.filter(m => m.to === "owner@example.test" && !/code/i.test(m.subject)).map(m => m.subject);
  expect(kinds.filter(subject => / will be deleted in /.test(subject))).toEqual([expect.stringMatching(/ will be deleted in 7 days$/)]);
  // past it, with a verified final backup: only now
  f.advance(deleteAt - f.now() + 60_000); await f.settle(6);
  expect(f.api.deletes()).toHaveLength(1);
  expect(cloud.status).toBe("destroyed");
  expect(f.mailer.outbox.some(m => /was deleted/.test(m.subject))).toBe(true);
});

it("an owner's delete waits for a fresh sign-in, the emailed link and seven days, and can be undone", async () => {
  const f = await fixture();
  const owner = await f.login("owner@example.test");
  const { cloud, subscriptionId } = await f.buy(owner);
  for (const delivery of f.billing.fake!.expire(subscriptionId)) await fetch(`${f.origin}/v1/billing/webhooks/dodo`, { method: "POST", headers: { "content-type": "application/json", ...delivery.headers }, body: new Uint8Array(delivery.body) });
  await f.settle(8);
  f.advance(11 * 60_000);
  expect(await (await f.page(`/v1/clouds/${cloud.id}/delete-data`, {}, owner)).json()).toMatchObject({ code: "reauth_required" });
  const fresh = await f.login("owner@example.test");
  expect((await f.page(`/v1/clouds/${cloud.id}/delete-data`, {}, fresh)).status).toBe(202);
  const link = f.mailer.outbox.findLast(m => /confirm deleting/i.test(m.subject))!.text.match(/#([A-Za-z0-9_-]{43})/)![1]!;
  expect((await f.page(`/v1/clouds/${cloud.id}/delete-data/confirm`, { token: link.replace(/.$/, link.endsWith("A") ? "B" : "A") }, fresh)).status).toBe(409);
  expect((await f.page(`/v1/clouds/${cloud.id}/delete-data/confirm`, { token: link }, fresh)).status).toBe(200);
  expect((await f.page(`/v1/clouds/${cloud.id}/delete-data/confirm`, { token: link }, fresh)).status).toBe(409);
  for (let day = 1; day < 7; day++) { f.advance(DAY_MS); await f.settle(2); }
  expect(f.api.deletes()).toHaveLength(0);
  expect((await f.page(`/v1/clouds/${cloud.id}/delete-data/cancel`, {}, fresh)).status).toBe(200);
  f.advance(2 * DAY_MS); await f.settle(4);
  expect(f.api.deletes()).toHaveLength(0);
  // asked and confirmed again: deleted after the undo window, backups with it
  const again = await f.login("owner@example.test");
  expect((await f.page(`/v1/clouds/${cloud.id}/delete-data`, {}, again)).status).toBe(202);
  const second = f.mailer.outbox.findLast(m => /confirm deleting/i.test(m.subject))!.text.match(/#([A-Za-z0-9_-]{43})/)![1]!;
  expect((await f.page(`/v1/clouds/${cloud.id}/delete-data/confirm`, { token: second }, again)).status).toBe(200);
  f.advance(7 * DAY_MS + 60_000); await f.settle(6);
  expect(f.api.deletes()).toHaveLength(1);
  expect(cloud.status).toBe("destroyed");
  expect(cloud.managed!.backups).toEqual([]);
});

it("the verdict refuses a short retention, a paid plan, an unknown plan, a hold and a missing final backup", () => {
  const base = { now: 100 * DAY_MS, retentionDays: 30, entitlement: { active: false, until: 10 * DAY_MS }, finalBackup: { at: 9 * DAY_MS, verifiedAt: 9 * DAY_MS }, lastStopAt: 9 * DAY_MS, ownerRequest: null, hold: false };
  expect(deletionVerdict(base)).toMatchObject({ delete: true, reason: "retention_over", earliestAt: 40 * DAY_MS });
  expect(() => deletionVerdict({ ...base, retentionDays: 29 })).toThrow("minimum");
  expect(deletionVerdict({ ...base, now: 40 * DAY_MS - 1 })).toMatchObject({ delete: false, reason: "retention" });
  expect(deletionVerdict({ ...base, entitlement: { active: true, until: null } })).toMatchObject({ delete: false, reason: "subscribed" });
  expect(deletionVerdict({ ...base, entitlement: { active: false, until: null } })).toMatchObject({ delete: false, reason: "no_billing_record" });
  expect(deletionVerdict({ ...base, hold: true })).toMatchObject({ delete: false, reason: "hold" });
  expect(deletionVerdict({ ...base, finalBackup: null })).toMatchObject({ delete: false, reason: "no_final_backup" });
  expect(deletionVerdict({ ...base, finalBackup: null, neverSetUp: true })).toMatchObject({ delete: true, reason: "retention_over" });
  expect(deletionVerdict({ ...base, finalBackup: null, neverSetUp: true, now: 40 * DAY_MS - 1 })).toMatchObject({ delete: false, reason: "retention" });
  expect(deletionVerdict({ ...base, finalBackup: null, neverSetUp: true, hold: true })).toMatchObject({ delete: false, reason: "hold" });
  expect(deletionVerdict({ ...base, finalBackup: { at: 9 * DAY_MS, verifiedAt: null } })).toMatchObject({ delete: false, reason: "no_final_backup" });
  expect(deletionVerdict({ ...base, finalBackup: { at: 8 * DAY_MS, verifiedAt: 8 * DAY_MS } })).toMatchObject({ delete: false, reason: "no_final_backup" });
  expect(deletionVerdict({ ...base, ownerRequest: { requestedAt: 0, confirmedAt: null, executeAfter: null, cancelledAt: null }, now: 20 * DAY_MS })).toMatchObject({ delete: false, reason: "retention" });
  expect(deletionVerdict({ ...base, entitlement: { active: true, until: null }, ownerRequest: { requestedAt: 0, confirmedAt: 1, executeAfter: 2, cancelledAt: null } })).toMatchObject({ delete: false, reason: "subscribed" });
});
