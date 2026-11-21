import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { savedVpsStartupTarget, startPackagedAlongsideVps, waitForLocalStartup } from "./saved-vps-startup.mjs";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const active = { id: "saved-vps", kind: "remote", origin: "http://vps-aaaaaaaaaa.localhost:29000" };
const link = { stage: "moved", mode: "relay", server: { id: active.id, origin: active.origin } };
const eligible = { packaged: true, hidden: false, remoteAccess: null, priority: false, cloudHome: false, rememberedPlace: null, active, link };

function startupFixture(overrides = {}) {
  const local = deferred();
  const ready = deferred();
  const events = [];
  const from = main.indexOf('  } else if (app.isPackaged) {\n    const target = () =>');
  const to = main.indexOf('\n  if (desktopShutdownStarted) return;', from);
  assert.ok(from > 0 && to > from);
  const source = main.slice(from, to).replace('  } else if (app.isPackaged) {', 'if (app.isPackaged) {');
  const context = {
    app: { isPackaged: true, quit: () => events.push("quit") },
    cleanWorkspace: { marker: () => ({ frozen: false }) },
    hiddenStart: false, desktopRemoteAccess: null, desktopShutdownStarted: false,
    pendingOrganizationEntry: false, pendingPackageInstallUrl: null, pendingChatLink: null,
    cloudEntry: { pending: () => false }, secureCredentialState: { read: () => ({}) }, secureCredentials: {},
    organizationRestartIntent: () => false, ownHome: { underWay: () => null }, oneHome: { away: () => false },
    homePlaces: { remembered: () => null }, environmentsState: {}, activeRemote: () => active,
    vpsLink: { view: () => link, readyServer: id => { events.push(`proxy:${id}`); return ready.promise; } },
    savedVpsStartupTarget, startPackagedAlongsideVps,
    startServerPackaged: () => { events.push("local-start"); return local.promise; },
    bootDataDir: "/fixture/data", desktopDataDir: () => "/fixture/data", localRuntimeStarting: null,
    mainWindow: null, earlyVpsOpened: null, serverReady: false, startupTrace: { mark: () => {} },
    createWindow: () => { events.push("window"); context.mainWindow = { isDestroyed: () => false }; },
    navigateMainWindow: async origin => { events.push(`navigate:${origin}`); return true; },
    slog: text => events.push(`log:${text}`),
    ...overrides,
  };
  const finished = runInNewContext(`(async () => { ${source} })()`, context);
  return { local, ready, events, context, finished };
}

test("only a matching saved linked VPS can open ahead of this computer", () => {
  assert.deepEqual(savedVpsStartupTarget(eligible), { id: active.id, origin: active.origin });
  assert.ok(savedVpsStartupTarget({ ...eligible, link: { ...link, mode: "direct" } }));
  for (const patch of [
    { packaged: false }, { hidden: true }, { remoteAccess: {} }, { priority: true }, { cloudHome: true }, { rememberedPlace: {} },
    { active: null }, { active: { ...active, kind: "local" } }, { active: { ...active, team: {} } },
    { active: { ...active, cloud: {} } }, { active: { ...active, home: true } },
    { link: null }, { link: { ...link, stage: "moving" } }, { link: { ...link, stage: "command" } },
    { link: { ...link, mode: "unknown" } }, { link: { ...link, server: { id: "other", origin: active.origin } } },
    { link: { ...link, server: { id: active.id, origin: "https://arbitrary.example" } } },
  ]) assert.equal(savedVpsStartupTarget({ ...eligible, ...patch }), null, JSON.stringify(patch));
});

test("the actual packaged startup branch opens the ready VPS while local boot is still held", async () => {
  const fixture = startupFixture();
  let finished = false;
  void fixture.finished.then(() => { finished = true; });
  await tick();
  assert.ok(fixture.events.includes("local-start"));
  assert.ok(!fixture.events.includes("window"), "the selected proxy must be ready before navigation");
  fixture.ready.resolve({ id: active.id, origin: active.origin });
  await tick();
  assert.ok(fixture.events.includes(`navigate:${active.origin}`));
  assert.equal(fixture.context.earlyVpsOpened, active.id);
  assert.equal(finished, false, "the remote window must not depend on local HTTP/CLI readiness");
  fixture.local.resolve(true);
  await fixture.finished;
  assert.equal(fixture.context.localRuntimeStarting, null);
  const permission = main.indexOf("session.defaultSession.setPermissionCheckHandler(appPermissions.check)", main.indexOf("app.whenReady().then"));
  const packaged = main.indexOf("const startup = startPackagedAlongsideVps", permission);
  assert.ok(permission > 0 && packaged > permission, "permission guards are installed before an early remote window");
});

test("local boot failure leaves an opened saved VPS usable and records the failure", async () => {
  const fixture = startupFixture();
  fixture.ready.resolve({ id: active.id, origin: active.origin });
  await tick();
  fixture.local.reject(new Error("fixture local startup failed"));
  await fixture.finished;
  assert.deepEqual(fixture.events.filter(event => event.startsWith("navigate:")), [`navigate:${active.origin}`]);
  assert.ok(fixture.events.some(event => event.includes("local background server did not start: fixture local startup failed")));
  assert.ok(!fixture.events.includes("quit"));
});

