import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBilling } from "./billing/index.ts";
import { createDashboardApp } from "./app.ts";
import { memoryMailer } from "./auth/mail.ts";
import { CSRF_HEADER } from "../../../shared/account-api.ts";
import type { StoredCloud } from "./clouds/types.ts";

vi.mock("./billing/index.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./billing/index.ts")>();
  return { ...actual, createBilling: vi.fn(actual.createBilling) };
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });

async function fixture() {
  for (const key of ["MADANI_BILLING_PROVIDER", "MADANI_CLOUD_PROVIDER", "MADANI_POOL_DRIVER", "MADANI_CLOUD_SEAL_KEY", "MADANI_DODO_PRODUCTS"]) vi.stubEnv(key, undefined);
  const dir = mkdtempSync(join(tmpdir(), "madani-notifications-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const mailer = memoryMailer(), server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address.");
  const origin = `http://127.0.0.1:${address.port}`;
  let app = createDashboardApp({ dataDir: dir, publicUrl: origin, mailer, staticDir: null });
  server.on("request", (req, res) => void app.handle(req, res));
  cleanup.push(() => app.close());
  const restart = () => { app.close(); app = createDashboardApp({ dataDir: dir, publicUrl: origin, mailer, staticDir: null }); };
  const billingOptions = () => vi.mocked(createBilling).mock.calls.at(-1)![0];
  const session = { cookie: "", csrf: "" };
  function call(path: string, { method = "GET", body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    return fetch(`${origin}${path}`, { method, headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session.cookie ? { cookie: session.cookie, [CSRF_HEADER]: session.csrf } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function signIn(email = "owner@example.test") {
    const { attempt } = await (await call("/v1/auth/start", { method: "POST", body: { email } })).json() as { attempt: string };
    const code = mailer.outbox.findLast(item => item.to === email && /\b\d{8}\b/.test(item.text))!.text.match(/\b\d{8}\b/)![0];
    const verified = await call("/v1/auth/verify", { method: "POST", body: { attempt, code } });
    expect(verified.status).toBe(200);
    const answer = await verified.json() as { csrfToken: string; account: { id: string } };
    session.cookie = verified.headers.get("set-cookie")!.split(";")[0]!; session.csrf = answer.csrfToken;
    return answer.account.id;
  }
  return { mailer, call, signIn, restart, billingOptions, session };
}

describe("account notifications", () => {
  it("reads defaults, saves a change on the account and keeps it across a restart", async () => {
    const f = await fixture();
    await f.signIn();
    expect(await (await f.call("/v1/account/notifications")).json()).toEqual({ cloudStatus: true, product: true });
    expect(await (await f.call("/v1/account")).json()).toMatchObject({ notifications: { cloudStatus: true, product: true }, onboarded: false });
    const put = await f.call("/v1/account/notifications", { method: "PUT", body: { product: false } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ cloudStatus: true, product: false });
    f.restart();
    expect(await (await f.call("/v1/account/notifications")).json()).toEqual({ cloudStatus: true, product: false });
    const me = await (await f.call("/v1/me")).json() as { account: Record<string, unknown> };
    expect(me.account).not.toHaveProperty("notifications");
  });

  it("guards the routes: signed in, CSRF, JSON, same origin and a strict body", async () => {
    const f = await fixture();
    expect((await f.call("/v1/account/notifications")).status).toBe(401);
    expect((await f.call("/v1/account/notifications", { method: "PUT", body: { product: false } })).status).toBe(401);
    expect((await f.call("/v1/account/onboarded", { method: "POST", body: {} })).status).toBe(401);
    await f.signIn();
    expect((await f.call("/v1/account/notifications", { method: "PUT", body: { product: false }, headers: { [CSRF_HEADER]: "" } })).status).toBe(403);
    expect((await f.call("/v1/account/onboarded", { method: "POST", body: {}, headers: { [CSRF_HEADER]: "" } })).status).toBe(403);
    expect((await f.call("/v1/account/notifications", { method: "PUT", body: { product: false }, headers: { origin: "https://elsewhere.test" } })).status).toBe(403);
    expect((await f.call("/v1/account/notifications", { method: "PUT", body: { product: false }, headers: { "content-type": "text/plain" } })).status).toBe(403);
    for (const body of [{}, { product: "no" }, { billing: false }, { botDigest: false }, { constructor: false }, { cloudStatus: false, extra: true }]) {
      expect((await f.call("/v1/account/notifications", { method: "PUT", body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(await (await f.call("/v1/account/notifications")).json()).toEqual({ cloudStatus: true, product: true });
  });

  it("stores onboarding on the account, so another browser skips it", async () => {
    const f = await fixture();
    await f.signIn();
    const done = await f.call("/v1/account/onboarded", { method: "POST", body: {} });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ onboarded: true });
    f.restart();
    await f.signIn();
    expect(await (await f.call("/v1/account")).json()).toMatchObject({ onboarded: true });
    expect((await f.call("/v1/account/onboarded", { method: "POST", body: {} })).status).toBe(200);
  });
});

describe("account emails follow the settings", () => {
  const cloud = (accountId: string) => ({ id: "cloud_1", accountId, name: "studio", kind: "shared_s", region: "eu", spec: { vcpu: 2, ramGb: 4, diskGb: 40 } }) as unknown as StoredCloud;
  const sentTo = (f: Awaited<ReturnType<typeof fixture>>, since: number) => f.mailer.outbox.slice(since).map(mail => mail.subject);

  it("skips cloud status mail when it is off, and always sends billing and deletion mail", async () => {
    const f = await fixture();
    const id = await f.signIn(), options = f.billingOptions();
    let since = f.mailer.outbox.length;
    options.cloudEvent!("ready", cloud(id));
    options.mail!(cloud(id), { subject: "back", text: "back", notice: { kind: "recovered", at: Date.now() } });
    expect(sentTo(f, since)).toEqual(["your madani cloud is ready", "studio is back"]);
    expect((await f.call("/v1/account/notifications", { method: "PUT", body: { cloudStatus: false, product: false } })).status).toBe(200);
    since = f.mailer.outbox.length;
    options.cloudEvent!("ready", cloud(id));
    options.mail!(cloud(id), { subject: "back", text: "back", notice: { kind: "recovered", at: Date.now() } });
    options.mail!(cloud(id), { subject: "warn", text: "warn", notice: { kind: "left_7", at: Date.now() } });
    options.cloudEvent!("deleted", cloud(id));
    options.notify!({ kind: "receipt", accountId: id, invoiceId: "inv_1", amountCents: 1200, currency: "USD", description: "plan", paidAt: Date.now(),
      periodStart: null, periodEnd: null, renews: true, first: true, cloudId: null, revived: false });
    options.notify!({ kind: "payment_failed", accountId: id, amountCents: 1200, currency: "USD", description: "plan", cloudId: null, fixBy: null });
    const subjects = sentTo(f, since);
    expect(subjects).not.toContain("your madani cloud is ready");
    expect(subjects).not.toContain("studio is back");
    expect(subjects).toHaveLength(4);
    expect(subjects[0]).toBe("studio will be deleted in 7 days");
    expect(subjects[2]).toMatch(/^receipt for /);
  });
});
