import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { jsonFile } from "./desktop-prefs.mjs";
import { createVpsLink } from "./vps-link.mjs";
import { seal, sealKeyOf, x25519Pair } from "./vps-link-protocol.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const savedLink = (id) => ({ id, name: id, mode: "relay", origin: `http://vps-${id}.localhost:1`, envId: id, keyP: "p:key", tokenP: "p:token", port: 1 });

function controller(links, overrides = {}) {
  let value = { v: 1, current: links[0]?.id ?? null, links };
  const calls = [];
  const link = createVpsLink({
    base: "https://link.example.test", fetch: async () => assert.fail("no link service"),
    serverFetch: async (url) => {
      calls.push(url);
      return Response.json(String(url).endsWith("/api/auth/session") ? { kind: "session" } : { instances: [{ instanceId: "codex", driverKind: "codex" }] });
    },
    store: { read: () => value, write: (next) => { value = next; } },
    protect: async (text) => `p:${text}`, unprotect: async (text) => text.slice(2), label: () => "Mac",
    saveServer: () => "env-9", forgetServer: () => {}, switchTo: () => {},
    ownHome: { start: async () => {}, view: () => null, away: () => false, home: () => null, chosen: () => null }, ownHomeReset: () => {},
    localRequest: async () => Response.json({}),
    backups: { save: async () => ({ file: "", bytes: 0 }), open: async () => assert.fail("no backup") },
    localCredentials: { codexAuth: async () => "{}", claudeCli: async () => null, claudeToken: async () => "" },
    relaunch: () => {},
    ...overrides,
  });
  return { link, calls };
}

test("startup and settings share one ready tunnel while saved tunnels start independently", async () => {
  const unlocked = deferred();
  const ready = new Map(["aaaaaaaaaa", "bbbbbbbbbb"].map((id) => [id, deferred()]));
  const created = [], closed = [], retargeted = [];
  const { link, calls } = controller([...ready.keys()].map(savedLink), {
    unprotect: async (text) => { await unlocked.promise; return text.slice(2); },
    retarget: (from, to) => retargeted.push([from, to]),
    proxyFactory: ({ id }) => {
      created.push(id);
      return { start: () => ready.get(id).promise, control: async () => ({}), close: async () => { closed.push(id); } };
    },
  });
  const resumed = link.resume();
  const again = link.resume();
  const engines = link.engines();
  unlocked.resolve();
  await tick();
  assert.deepEqual(created.sort(), ["aaaaaaaaaa", "bbbbbbbbbb"]);
  assert.deepEqual(calls, [], "settings must wait for the listener before fetching the server");
  ready.get("aaaaaaaaaa").resolve("http://vps-aaaaaaaaaa.localhost:23");
  assert.equal((await engines)[0].kind, "codex", "a second saved server cannot block the selected server");
  assert.ok(calls.every((url) => url.startsWith("http://vps-aaaaaaaaaa.localhost:23/")), "requests use the ready listener's new origin");
  ready.get("bbbbbbbbbb").resolve("http://vps-bbbbbbbbbb.localhost:24");
  await Promise.all([resumed, again]);
  assert.equal(retargeted.length, 2);
  await link.close();
  assert.deepEqual(closed.sort(), ["aaaaaaaaaa", "bbbbbbbbbb"]);
});

test("failed tunnel startup is closed and a later settings request can retry", async () => {
  let attempt = 0, closed = 0;
  const { link } = controller([savedLink("aaaaaaaaaa")], {
    proxyFactory: () => ({
      start: async () => { if (++attempt === 1) throw new Error("listener failed"); return "http://vps-aaaaaaaaaa.localhost:25"; },
      control: async () => ({}), close: async () => { closed += 1; },
    }),
  });
  await link.resume();
  assert.ok(closed >= 1);
  assert.equal((await link.engines())[0].kind, "codex");
  assert.equal(attempt, 2);
  await link.close();
});