test("a queued organization action takes precedence over saved VPS startup", async () => {
  const fixture = startupFixture({ pendingOrganizationEntry: true });
  await tick();
  assert.deepEqual(fixture.events, ["local-start"]);
  fixture.local.resolve(true);
  await fixture.finished;
});

test("a VPS response arriving after local startup cannot replace its delivered launch action", async () => {
  const fixture = startupFixture();
  fixture.local.resolve(true);
  await fixture.finished;
  fixture.ready.resolve({ id: active.id, origin: active.origin });
  await tick();
  assert.ok(!fixture.events.includes("window"));
});

test("a new deep link or workspace selection during proxy startup cancels early navigation", async () => {
  let selected = { id: active.id, origin: active.origin };
  const ready = deferred(), local = deferred();
  const calls = [];
  const startup = startPackagedAlongsideVps({ startLocal: () => local.promise, target: () => selected,
    ready: () => ready.promise, open: destination => calls.push(destination) });
  selected = null;
  ready.resolve({ id: active.id, origin: active.origin });
  assert.equal(await startup.remote, false);
  assert.deepEqual(calls, []);
  local.resolve(true);
  await startup.local;
});

test("local IPC waits the same startup and times out without cancelling its server", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const local = deferred();
  const waiting = waitForLocalStartup(local.promise, 100);
  const timedOut = assert.rejects(waiting, /still starting/);
  t.mock.timers.tick(100);
  await timedOut;
  const retry = waitForLocalStartup(local.promise, 100);
  local.resolve(true);
  await retry;
});

test("the actual local IPC bridge shares pending boot and gives a clear failure after unsuccessful boot", async () => {
  const from = main.indexOf("const localServerRequest = async");
  // the function ends at its own closing brace, whatever main.mjs declares after it
  const to = main.indexOf("\n};", from) + 3;
  const source = main.slice(from, to);
  assert.ok(from > 0 && to > from);
  const startup = deferred(), fetched = [];
  const context = { localRuntimeStarting: startup.promise, serverReady: false, serverProc: null,
    app: { isPackaged: true }, waitForLocalStartup, SERVER_PORT: 29001, desktopMutationToken: "fixture-only-token",
    DESKTOP_MUTATION_HEADER: "x-fixture-owner", fetch: async (url, init) => { fetched.push({ url, init }); return Response.json({ ok: true }); } };
  runInNewContext(`${source}\nglobalThis.requestLocal = localServerRequest;`, context);
  const requested = context.requestLocal("/api/workspace-backup/status");
  await tick();
  assert.deepEqual(fetched, []);
  context.serverReady = true; context.serverProc = {};
  startup.resolve(true);
  assert.equal((await requested).ok, true);
  assert.equal(fetched[0].url, "http://127.0.0.1:29001/api/workspace-backup/status");
  assert.equal(fetched[0].init.headers["x-fixture-owner"], "fixture-only-token");
  context.serverReady = false; context.serverProc = null; context.localRuntimeStarting = Promise.resolve(false);
  await assert.rejects(context.requestLocal("/api/workspace-backup/status"), /background server is unavailable/);
  context.localRuntimeStarting = Promise.reject(new Error("fixture startup failure"));
  await assert.rejects(context.requestLocal("/api/workspace-backup/status"), /background server is unavailable/);
});

test("an early window trusts only the confirmed local port on each new navigation", () => {
  const oldOrigin = "http://127.0.0.1:8799", actualOrigin = "http://127.0.0.1:18799";
  const from = main.indexOf("function rendererOrigin() {");
  const to = main.indexOf("\nfunction respondToDisplayMediaRequest", from);
  const context = { app: { isPackaged: true }, serverReady: false, SERVER_PORT: 8799,
    desktopRemoteAccess: null, DEV_URL: "http://localhost:5173", URL,
    ipcMain: { on: (_channel, handler) => { context.originHandler = handler; } } };
  runInNewContext(main.slice(from, to), context);
  function bridge(origin, unavailable = false) {
    let result;
    runInNewContext(preload, { process: { platform: "fixture", argv: [
      `--madani-local-origin=${oldOrigin}`, "--madani-current-local-origin=1", "--madani-company-desktop=1",
    ] }, location: { origin }, navigator: {}, TextEncoder,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_key, value) => { result = value; } },
      ipcRenderer: { on() {}, removeListener() {}, invoke: async () => {}, sendSync: channel => {
        if (channel !== "desktop:local-origin") return false;
        if (unavailable) throw new Error("fixture unavailable");
        const event = {}; context.originHandler(event); return event.returnValue;
      } } }) });
    return result;
  }
  assert.equal(bridge(oldOrigin).app.ownPage, false, "an occupied guessed port is untrusted before child identity is verified");
  assert.equal(bridge(oldOrigin).cloudAccount, undefined);
  context.SERVER_PORT = 18799; context.serverReady = true;
  assert.equal(bridge(actualOrigin).app.ownPage, true);
  assert.ok(bridge(actualOrigin).cloudAccount);
  assert.equal(bridge(oldOrigin).app.ownPage, false);
  assert.equal(bridge(actualOrigin, true).app.ownPage, false, "origin IPC failure must not use the stale argument");
  context.app.isPackaged = false; context.serverReady = false;
  assert.equal(bridge(context.DEV_URL).app.ownPage, true, "the separate dev renderer retains its origin");
});
