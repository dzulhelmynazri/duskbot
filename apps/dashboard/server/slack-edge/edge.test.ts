import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBilling } from "../billing/index.ts";
import { createDashboardApp } from "../app.ts";
import { memoryMailer } from "../auth/mail.ts";
import { createSlackApi } from "../../../../server/slack/api.ts";
import { createSlackHandover } from "../../../../server/slack/handover.ts";
import { startFakeSlack } from "../../../../server/testing/fake-slack.ts";

vi.mock("../billing/index.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../billing/index.ts")>();
  return { ...actual, createBilling: vi.fn(actual.createBilling) };
});
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });

async function fixture() {
  for (const key of ["MADANI_BILLING_PROVIDER", "MADANI_CLOUD_PROVIDER", "MADANI_POOL_DRIVER", "MADANI_CLOUD_SEAL_KEY", "MADANI_DODO_PRODUCTS", "MADANI_SLACK_EDGE"]) vi.stubEnv(key, undefined);
  const fake = await startFakeSlack();
  cleanup.push(() => fake.close());
  const api = createSlackApi({ env: { MADANI_SLACK_API_URL: fake.url }, minGapMs: 0 });
  const appId = (await api.call<{ app_id: string }>("apps.manifest.create", fake.config.access, { manifest: { settings: { socket_mode_enabled: true } } })).app_id;
  const appToken = fake.mintAppToken(appId);
  const dir = mkdtempSync(join(tmpdir(), "madani-slack-edge-")), desktopDir = mkdtempSync(join(tmpdir(), "madani-slack-desktop-"));
  cleanup.push(() => { rmSync(dir, { recursive: true, force: true }); rmSync(desktopDir, { recursive: true, force: true }); });
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture address.");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const app = createDashboardApp({ dataDir: dir, publicUrl: origin, mailer: memoryMailer(), staticDir: null,
    slackEdge: { env: { MADANI_SLACK_EDGE: "1", MADANI_SLACK_API_URL: fake.url, MADANI_CLOUD_SEAL_KEY: randomBytes(32).toString("base64url") } } });
  cleanup.push(() => app.close());
  server.on("request", app.handle);
  const billing = vi.mocked(createBilling).mock.results.at(-1)!.value as ReturnType<typeof createBilling>;
  const account = { id: "acct_edge_owner", email: "owner@example.test" };
  await billing.service.checkout(account, { kind: "cart", cart: { interval: "month", license: { kind: "none" }, desktop: { kind: "shared_s", region: "fsn1" } } });
  const checkout = (JSON.parse(readFileSync(join(dir, "billing.json"), "utf8")) as { checkouts: Array<{ providerSessionId: string }> }).checkouts[0]!;
  for (const delivery of billing.fake!.complete(checkout.providerSessionId!)) billing.service.handleWebhook(delivery.headers, delivery.body);
  for (let n = 0; n < 8; n++) await billing.clouds.reconcile();
  const cloud = billing.clouds.list(account.id)[0]!;
  expect(cloud.status).toBe("running");
  // the desktop's own dashboard link, as provisioning handed it to the machine
  const slot = billing.fakePool!.calls.find(call => call.method === "createSlot")!.input as { bootstrap: string };
  const link = (JSON.parse(slot.bootstrap) as { files: Array<{ path: string; content: string }> }).files.find(file => file.path.endsWith("dashboard-link.json"))!.content;
  writeFileSync(join(desktopDir, "dashboard-link.json"), link, { mode: 0o600 });
  const delivered: Array<{ botId: string; payload: Record<string, unknown> }> = [];
  const handover = createSlackHandover({ dataDir: desktopDir, env: { MADANI_CLOUD_ROLE: "home" }, syncMs: 3_600_000,
    bots: () => [{ botId: "bot_edge", appId, botUserId: "U0BOT", appToken }], deliver: async (botId, payload) => { delivered.push({ botId, payload }); } });
  cleanup.push(() => handover.stop());
  return { fake, appId, appToken, dir, origin, app, billing, account, cloud, handover, delivered, edge: app.slackEdge.edge };
}

