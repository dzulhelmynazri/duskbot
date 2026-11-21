import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Cart, ChangePreview, CheckoutAnswer, TeamView } from "../../../../shared/billing-api.ts";
import { homeEnv } from "../clouds/bootstrap.ts";
import { createBilling } from "./index.ts";
import { BILLING_CONFIG } from "./plans.ts";
import type { TeamMail } from "./team.ts";
import { INVITE_TTL_MS } from "./team.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });

const people = { owner: { id: "acct_owner", email: "sid@qa.madani.test" }, ada: { id: "acct_ada", email: "ada@qa.madani.test" }, bo: { id: "acct_bo", email: "bo@qa.madani.test" }, eve: { id: "acct_eve", email: "eve@qa.madani.test" } };
type Who = keyof typeof people;

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "madani-team-"));
  let time = Date.now();
  const mail: TeamMail[] = [];
  const who = (req: { headers: Record<string, unknown> }) => people[req.headers["x-who"] as Who] ?? null;
  const billing = createBilling({ dataDir: dir, publicUrl: "http://127.0.0.1", env: {}, now: () => time, dashboard: { state: { accounts: [], sessions: [], workspaces: [], commands: [] }, changed() {} },
    accounts: { fromCookie: who, fromBearer: who }, teamMail: message => mail.push(message), accountEmail: id => Object.values(people).find(p => p.id === id)?.email ?? null, accountName: () => null });
  const server = createServer(async (req, res) => { if (!await billing.handle(req, res, new URL(req.url!, "http://127.0.0.1"))) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => billing.close(), () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  async function call(as: Who, method: string, path: string, data?: unknown) {
    const headers: Record<string, string> = { "x-who": as, "content-type": "application/json", ...(path.startsWith("/api/") ? { authorization: `Bearer omc_${"a".repeat(43)}` } : {}) };
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }
  const team = async (as: Who) => (await call(as, "GET", "/v1/team")).body.team as TeamView | null;
  const tokenFor = (email: string) => mail.findLast((m): m is Extract<TeamMail, { kind: "invite" }> => m.kind === "invite" && m.to === email)!.token;
  return { billing, call, team, mail, tokenFor, setTime: (at: number) => { time = at; }, now: () => time };
}

async function teamPlan(f: Awaited<ReturnType<typeof fixture>>) {
  const cart: Cart = { ...structuredClone(BILLING_CONFIG.bundles.find(b => b.id === "team")!.cart), interval: "month" };
  const checkout = (await f.call("owner", "POST", "/v1/billing/checkout", { kind: "cart", cart })).body as unknown as CheckoutAnswer;
  expect((await f.call("owner", "POST", "/v1/billing/fake/complete", { checkoutId: checkout.checkoutId })).status).toBe(200);
  for (let n = 0; n < 8; n++) await f.billing.clouds.reconcile();
  const cloud = f.billing.clouds.get(checkout.cloudId!)!;
  expect(cloud.status).toBe("running");
  return cloud;
}

it("boots a team plan's cloud as a Team Cloud and only that one", () => {
  const input = { cloudId: "c".padEnd(25, "0"), adminOrigin: "https://madani.bot", secret: "s".repeat(43), origin: "https://x.example.test", dashboardUrl: "https://madani.bot" };
  expect(homeEnv(input)).toMatchObject({ MADANI_CLOUD_ROLE: "home" });
  expect(homeEnv(input)).not.toHaveProperty("MADANI_CLOUD_TEAM_ID");
  expect(homeEnv({ ...input, team: { id: input.cloudId, name: "sid's team" } })).toMatchObject({ MADANI_CLOUD_ROLE: "team", MADANI_CLOUD_TEAM_ID: input.cloudId, MADANI_CLOUD_TEAM_NAME: "sid's team" });
});

it("invites by email, holds a seat per invite, caps joins at paid seats, adds seats through the plan and removing someone ends their cloud access", async () => {
  const f = await fixture(), cloud = await teamPlan(f);
  expect(cloud.team).toEqual({ id: cloud.id, name: "sid's team" });
  expect(await f.team("owner")).toMatchObject({ role: "owner", name: "sid's team", seats: { used: 1, pending: 0, paid: 2, included: 2, max: 50 }, cloud: { id: cloud.id, joinable: true } });
  expect(await f.team("ada")).toBeNull();

  // only the owner invites; a second invite past the paid seats is refused
  expect((await f.call("owner", "POST", "/v1/team/invites", { email: " Ada@QA.madani.test " })).body.team).toMatchObject({ seats: { used: 1, pending: 1 }, invites: [{ email: "ada@qa.madani.test", refusedAt: null }] });
  expect(f.mail.at(-1)).toMatchObject({ kind: "invite", to: "ada@qa.madani.test", team: "sid's team", from: "sid@qa.madani.test", token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  expect(await f.call("owner", "POST", "/v1/team/invites", { email: "bo@qa.madani.test" })).toMatchObject({ status: 409, body: { code: "seats_full" } });
  expect((await f.call("owner", "POST", "/v1/team/invites", { email: "not an email" })).status).toBe(400);
  expect(JSON.stringify(f.billing.store.state.teamInvites)).not.toContain(f.tokenFor("ada@qa.madani.test"));

  // the link works for its own address only, once
  const token = f.tokenFor("ada@qa.madani.test");
  expect(await f.call("eve", "POST", "/v1/team/join", { token })).toMatchObject({ status: 403, body: { code: "invite_other_email" } });
  expect(await f.call("ada", "POST", "/v1/team/join", { token: "x".repeat(43) })).toMatchObject({ status: 410, body: { code: "invite_invalid" } });
  const joined = (await f.call("ada", "POST", "/v1/team/join", { token })).body.team as TeamView;
  expect(joined).toMatchObject({ role: "member", invites: [], subscriptionId: null, seats: { used: 2, pending: 0, paid: 2 } });
  expect(joined.members.map(m => [m.email, m.role, m.you])).toEqual([["sid@qa.madani.test", "owner", false], ["ada@qa.madani.test", "member", true]]);
  expect((await f.call("ada", "POST", "/v1/team/join", { token })).status).toBe(200);
  expect(await f.call("eve", "POST", "/v1/team/join", { token })).toMatchObject({ status: 410 });
  expect((await f.call("ada", "POST", "/v1/team/invites", { email: "bo@qa.madani.test" })).status).toBe(403);
  expect((await f.call("ada", "DELETE", "/v1/team/members/sid%40qa.madani.test")).status).toBe(403);
  expect((await f.call("owner", "DELETE", "/v1/team/members/sid%40qa.madani.test")).status).toBe(403);

  // the member's app sees the team and pairs with a signed member claim; the owner pairs as its owner
  expect(f.billing.sessionFields(people.ada).teams).toEqual([{ id: cloud.id, name: "sid's team", role: "member", machine: expect.objectContaining({ state: "ready", origin: cloud.origin }) }]);
  expect(f.billing.sessionFields(people.owner).teams).toEqual([]);
  const pairMember = vi.spyOn(f.billing.clouds, "pairMember"), pair = vi.spyOn(f.billing.clouds, "pair");
  expect((await f.call("ada", "POST", `/api/cloud/desktop/teams/${cloud.id}/pairing`, {})).body).toMatchObject({ origin: cloud.origin, code: expect.any(String), cloudContractVersion: 1 });
  expect(pairMember).toHaveBeenCalledWith(cloud.id, { email: "ada@qa.madani.test", role: "member" });
  expect((await f.call("eve", "POST", `/api/cloud/desktop/teams/${cloud.id}/pairing`, {})).status).toBe(404);
  expect((await f.call("owner", "POST", "/api/cloud/desktop/pairing", { cloudId: cloud.id })).status).toBe(200);
  expect(pair).toHaveBeenCalledWith(people.owner.id, cloud.id, people.owner.email);

  // add a seat through the plan's own change (the fake provider stands in for dodo's change-plan)
  const sub = f.billing.store.state.subscriptions.find(row => row.cloudId === cloud.id)!;
  const preview = (await f.call("owner", "POST", `/v1/billing/subscriptions/${sub.id}/preview`, { cart: { ...sub.cart, license: { kind: "team", members: 3 } } })).body as unknown as ChangePreview;
  expect(preview.quote.lines.find(line => line.kind === "members")).toMatchObject({ amountCents: BILLING_CONFIG.licenses.team.extraMemberCents });
  expect((await f.call("owner", "POST", `/v1/billing/subscriptions/${sub.id}/change`, { confirmation: preview.confirmation })).status).toBe(200);
  expect((await f.team("owner"))!.seats).toMatchObject({ used: 2, paid: 3 });
  expect((await f.call("owner", "POST", "/v1/team/invites", { email: "bo@qa.madani.test" })).status).toBe(200);

  // the cap holds at the join too: the person and the owner hear why, the owner once, and the same link works after
  const license = f.billing.store.state.licenses.find(row => row.kind === "team")!;
  license.seats = 2;
  const sent = f.mail.length;
  for (let n = 0; n < 2; n++) expect(await f.call("bo", "POST", "/v1/team/join", { token: f.tokenFor("bo@qa.madani.test") })).toMatchObject({ status: 409, body: { code: "seats_full" } });
  expect(f.mail.slice(sent)).toEqual([{ kind: "seat_full", to: "sid@qa.madani.test", team: "sid's team", email: "bo@qa.madani.test", seats: 2 }]);
  expect((await f.team("owner"))!.invites).toEqual([expect.objectContaining({ email: "bo@qa.madani.test", refusedAt: expect.any(Number) })]);
  license.seats = 3;
  expect((await f.call("bo", "POST", "/v1/team/join", { token: f.tokenFor("bo@qa.madani.test") })).status).toBe(200);

  // removing a member: no more pairing, no team in their session, and the cloud is told (again later if it can't hear)
  const memberLeft = vi.spyOn(f.billing.clouds, "memberLeft").mockRejectedValueOnce(new Error("asleep"));
  expect(((await f.call("owner", "DELETE", "/v1/team/members/ada%40qa.madani.test")).body.team as TeamView).seats).toMatchObject({ used: 2 });
  await f.billing.teams.drainLeaves();
  expect(f.billing.store.state.teamLeaves).toEqual([expect.objectContaining({ cloudId: cloud.id, email: "ada@qa.madani.test", doneAt: null, tries: 1 })]);
  f.setTime(f.now() + 60_000);
  await f.billing.teams.drainLeaves();
  expect(memberLeft).toHaveBeenCalledTimes(2);
  expect(f.billing.store.state.teamLeaves![0]!.doneAt).not.toBeNull();
  expect(await f.team("ada")).toBeNull();
  expect(f.billing.sessionFields(people.ada).teams).toEqual([]);
  expect((await f.call("ada", "POST", `/api/cloud/desktop/teams/${cloud.id}/pairing`, {})).status).toBe(404);
});

it("cancels and expires invites, and an invite never outlives its plan", async () => {
  const f = await fixture();
  expect((await f.call("owner", "POST", "/v1/team/invites", { email: "ada@qa.madani.test" })).status).toBe(404);
  await teamPlan(f);
  const id = ((await f.call("owner", "POST", "/v1/team/invites", { email: "ada@qa.madani.test" })).body.team as TeamView).invites[0]!.id;
  expect((await f.call("ada", "DELETE", `/v1/team/invites/${id}`)).status).toBe(404);
  expect(((await f.call("owner", "DELETE", `/v1/team/invites/${id}`)).body.team as TeamView).invites).toEqual([]);
  expect((await f.call("ada", "POST", "/v1/team/join", { token: f.tokenFor("ada@qa.madani.test") })).status).toBe(410);
  await f.call("owner", "POST", "/v1/team/invites", { email: "ada@qa.madani.test" });
  f.setTime(f.now() + INVITE_TTL_MS + 1);
  expect((await f.call("ada", "POST", "/v1/team/join", { token: f.tokenFor("ada@qa.madani.test") })).status).toBe(410);
});