test("concurrent settings requests share re-pairing and sign-in checks the session only once", async () => {
  const session = deferred();
  let checks = 0, pairs = 0;
  const { link } = controller([savedLink("aaaaaaaaaa")], {
    serverFetch: async (url) => {
      if (String(url).endsWith("/api/auth/session")) { checks += 1; await session.promise; return Response.json({ kind: "none" }); }
      if (String(url).endsWith("/api/auth/pair")) { pairs += 1; return Response.json({}); }
      return Response.json({ instances: [{ instanceId: "codex", driverKind: "codex" }] });
    },
    proxyFactory: () => ({ start: async () => "http://vps-aaaaaaaaaa.localhost:25", control: async () => ({ code: "TEST-CODE" }), close: async () => {} }),
  });
  const settings = link.engines();
  const signIn = link.signIn("codex");
  await tick();
  assert.equal(checks, 1);
  session.resolve();
  await settings;
  assert.equal((await signIn).phase, "succeeded");
  assert.equal(checks, 1);
  assert.equal(pairs, 1);
  await link.close();
});

function setupController({ watchFirst, serverFetch } = {}) {
  const saved = [], closed = [];
  let count = 0, result;
  const firstId = "aaaaaaaaaa";
  const { link } = controller([], {
    fetch: async (url, init) => {
      if (init.method === "POST") {
        const id = ++count === 1 ? firstId : "bbbbbbbbbb";
        const { appPub } = JSON.parse(init.body);
        const pair = x25519Pair();
        result = { state: "linked", vpsPub: pair.pub, sealed: seal(sealKeyOf(pair.priv, pair.pub, appPub, id), id, Buffer.from(JSON.stringify({
          v: 1, mode: "relay", name: "Fixture VPS", pairing: { code: "TEST-CODE" }, tunnel: { id, key: "fixture-key", token: "fixture-token" },
        }))) };
        return Response.json({ id, watch: "fixture-watch", base: "https://link.example.test", expiresAt: Date.now() + 60000 });
      }
      if (init.method === "DELETE") return new Promise(() => {});
      if (String(url).includes(firstId)) return watchFirst ? watchFirst(result) : Response.json(result);
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    },
    serverFetch: serverFetch ?? (async () => Response.json({})),
    saveServer: (server) => { saved.push(server); return "env-fixture"; },
    proxyFactory: ({ id }) => ({ start: async () => `http://vps-${id}.localhost:25`, control: async () => ({ code: "TEST-CODE" }), close: async () => { closed.push(id); } }),
  });
  return { link, saved, closed };
}

test("regenerating a command does not wait for relay deletion or accept the cancelled watch's late result", { timeout: 2000 }, async () => {
  const watched = deferred();
  const late = deferred();
  const { link, saved } = setupController({ watchFirst: (result) => { watched.resolve(result); return late.promise; } });
  await link.start();
  const result = await watched.promise;
  const replacement = await link.start();
  assert.match(replacement.command, /bbbbbbbbbb-/);
  late.resolve(Response.json(result));
  await tick();
  await tick();
  assert.equal(link.view().stage, "command");
  assert.match(link.view().command, /bbbbbbbbbb-/);
  assert.deepEqual(saved, []);
  await link.close();
});

test("cancelling during pairing cannot save a server or replace a newer setup", { timeout: 2000 }, async () => {
  const pairing = deferred();
  const paired = deferred();
  const { link, saved, closed } = setupController({ serverFetch: async () => { pairing.resolve(); return paired.promise; } });
  await link.start();
  await pairing.promise;
  await link.start();
  paired.resolve(Response.json({ environment: {} }));
  await tick();
  await tick();
  assert.equal(link.view().stage, "command");
  assert.match(link.view().command, /bbbbbbbbbb-/);
  assert.deepEqual(saved, []);
  assert.ok(closed.includes("aaaaaaaaaa"));
  await link.close();
});

test("failed pairing leaves no saved link and closes its temporary listener", { timeout: 2000 }, async () => {
  const { link, saved, closed } = setupController({ serverFetch: async () => Response.json({ error: "Pairing was refused." }, { status: 401 }) });
  await link.start();
  for (let tries = 0; tries < 20 && link.view().stage !== "error"; tries += 1) await tick();
  assert.equal(link.view().stage, "error");
  assert.equal(link.view().server, null);
  assert.deepEqual(saved, []);
  assert.ok(closed.includes("aaaaaaaaaa"));
  await link.close();
});

