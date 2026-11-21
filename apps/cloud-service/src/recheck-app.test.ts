// an independent review of billing and account paths through the whole dashboard app
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
import { DAY_MS } from "./retention.ts";

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



async function deliver(f: Awaited<ReturnType<typeof fixture>>, deliveries: Array<{ headers: Record<string, string>; body: Buffer | Uint8Array }>) {
  for (const d of deliveries) await fetch(`${f.origin}/v1/billing/webhooks/dodo`, { method: "POST", headers: { "content-type": "application/json", ...d.headers }, body: new Uint8Array(d.body) });
}
type Fx = Awaited<ReturnType<typeof fixture>>;
/** advances day by day, failing on any DELETE before `until` */
async function noDeleteUntil(f: Fx, until: number) { while (f.now() + DAY_MS < until) { f.advance(DAY_MS); await f.settle(1); expect(f.api.deletes()).toHaveLength(0); } }

for (const destroyNow of [false, true]) {
  // since 4c4bf4ad3 a deleted account's clouds go at once, whatever destroyDesktopsNow says
  it(`account closed with a paid plan (destroyDesktopsNow=${destroyNow}): its cloud is deleted at once and stays deleted`, async () => {
    const f = await fixture();
    const owner = await f.login("owner@example.test");
    const { cloud, subscriptionId } = await f.buy(owner);
    expect((await f.page("/v1/account/delete", { email: "owner@example.test", cancelBilling: true, destroyDesktopsNow: destroyNow }, owner)).status).toBe(200);
    await f.settle(6);
    expect(cloud.status).toBe("destroyed");
    // Dodo's late expiry for a closed account changes nothing
    await deliver(f, f.billing.fake!.expire(subscriptionId)); await f.settle(4);
    f.advance(31 * DAY_MS); await f.settle(6);
    expect(cloud.status).toBe("destroyed");
  });
}

it("cancel at period end with Dodo silent afterwards: stopped at the period end, a stable deletion date under replayed and late events", async () => {
  const f = await fixture();
  const owner = await f.login("owner@example.test");
  const { cloud, subscriptionId } = await f.buy(owner);
  const renewal = f.billing.fake!.renew(subscriptionId); await deliver(f, renewal); await f.settle(2);
  const sub = f.billing.service.subscriptions(cloud.accountId)[0]!;
  expect((await f.page(`/v1/billing/subscriptions/${sub.id}/cancel`, {}, owner)).status).toBe(200);
  const periodEnd = f.billing.service.subscriptions(cloud.accountId)[0]!.currentPeriodEnd!;
  f.advance(periodEnd - f.now() + 60_000); await f.settle(6);
  expect(cloud.status).toBe("stopped");
  const first = f.billing.clouds.view(cloud).destroyAt!;
  const st = f.billing.service.subscriptions(cloud.accountId)[0]!;
  console.info(`[debug] periodEnd=${periodEnd} subNow=${JSON.stringify({ status: st.status, cpe: st.currentPeriodEnd, cancel: st.cancelAtPeriodEnd })} cloud=${JSON.stringify({ ended: cloud.ended, endedAt: cloud.endedAt, endsAt: cloud.endsAt, destroyAt: cloud.destroyAt, bEnded: cloud.managed!.endedAt })} destroyAt=${f.billing.clouds.view(cloud).destroyAt} first-periodEnd(d)=${(first - periodEnd) / DAY_MS}`);
  expect(first).toBe(periodEnd + 30 * DAY_MS);
  // replays and a late expiry days later
  f.advance(3 * DAY_MS);
  await deliver(f, renewal); await deliver(f, f.billing.fake!.expire(subscriptionId)); await deliver(f, f.billing.fake!.expire(subscriptionId));
  await f.settle(4);
  const after = f.billing.clouds.view(cloud).destroyAt!;
  console.info(`[recheck] late expiry moved the deletion date by ${(after - first) / DAY_MS} days`);
  expect(after).toBe(first);
  await noDeleteUntil(f, after);
});

it("the deletion routes: confirm needs a fresh sign-in, Cancel works during the 7 days, and nothing is deleted", async () => {
  const f = await fixture();
  const owner = await f.login("owner@example.test");
  const { cloud, subscriptionId } = await f.buy(owner);
  await deliver(f, f.billing.fake!.expire(subscriptionId)); await f.settle(8);
  expect((await f.page(`/v1/clouds/${cloud.id}/delete-data`, {}, owner)).status).toBe(202);
  const token = f.mailer.outbox.findLast(m => /confirm deleting/i.test(m.subject))!.text.match(/#([A-Za-z0-9_-]{43})/)![1]!;
  expect(f.mailer.outbox.findLast(m => /confirm deleting/i.test(m.subject))!.text).toContain(`/clouds/${cloud.id}/delete#`);
  f.advance(11 * 60_000);
  const stale = await f.page(`/v1/clouds/${cloud.id}/delete-data/confirm`, { token }, owner);
  expect(stale.status).toBe(403); expect(((await stale.json()) as { code?: string }).code).toBe("reauth_required");
  const fresh = await f.login("owner@example.test");
  expect((await f.page(`/v1/clouds/${cloud.id}/delete-data/confirm`, { token }, fresh)).status).toBe(200);
  for (let day = 1; day <= 6; day++) { f.advance(DAY_MS); await f.settle(1); }
  // cancel from a session that is not fresh still works (undo should be easy)
  expect((await f.page(`/v1/clouds/${cloud.id}/delete-data/cancel`, {}, fresh)).status).toBe(200);
  f.advance(3 * DAY_MS); await f.settle(4);
  expect(f.api.deletes()).toHaveLength(0);
  expect(cloud.status).toBe("stopped");
});