it("holds a sleeping desktop's Slack connection, seals a DM to the desktop, wakes it and hands the DM back", async () => {
  const { fake, appId, appToken, dir, origin, billing, account, cloud, handover, delivered, edge } = await fixture();

  // nothing is shared until the owner turns it on: the first sync names no bots and sends no token
  handover.start();
  await vi.waitFor(() => expect(edge.view(cloud)).toMatchObject({ available: true, enabled: false, bots: 0 }));
  expect(edge.setEnabled(cloud, true)).toMatchObject({ enabled: true, state: "waiting" });
  await handover.sync();
  expect(edge.view(cloud)).toMatchObject({ enabled: true, state: "waiting", bots: 1 });
  expect(fake.socket.connections(appId)).toBe(0);

  await billing.clouds.power(account.id, cloud.id, "off");
  expect(cloud.status).toBe("stopped");
  edge.tick();
  await fake.socket.waitForConnection(appId);
  expect(edge.view(cloud).state).toBe("holding");

  const chatter = fake.socket.event(appId, { type: "message", channel_type: "channel", channel: "C0ROOM", user: "U0PERSON", text: "lunch at noon", ts: "100.1" });
  await fake.socket.waitForAck(chatter);
  const dm = fake.socket.event(appId, { type: "message", channel_type: "im", channel: "D0DM", user: "U0PERSON", text: "the secret plan for friday", ts: "100.2" }, { eventId: "Ev0DM" });
  expect((await fake.socket.waitForAck(dm)).ms).toBeLessThan(3000);
  await vi.waitFor(() => expect(cloud.status).toBe("running"));
  expect(cloud.wakeRequestedAt).toEqual(expect.any(Number));

  // at rest the service keeps ciphertext and type metadata only
  const stored = readFileSync(join(dir, "slack-edge.json"), "utf8");
  expect(stored).not.toContain("secret plan");
  expect(stored).not.toContain("lunch");
  expect(stored).not.toContain("U0PERSON");
  expect(stored).not.toContain(appToken);
  expect((JSON.parse(stored) as { events: unknown[] }).events).toHaveLength(1);
  // still held while the desktop boots, so a second message during the wake is not lost
  expect(edge.holding(cloud.id)).toBe(true);

  await handover.sync();
  expect(delivered).toEqual([{ botId: "bot_edge", payload: expect.objectContaining({ event: expect.objectContaining({ text: "the secret plan for friday", channel: "D0DM" }) }) }]);
  await vi.waitFor(() => expect(fake.socket.connections(appId)).toBe(0));
  expect(edge.view(cloud)).toMatchObject({ state: "waiting", buffered: 0 });
  const after = JSON.parse(readFileSync(join(dir, "slack-edge.json"), "utf8")) as { events: unknown[]; wakes: Array<{ kind: string; ms: number }> };
  expect(after.events).toEqual([]);
  expect(after.wakes).toEqual([{ kind: "shared_s", ms: expect.any(Number), at: expect.any(Number) }]);
  // one wake is not enough to print a number on a pricing card
  const catalog = await (await fetch(`${origin}/v1/billing/catalog`)).json() as Record<string, unknown>;
  expect(catalog.wake).toBeUndefined();
});

it("turning it off drops the tokens and holds nothing; signed routes refuse strangers", async () => {
  const { fake, appId, origin, billing, account, cloud, handover, edge } = await fixture();
  handover.start();
  await vi.waitFor(() => expect(edge.view(cloud).available).toBe(true));
  edge.setEnabled(cloud, true);
  await handover.sync();
  expect(edge.view(cloud).bots).toBe(1);
  expect(edge.setEnabled(cloud, false)).toMatchObject({ enabled: false, state: "off", bots: 0 });
  await billing.clouds.power(account.id, cloud.id, "off");
  edge.tick();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(fake.socket.connections(appId)).toBe(0);

  const unsigned = await fetch(`${origin}/v1/slack-edge/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1 }) });
  expect(unsigned.status).toBe(401);
  const signedOut = await fetch(`${origin}/v1/clouds/${cloud.id}/slack-wake`);
  expect(signedOut.status).toBe(401);
});