function creatingController(extra = {}) {
  const creates = [], deleted = [];
  const { link } = controller([], {
    fetch: async (url, init) => {
      // an older link service with no short codes (ed3ec2acf); the setup keeps its long line
      if (String(url).endsWith("/short")) return Response.json({ error: "not found" }, { status: 404 });
      if (init.method === "POST") {
        const made = deferred();
        creates.push(made);
        return Response.json(await made.promise);
      }
      if (init.method === "DELETE") { deleted.push(String(url)); return Response.json({}); }
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    },
    ...extra,
  });
  const made = (id) => ({ id, watch: "fixture-watch", base: "https://link.example.test", expiresAt: Date.now() + 60000 });
  return { link, creates, deleted, made };
}

for (const action of ["cancel", "close"]) {
  test(`${action} while creating a command revokes the unused result without resurrecting setup`, { timeout: 2000 }, async () => {
    const { link, creates, deleted, made } = creatingController();
    const starting = link.start();
    await tick();
    assert.equal(creates.length, 1);
    await link[action]();
    creates[0].resolve(made("aaaaaaaaaa"));
    await starting;
    await tick();
    assert.equal(link.view().stage, "idle");
    assert.equal(link.view().command, null);
    assert.equal(deleted.length, 1);
    assert.match(deleted[0], /aaaaaaaaaa$/);
    await link.close();
  });
}

test("simultaneous command starts retain the newest result and revoke the older result", { timeout: 2000 }, async () => {
  const { link, creates, deleted, made } = creatingController();
  const older = link.start();
  const newer = link.start();
  await tick();
  creates[1].resolve(made("bbbbbbbbbb"));
  await newer;
  creates[0].resolve(made("aaaaaaaaaa"));
  await older;
  await tick();
  assert.match(link.view().command, /bbbbbbbbbb-/);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /aaaaaaaaaa$/);
  await link.close();
});

test("cancelling while protecting a command revokes the created session", { timeout: 2000 }, async () => {
  const protection = deferred();
  const { link, creates, deleted, made } = creatingController({ protect: async (text) => { await protection.promise; return `p:${text}`; } });
  const starting = link.start();
  await tick();
  creates[0].resolve(made("aaaaaaaaaa"));
  await tick();
  await link.cancel();
  protection.resolve();
  await starting;
  await tick();
  assert.equal(link.view().stage, "idle");
  assert.equal(deleted.length, 1);
  await link.close();
});

test("startup waits only for its selected saved server and refuses an unknown environment", async () => {
  const selected = deferred();
  const { link, calls } = controller([savedLink("aaaaaaaaaa"), savedLink("bbbbbbbbbb")], {
    proxyFactory: ({ id }) => ({ start: () => id === "aaaaaaaaaa" ? selected.promise : new Promise(() => {}), close: async () => {} }),
  });
  assert.equal(await link.readyServer("not-saved"), null);
  const waiting = link.readyServer("aaaaaaaaaa");
  selected.resolve("http://vps-aaaaaaaaaa.localhost:26");
  assert.deepEqual(await waiting, { id: "aaaaaaaaaa", origin: "http://vps-aaaaaaaaaa.localhost:26" });
  assert.deepEqual(calls, [], "listener readiness must not probe engines or wait for a model CLI");
  await link.close();
});

test("a damaged saved-links file is kept aside before the first save can write over it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "madani-vps-link-"));
  try {
    const file = path.join(dir, "vps-link.json");
    const damaged = '{"v":1,"current":"aaaaaaaaaa","links":[{"id":"aaaaaaaaaa","keyP":"p:k';
    writeFileSync(file, damaged);
    const store = jsonFile(file);
    const logged = [];
    const { link } = controller([], { store: { ...store, setAside: () => store.setAside(7) }, log: (line) => logged.push(line) });
    assert.deepEqual(readdirSync(dir), ["vps-link.json.unreadable-7"]);
    assert.equal(readFileSync(path.join(dir, "vps-link.json.unreadable-7"), "utf8"), damaged);
    assert.match(logged.join("\n"), /kept them as .*unreadable-7/);
    await link.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
