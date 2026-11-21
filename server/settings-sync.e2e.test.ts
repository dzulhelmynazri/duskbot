// Settings follow the person between this computer, My Cloud and a server of their own, on real servers with main's
// own wiring (scripts/testing/cloud-send-fixture.ts): a second fixture's Cloud home stands in for the person's own
// server, reached the same way over the owner's session. A change in any one place reaches the others, the last change
// wins, what belongs to one computer stays there, keys travel only over the person's own links, the move to My Cloud and
// the way home keep them level, and a Team Cloud keeps none.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { localSettingsPlace, remoteSettingsPlace, syncSettings, type SettingsPlace } from "../electron/settings-sync.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const TEAM = { id: "team-settings", name: "Settings team" };

let fx: CloudSendFixture;
let vpsFx: CloudSendFixture;

beforeAll(async () => {
  [fx, vpsFx] = await Promise.all([
    launchCloudSendFixture({ onePasswordToken: `ops_fake-settings-${hex(8)}`, team: TEAM }),
    launchCloudSendFixture({ onePasswordToken: `ops_fake-settings-vps-${hex(8)}` }),
  ]);
}, hostTimeout(120_000));
afterAll(async () => { await Promise.all([fx?.close(), vpsFx?.close()]); });

const asCall = (side: CloudSendFixture["local"]) => async (method: string, route: string, body?: unknown) => {
  const answer = await side(method, route, body);
  return { ok: answer.status >= 200 && answer.status < 300, ...answer };
};
/** This computer as main reaches it: loopback, and the values of keys over the private port. */
const here = () => localSettingsPlace(async (route: string, init: RequestInit = {}) => {
  const answer = await fx.local(init.method ?? "GET", route, init.body ? JSON.parse(String(init.body)) : undefined);
  return new Response(answer.body === null || answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
}, (what: object) => fx.handoff(what as never));
const places = (): SettingsPlace[] => [
  { key: "local", kind: "local", label: "This computer", client: here() },
  { key: "cloud", kind: "cloud", label: "My Cloud", client: remoteSettingsPlace(asCall(fx.onCloud)) },
  { key: "server", kind: "server", label: "vps", client: remoteSettingsPlace(asCall(vpsFx.onCloud)) },
];
const level = async () => {
  const done = await syncSettings(places());
  expect(done.failed).toEqual([]);
  return done;
};

/** A place's own values, keys with them, as the person's own session there (this computer: its private port). */
const valuesAt = async (where: "local" | "cloud" | "vps", keys: string[]) => {
  if (where === "local") return (await fx.handoff({ kind: "settings", op: "values", keys } as never)).settings.values;
  const answer = await (where === "cloud" ? fx.onCloud : vpsFx.onCloud)("POST", "/api/settings-sync/values", { keys });
  expect(answer.status).toBe(200);
  return answer.body.values;
};
const everywhere = async (keys: string[]) => Promise.all((["local", "cloud", "vps"] as const).map((where) => valuesAt(where, keys)));
const save = async (side: CloudSendFixture["local"], patch: Record<string, unknown>) => {
  const answer = await side("PATCH", "/api/config", patch);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

it("a setting changed in any one place reaches the others, and the last change wins", async () => {
  const key = `sk-ant-fake-${hex(16)}`;
  await save(fx.local, { language: "fr", features: { showToolCalls: true }, tts: { provider: "system" }, anthropic: { key } });
  expect((await fx.local("PUT", "/api/settings-sync/ui", { name: "madani-skin", value: "midnight", at: Date.now() })).body.ok).toBe(true);
  const first = await level();
  expect(first.changed.length).toBeGreaterThan(0);
  const keys = ["language", "features.showToolCalls", "tts.provider", "anthropic.key", "ui.madani-skin"];
  for (const values of await everywhere(keys)) expect(values).toEqual({ language: "fr", "features.showToolCalls": true, "tts.provider": "system", "anthropic.key": key, "ui.madani-skin": "midnight" });
  expect((await fx.onCloud("GET", "/api/settings-sync/ui")).body.prefs["madani-skin"].value).toBe("midnight");
  expect((await level()).changed, "level now: another pass changes nothing").toEqual([]);

  // changed on the person's server, then later on My Cloud: My Cloud's wins everywhere, the server's other change too
  await save(vpsFx.onCloud, { language: "de", talkingStyle: "casual" });
  await tick();
  await save(fx.onCloud, { language: "ja" });
  await level();
  for (const values of await everywhere(["language", "talkingStyle"])) expect(values).toEqual({ language: "ja", talkingStyle: "casual" });

  // a page's preference changed on My Cloud reaches this computer's page
  expect((await fx.onCloud("PUT", "/api/settings-sync/ui", { name: "madani-send-key", value: "mod-enter", at: Date.now() })).body.ok).toBe(true);
  await level();
  expect((await fx.local("GET", "/api/settings-sync/ui")).body.prefs["madani-send-key"].value).toBe("mod-enter");
  // an older change from a page is refused, and the newer one kept
  expect((await fx.local("PUT", "/api/settings-sync/ui", { name: "madani-send-key", value: "enter", at: 1 })).body.ok).toBe(false);
}, hostTimeout(180_000));

it("what belongs to one computer stays there", async () => {
  await save(fx.local, { computerName: "Studio Mac", anthropic: { url: "http://127.0.0.1:8317" } });
  await save(vpsFx.onCloud, { anthropic: { url: "https://gateway.example.test" } });
  await level();
  const listing = (await fx.local("GET", "/api/settings-sync")).body;
  expect(listing.settings.computerName).toBeUndefined();
  expect(listing.settings["anthropic.url"], "an address only this computer reaches is not offered").toBeUndefined();
  expect((await valuesAt("cloud", ["anthropic.url"]))["anthropic.url"]).toBe("https://gateway.example.test");
  expect((await fx.handoff({ kind: "settings", op: "values", keys: ["anthropic.url"] } as never)).settings.values).toEqual({});
  const config = (await fx.onCloud("GET", "/api/config")).body;
  expect(config.computerName ?? "").not.toBe("Studio Mac");
}, hostTimeout(90_000));

it("keys travel only over the person's own links, and a Team Cloud keeps no person's settings", async () => {
  const key = `sk-or-fake-${hex(16)}`;
  await save(fx.local, { openrouter: { key } });
  await level();
  expect((await valuesAt("vps", ["openrouter.key"]))["openrouter.key"]).toBe(key);
  // this computer's loopback answers no key: those go over its private port only
  expect((await fx.local("POST", "/api/settings-sync/values", { keys: ["openrouter.key", "language"] })).body.values).toEqual({ language: "ja" });
  // nobody's session: nothing at all
  const anonymous = await fetch(`${fx.cloudBase}/api/settings-sync`, { headers: { ...fx.edge } });
  expect([401, 403]).toContain(anonymous.status);
  const anonymousValues = await fetch(`${fx.cloudBase}/api/settings-sync/values`, { method: "POST", headers: { ...fx.edge, "content-type": "application/json" }, body: JSON.stringify({ keys: ["openrouter.key"] }) });
  expect([401, 403]).toContain(anonymousValues.status);
  expect(await anonymousValues.text()).not.toContain(key);
  // a Team Cloud: the person's settings are not kept there, by anyone
  const admin = await fx.team!.pair({ email: "person@example.test", role: "owner" } as never);
  expect(admin.token).toBeTruthy();
  expect((await fx.team!.as(admin.token!, "GET", "/api/settings-sync")).status).toBe(404);
  expect((await fx.team!.as(admin.token!, "PUT", "/api/settings-sync/values", { key: "language", value: "fr", at: Date.now() })).status).toBe(404);
  // listings carry digests, never a key, and no key reached a log
  expect(JSON.stringify((await fx.onCloud("GET", "/api/settings-sync")).body)).not.toContain(key);
  for (const logs of [fx.logs(), vpsFx.logs()]) expect(logs).not.toMatch(/sk-(ant|or)-fake-/u);
}, hostTimeout(90_000));

it("the move to My Cloud and the way home keep settings level", async () => {
  const moved = await fx.move({ final: true });
  expect(moved.result).toBeTruthy();
  await save(fx.onCloud, { language: "it", features: { llmThreadTitles: true } });
  // the way home: what changed on My Cloud comes back first (settings-sync-main.mjs's bringHome)
  const home = await syncSettings([places()[0]!, places()[1]!]);
  expect(home.failed).toEqual([]);
  expect(await valuesAt("local", ["language", "features.llmThreadTitles"])).toEqual({ language: "it", "features.llmThreadTitles": true });
  // and back out again from this computer
  await tick();
  await save(fx.local, { language: "es" });
  await level();
  for (const values of await everywhere(["language"])) expect(values).toEqual({ language: "es" });
}, hostTimeout(240_000));
