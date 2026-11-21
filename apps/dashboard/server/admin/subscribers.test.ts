import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../analytics/sink.ts";
import { bucketOf, dailyMessages, handleOf, LAUNCH_AT, LAUNCH_LABEL, launchStrip, statusLine, subscriberRows, timelineOf, usageOf } from "./subscribers.ts";

const DAY = 86_400_000, NOW = LAUNCH_AT + 2.5 * DAY;
type Sub = Parameters<typeof bucketOf>[0];
const sub = (over: Partial<Sub> & { accountId: string }): Sub => ({ id: `sub_${over.accountId}`, status: "active", cancelAtPeriodEnd: false, createdAt: NOW - DAY, currentPeriodStart: NOW - DAY,
  currentPeriodEnd: NOW + 29 * DAY, totalCents: 2000, cart: { interval: "month" } as Sub["cart"], ...over });
const trial = (accountId: string, over: Partial<Sub> = {}) => sub({ accountId, trialEndsAt: NOW + 2 * DAY, createdAt: NOW - DAY, ...over });
let seq = 0;
const ev = (name: string, at: number, accountId: string, props: StoredEvent["props"] = {}, ctx?: StoredEvent["ctx"]): StoredEvent => ({ id: `e${seq++}`, name, at, accountId, props, ...(ctx ? { ctx } : {}) });

describe("subscriber status", () => {
  it("sorts each subscription into trial, cancelling, paid, payment problem or cancelled and says how far a trial is", () => {
    expect(bucketOf(trial("a"), NOW)).toBe("trial");
    expect(statusLine(trial("a"), NOW)).toBe("trial day 2 of 3");
    expect(bucketOf(trial("b", { cancelAtPeriodEnd: true }), NOW)).toBe("cancelling");
    expect(statusLine(trial("b", { cancelAtPeriodEnd: true }), NOW)).toBe("trial day 2 of 3, cancelling");
    expect(bucketOf(sub({ accountId: "c" }), NOW)).toBe("paid");
    expect(statusLine(sub({ accountId: "c", status: "payment_problem" }), NOW)).toBe("payment problem");
    expect(bucketOf(sub({ accountId: "c", status: "payment_problem" }), NOW), "a failed charge is never paid").toBe("payment_problem");
    expect(bucketOf(sub({ accountId: "c", status: "payment_problem", trialEndsAt: NOW - DAY }), NOW), "a trial whose first charge failed").toBe("payment_problem");
    expect(bucketOf(sub({ accountId: "d", status: "ended" }), NOW)).toBe("cancelled");
    expect(handleOf("acct_1")).toBe(handleOf("acct_1"));
    expect(handleOf("acct_1")).not.toBe(handleOf("acct_2"));
  });
});

describe("launch strip", () => {
  it("counts only accounts made at or after launch, mrr that will bill, and money received before tax net of refunds", () => {
    const accounts = [{ id: "old", createdAt: LAUNCH_AT - 1 }, { id: "t", createdAt: LAUNCH_AT }, { id: "p", createdAt: LAUNCH_AT + DAY }, { id: "x", createdAt: LAUNCH_AT + DAY }, { id: "y", createdAt: LAUNCH_AT + DAY }];
    const subscriptions = [sub({ accountId: "old" }), trial("t"), sub({ accountId: "p", totalCents: 24000, cart: { interval: "year" } as Sub["cart"] }),
      trial("x", { cancelAtPeriodEnd: true }), sub({ accountId: "y", status: "ended" }), sub({ accountId: "t", id: "grant", source: "ops_grant" })] as never;
    const invoices = [
      { accountId: "p", providerPaymentId: "pay_p", subscriptionId: "sub_p", amountCents: 24000, status: "paid", createdAt: LAUNCH_AT + DAY },
      { accountId: "y", providerPaymentId: "pay_y", subscriptionId: "sub_y", amountCents: 2400, taxCents: 400, status: "paid", createdAt: LAUNCH_AT + DAY },
      { accountId: "x", providerPaymentId: "pay_x", subscriptionId: "sub_x", amountCents: 2000, status: "failed", createdAt: LAUNCH_AT + DAY },
      { accountId: "old", providerPaymentId: "pay_old", subscriptionId: "sub_old", amountCents: 2000, status: "paid", createdAt: LAUNCH_AT - DAY },
    ] as never;
    const strip = launchStrip({ subscriptions, invoices, refunds: [{ id: "r1", paymentId: "pay_y", amountCents: 600, currency: "usd" }] }, accounts, NOW);
    expect(strip).toEqual({ since: LAUNCH_AT, label: LAUNCH_LABEL, accounts: 4, mrrCents: 2000 + 2000, atRiskCents: 0, trial: 1, paying: 1, paymentProblem: 0, cancelling: 1, cancelled: 1, receivedCents: 24000 + (2000 - 500) });
    expect(LAUNCH_LABEL).toBe("since nov 18, 7:56 pm ist");
    const failed = launchStrip({ subscriptions: [...subscriptions as Sub[], sub({ accountId: "f", status: "payment_problem", trialEndsAt: NOW - DAY })] as never, invoices, refunds: [] }, [...accounts, { id: "f", createdAt: LAUNCH_AT + DAY }], NOW);
    expect(failed, "a failed charge is not paying and not mrr, only at risk").toMatchObject({ paying: 1, paymentProblem: 1, mrrCents: 2000 + 2000, atRiskCents: 2000 });
    expect(new Date(LAUNCH_AT).toISOString()).toBe("2026-11-18T14:26:00.000Z");
  });
});

