import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../app.ts";
import { memoryMailer } from "../auth/mail.ts";
import { memorySink } from "../analytics/sink.ts";
import { OPEN_ENDED_AT } from "../billing/service.ts";
import { BILLING_CONFIG } from "../billing/plans.ts";
import { CSRF_HEADER } from "../../../../shared/account-api.ts";
import type { PlanBillingInfo, PlanSubscriptionRow } from "./plans.ts";

const ADMIN = "owner@example.test", OTHER = "someone@example.test";
const DAY = 86_400_000;
type AuditRow = { action: string; target: string; actorEmail: string | null; detail: Record<string, string | number | boolean | null> };
type Profile = { subscriptions: PlanSubscriptionRow[]; payments: Array<{ amountCents: number; status: string }>; clouds: Array<{ id: string; destroyAt: number | null }>; billing: PlanBillingInfo; audit: AuditRow[] };

describe("admin plan edits", () => {
  let mailer: ReturnType<typeof memoryMailer>;
  let app: ReturnType<typeof createDashboardApp>;
  let server: Server;
  let dataDir: string;
  let url: string;
  let time: number;
  let admin: string, other: string, personId: string;
  const origin = "http://127.0.0.1:7999";
  const csrf = new Map<string, string>();

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "madani-admin-plans-"));
    time = Date.parse("2026-11-12T12:00:00Z");
    mailer = memoryMailer();
    csrf.clear();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now: () => time, analytics: { sink: memorySink(() => time) }, admin: { emails: [ADMIN], env: {} } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    admin = await login(ADMIN);
    other = await login(OTHER);
    personId = app.auth.accountByEmail(OTHER)!.id;
  });
  afterEach(async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });

  function call(path: string, init: { body?: unknown; cookie?: string; csrf?: boolean } = {}) {
    return fetch(`${url}${path}`, { method: init.body === undefined ? "GET" : "POST", headers: { origin, ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie, ...(init.csrf === false ? {} : { [CSRF_HEADER]: csrf.get(init.cookie) ?? "" }) } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  }
  async function login(email: string) {
    const start = await call("/v1/auth/start", { body: { email } });
    const { attempt } = await start.json() as { attempt: string };
    const code = mailer.outbox.findLast(item => item.to === email && /\b\d{8}\b/.test(item.text))!.text.match(/\b\d{8}\b/)![0];
    const verify = await call("/v1/auth/verify", { body: { attempt, code } });
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }
  async function edit(body: Record<string, unknown>, expected = 200) {
    const res = await call(`/v1/admin/users/${personId}/plan`, { body, cookie: admin });
    const answer = await res.json() as Profile & { code?: string };
    expect(res.status, JSON.stringify(answer)).toBe(expected);
    time += 1000;
    return answer;
  }
  const live = (profile: Profile) => profile.subscriptions.find(sub => sub.status !== "ended")!;
  const lastAudit = (profile: Profile) => profile.audit[0]!;
  const settle = async () => { for (let n = 0; n < 8; n++) await app.billing.clouds.reconcile(); };

  it("refuses every plan action to a non-admin and without the CSRF header", async () => {
    expect((await call(`/v1/admin/users/${personId}`, { cookie: other })).status).toBe(403);
    for (const body of [{ action: "grant", plan: "starter", until: null }, { action: "change", plan: "pro" }, { action: "set_end", until: null },
      { action: "cancel", when: "now" }, { action: "cancel", when: "period_end" }, { action: "keep" }, { action: "note", text: "hi" }]) {
      const refused = await call(`/v1/admin/users/${personId}/plan`, { body, cookie: other });
      expect(refused.status, body.action).toBe(403);
      expect((await refused.json() as { code: string }).code).toBe("not_admin");
      expect((await call(`/v1/admin/users/${personId}/plan`, { body })).status).toBe(401);
    }
    expect((await call(`/v1/admin/users/${personId}/plan`, { body: { action: "grant", plan: "starter", until: null }, cookie: admin, csrf: false })).status).toBe(403);
    expect(app.billing.store.state.subscriptions).toEqual([]);
  });

  it("validates the action, plan and state", async () => {
    expect((await edit({ action: "upgrade" }, 400)).code).toBe("invalid_request");
    expect((await edit({ action: "grant", plan: "free", until: null }, 400)).code).toBe("invalid_request");
    expect((await edit({ action: "grant", plan: "starter", until: time - 1 }, 400)).code).toBe("invalid_request");
    expect((await edit({ action: "note", text: "x".repeat(501) }, 400)).code).toBe("invalid_request");
    expect((await edit({ action: "keep" }, 409)).code).toBe("not_subscribed");
    expect((await edit({ action: "change", plan: "pro" }, 409)).code).toBe("not_subscribed");
    const missing = await call("/v1/admin/users/acct_nobody/plan", { body: { action: "keep" }, cookie: admin });
    expect(missing.status).toBe(404);
    await edit({ action: "grant", plan: "starter", until: null });
    expect((await edit({ action: "grant", plan: "pro", until: null }, 409)).code).toBe("already_subscribed");
  });

  it("grants a dated comp: active to that day, a $0 payment, a cloud ordered, and one audit entry", async () => {
    const until = time + 10 * DAY;
    const profile = await edit({ action: "grant", plan: "starter", until });
    const sub = live(profile);
    expect(sub).toMatchObject({ status: "active", bundle: "starter", plan: "plus", interval: "month", periodEnd: until, openEnded: false, source: "admin_comp", comp: true, totalCents: 0 });
    expect(sub.cloudId).not.toBeNull();
    expect(profile.payments).toEqual([expect.objectContaining({ amountCents: 0, status: "paid" })]);
    expect(profile.clouds.map(c => c.id)).toEqual([sub.cloudId]);
    expect(profile.billing).toMatchObject({ grants: true, provider: "fake" });
    expect(profile.billing.plans.map(plan => plan.id)).toEqual(["free", "starter", "pro", "team"]);
    expect(profile.billing.plans[1]).toMatchObject({ label: "plus" });
    expect(profile.audit).toHaveLength(1);
    expect(lastAudit(profile)).toMatchObject({ action: "plan.grant", target: personId, actorEmail: ADMIN,
      detail: { ok: true, subscription: sub.id, before: "none", after: "plus active until 2026-11-22", plan: "starter", until } });
    const held = app.billing.fake!.subscriptions.get(app.billing.store.state.subscriptions[0]!.providerSubscriptionId!)!;
    expect(held.nextBillingAt).toBe(until);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mailer.outbox.some(item => item.subject.startsWith("receipt"))).toBe(false);
  });

  it("grants over a checkout the person opened and never paid, and that checkout's cloud is let go", async () => {
    const bundle = BILLING_CONFIG.bundles.find(item => item.id === "pro")!;
    const started = await app.billing.service.checkout({ id: personId, email: OTHER }, { kind: "cart", cart: app.billing.service.quote({ ...bundle.cart, interval: "month" }).cart }, { source: "dash_billing" });
    const profile = await edit({ action: "grant", plan: "starter", until: null });
    expect(live(profile)).toMatchObject({ bundle: "starter", status: "active", openEnded: true });
    expect(app.billing.store.state.checkouts.find(item => item.id === started.checkoutId)!.status).toBe("expired");
  });

  it("grants an open-ended comp, then re-dates it longer, shorter and open-ended again, keeping the license in step", async () => {
    let profile = await edit({ action: "grant", plan: "pro", until: null });
    expect(live(profile)).toMatchObject({ openEnded: true, periodEnd: OPEN_ENDED_AT, bundle: "pro" });
    expect(lastAudit(profile).detail.after).toBe("pro active open-ended");
    const license = () => app.billing.store.state.licenses.find(item => item.ownerAccountId === personId)!;
    expect(license().validUntil).toBe(OPEN_ENDED_AT);

    const longer = time + 90 * DAY;
    profile = await edit({ action: "set_end", until: longer });
    expect(live(profile)).toMatchObject({ periodEnd: longer, openEnded: false });
    expect(license().validUntil).toBe(longer);
    expect(lastAudit(profile)).toMatchObject({ action: "plan.set_end", detail: { before: "pro active open-ended", until: longer } });

    const shorter = time + 3 * DAY;
    profile = await edit({ action: "set_end", until: shorter });
    expect(live(profile).periodEnd).toBe(shorter);
    expect(license().validUntil).toBe(shorter);
    expect(app.billing.licenseCheck({ id: personId, email: OTHER }).work).toBe("licensed");
    expect(lastAudit(profile).detail).toMatchObject({ after: "pro active until 2026-11-15" });

    profile = await edit({ action: "set_end", until: null });
    expect(live(profile).openEnded).toBe(true);
    expect(profile.audit.filter(entry => entry.action === "plan.set_end")).toHaveLength(3);
  });

  it("changes starter to pro through the change lifecycle and keeps a comp at $0", async () => {
    await edit({ action: "grant", plan: "starter", until: null });
    await settle();
    const profile = await edit({ action: "change", plan: "pro" });
    const sub = live(profile);
    expect(sub).toMatchObject({ bundle: "pro", plan: "pro", totalCents: 0, comp: true });
    expect(app.billing.clouds.get(sub.cloudId!)!.kind).toBe("shared_m");
    expect(lastAudit(profile)).toMatchObject({ action: "plan.change", detail: { before: "plus active open-ended", after: "pro active open-ended", plan: "pro" } });
    expect((await edit({ action: "change", plan: "pro" }, 409)).code).toBe("already_on_plan");
  });

  it("cancels at the period end, schedules the cloud, and keep undoes it", async () => {
    const until = time + 20 * DAY;
    await edit({ action: "grant", plan: "starter", until });
    await settle();
    let profile = await edit({ action: "cancel", when: "period_end" });
    const sub = live(profile);
    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(app.billing.clouds.get(sub.cloudId!)!.destroyAt).toBe(until + 30 * DAY);
    expect(lastAudit(profile)).toMatchObject({ action: "plan.cancel_at_end", detail: { after: "plus active until 2026-12-02 cancelling", when: "period_end" } });
    profile = await edit({ action: "keep" });
    expect(live(profile).cancelAtPeriodEnd).toBe(false);
    expect(app.billing.clouds.get(sub.cloudId!)!.destroyAt).toBeNull();
    expect(lastAudit(profile)).toMatchObject({ action: "plan.keep", detail: { before: "plus active until 2026-12-02 cancelling", after: "plus active until 2026-12-02" } });
  });

  it("cancels now: the plan ends and its cloud gets the grace from today", async () => {
    await edit({ action: "grant", plan: "starter", until: null });
    await settle();
    const ended = time;
    const profile = await edit({ action: "cancel", when: "now" });
    const sub = profile.subscriptions[0]!;
    expect(sub.status).toBe("ended");
    expect(profile.subscriptions.filter(row => row.status !== "ended")).toEqual([]);
    const cloud = app.billing.clouds.get(sub.cloudId!)!;
    expect(cloud.ended).toBeTruthy();
    expect(cloud.destroyAt).toBe(ended + 30 * DAY);
    expect(lastAudit(profile)).toMatchObject({ action: "plan.cancel_now", detail: { before: "plus active open-ended", after: "plus ended", when: "now" } });
    expect((await edit({ action: "cancel", when: "now" }, 409)).code).toBe("not_subscribed");
    // a fresh grant is allowed once nothing is live
    expect(live(await edit({ action: "grant", plan: "starter", until: null })).status).toBe("active");
  });

  it("change to free ends the plan now", async () => {
    await edit({ action: "grant", plan: "starter", until: null });
    const profile = await edit({ action: "change", plan: "free" });
    expect(profile.subscriptions[0]!.status).toBe("ended");
    expect(lastAudit(profile)).toMatchObject({ action: "plan.change", detail: { plan: "free", after: "plus ended" } });
  });

  it("stores a note as an audit entry only", async () => {
    const profile = await edit({ action: "note", text: "  comped for the launch  " });
    expect(profile.audit).toEqual([expect.objectContaining({ action: "person.note", target: personId, actorEmail: ADMIN, detail: { text: "comped for the launch" } })]);
    expect(app.billing.store.state.subscriptions).toEqual([]);
  });

  it("moves a paid plan from monthly to yearly and its next renewal, each previewed first and audited", async () => {
    const bundle = BILLING_CONFIG.bundles.find(item => item.id === "starter")!;
    const answer = await app.billing.service.checkout({ id: personId, email: OTHER }, { kind: "cart", cart: app.billing.service.quote({ ...bundle.cart, interval: "month" }).cart });
    const stored = app.billing.store.state.checkouts.find(item => item.id === answer.checkoutId)!;
    for (const delivery of app.billing.fake!.complete(stored.providerSessionId!)) app.billing.service.handleWebhook(delivery.headers, delivery.body);
    const sub = app.billing.store.state.subscriptions[0]!;
    // as if dodo's own checkout made it (fake_ sessions are the preview era's, which dodo never bills)
    stored.providerSessionId = "cks_dodo_test";
    const preview = async (body: Record<string, unknown>, expected = 200) => {
      const res = await call(`/v1/admin/users/${personId}/plan/preview`, { body: { subscription: sub.id, ...body }, cookie: admin });
      expect(res.status).toBe(expected);
      return await res.json() as { before: string; after: string; chargeNowCents: number | null; effects: string[]; code?: string };
    };
    expect((await call(`/v1/admin/users/${personId}/plan/preview`, { body: { action: "interval", interval: "year", subscription: sub.id }, cookie: other })).status).toBe(403);
    const yearly = await preview({ action: "interval", interval: "year" });
    expect(yearly).toMatchObject({ before: expect.stringContaining("plus, monthly"), after: expect.stringContaining("plus, yearly") });
    expect(yearly.chargeNowCents).toBeGreaterThan(0);
    expect((await preview({ action: "interval", interval: "month" }, 409)).code).toBe("already_on_plan");
    let profile = await edit({ action: "interval", interval: "year", subscription: sub.id });
    expect(live(profile)).toMatchObject({ interval: "year", comp: false, mode: "test" });
    expect(lastAudit(profile)).toMatchObject({ action: "plan.interval", detail: { ok: true, from: "month", interval: "year" } });

    // on dodo the renewal moves at the provider first (PATCH next_billing_date), then here
    app.billing.operator.provider = "dodo";
    const later = live(profile).periodEnd! + 20 * DAY;
    expect((await preview({ action: "set_end", until: later })).effects.join(" ")).toContain("dodo moves the next billing date");
    expect((await edit({ action: "set_end", until: null, subscription: sub.id }, 400)).code).toBe("invalid_request");
    profile = await edit({ action: "set_end", until: later, subscription: sub.id });
    expect(live(profile).periodEnd).toBe(later);
    expect(app.billing.fake!.subscriptions.get(sub.providerSubscriptionId!)!.nextBillingAt).toBe(later);
    expect(lastAudit(profile)).toMatchObject({ action: "plan.set_end", detail: { ok: true, until: later } });
  });

  it("answers grants_unavailable where no fake provider completes grants", async () => {
    app.billing.operator.grants = false;
    expect((await edit({ action: "grant", plan: "starter", until: null }, 409)).code).toBe("grants_unavailable");
    app.billing.operator.grants = true;
    await edit({ action: "grant", plan: "starter", until: null });
    app.billing.operator.grants = false;
    // a comp's end lives only here, so it moves on any provider
    const until = time + 40 * DAY;
    expect(lastAudit(await edit({ action: "set_end", until })).detail).toMatchObject({ ok: true, until });
    expect((await call(`/v1/admin/users/${personId}`, { cookie: admin }).then(res => res.json()) as Profile).billing.grants).toBe(false);
  });
});