describe("subscriber rows", () => {
  it("joins a person's plan, messages, usage, platforms and where their bots run", () => {
    const rows = subscriberRows({
      now: NOW, accounts: [{ id: "a", email: "a@x.test", name: "Ada", createdAt: NOW - 3 * DAY }],
      sessions: [{ accountId: "a", kind: "desktop", platform: "darwin", lastSeenAt: NOW - 3600_000 }],
      billing: { subscriptions: [trial("a")] as never, invoices: [], feedback: [], customers: [{ accountId: "a", email: "a@x.test", providerCustomerId: null, attribution: { source: "x", channel: "social", campaign: null, referrer: null, country: "IN", firstSeen: null } }] },
      events: [ev("app_messages", NOW - DAY, "a", { sent: 4 }), ev("app_messages", NOW - 10 * DAY, "a", { sent: 6 }), ev("app_open", NOW - DAY, "a", { kind: "desktop", platform: "win32" })],
      people: [{ day: new Date(NOW - DAY).toISOString().slice(0, 10), accountId: "a", turns: 12, failed: 2, runs: 1, frustrations: 0, appTurns: 3 }],
      snapshots: [{ workspaceId: "w1", accountId: "a", at: NOW, snapshot: { bots: 3, rooms: 0, routines: 2, webhooks: 0, appEvents: 1, skills: 0, botEngines: { claude: 2, codex: 1 } } }],
      workspaces: [{ id: "w1", ownerAccountId: "a", kind: "mac", report: { apps: { services: [{ connected: true }, { connected: false }] } } }, { id: "w2", ownerAccountId: "a", kind: "vps" }, { id: "w3", ownerAccountId: "a", kind: "vps" }] as never,
      clouds: [{ accountId: "a", workspaceId: "w3", status: "sleeping" }],
      planOf: () => "starter",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: "a", email: "a@x.test", country: "IN", plan: "starter", bucket: "trial", status: "trial day 2 of 3", messages7d: 4, messages: 10,
      turns: 12, failed: 2, bots: 3, routines: 3, apps: 1, engines: ["claude", "codex"], platforms: ["mac", "windows"], places: ["madani cloud", "own server", "this computer"], cloud: "asleep" });
  });
  it("leaves out people with only a pending checkout or an operator's grant", () => {
    const rows = subscriberRows({ now: NOW, accounts: [], sessions: [], billing: { subscriptions: [trial("a", { status: "pending" }), sub({ accountId: "b", review: true })] as never, invoices: [], feedback: [], customers: [] },
      events: [], people: [], snapshots: [], workspaces: [], clouds: [], planOf: () => "starter" });
    expect(rows).toEqual([]);
  });
});

describe("subscriber detail", () => {
  it("tells the story from sign-up to the cancel survey, oldest first, with daily messages and what went wrong", () => {
    const events = [ev("signup", NOW - 2 * DAY, "a"), ev("onboarding_step", NOW - 2 * DAY + 60_000, "a", { step: "plan" }), ev("first_bot_reply", NOW - 2 * DAY + 120_000, "a"),
      ev("app_messages", NOW - 1000, "a", { sent: 3 }), ev("app_action", NOW - 500, "a", { name: "turn_failed", reason: "quota", engine: "codex" }), ev("app_feature", NOW - 400, "a", { feature: "voice_used" })];
    const steps = timelineOf(events, [trial("a", { createdAt: NOW - DAY, cancelAtPeriodEnd: true })], [{ at: NOW - 100, answer: "price" }], NOW - 3 * DAY, NOW);
    expect(steps.map(step => step.label)).toEqual(["account made", "signed up", "onboarding: plan", "first bot reply", "trial started (3 days)", "cancel survey: price"]);
    expect(dailyMessages(events, NOW).at(-1)).toMatchObject({ sent: 3 });
    const used = usageOf(events);
    expect(used.failures).toEqual([{ key: "turn failed: quota (codex)", count: 1 }]);
    expect(used.features).toEqual([{ key: "voice used", count: 1 }]);
  });
});
