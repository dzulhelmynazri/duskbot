import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { connectMcp, eventually, httpFixture, socket } from "./testing/bot-desktop-fixture.mjs";

const run = promisify(execFile);
const image = process.env.MADANI_VERIFY_DESKTOP_IMAGE;
assert.ok(image, "select a fixture image with MADANI_VERIFY_DESKTOP_IMAGE");
const imageId = (await run("docker", ["image", "inspect", image, "--format", "{{.Id}}"])).stdout.trim();
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const evidence = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "madani-primary-"));
process.env.MADANI_DATA_DIR = join(evidence, "server-data");
const { boxChromeExecArgs, boxChromeRelay } = await import("../server/vps-local.ts");
const suffix = `${process.pid}-${Date.now()}`;
const volume = `madani-primary-home-${suffix}`;
const names = new Set();
const receipt = { imageId, evidence, volume, cases: [], ok: false };
const docker = args => run("docker", args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
let madeVolume = false;

async function create(label, browser = true) {
  const name = `madani-primary-${suffix}-${label}`;
  names.add(name);
  const result = await docker([
    "run", "-d", "--name", name, "--label", "bot.madani.verification=primary-lifecycle",
    "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--memory", "4g", "--cpus", "2", "--pids-limit", "4096", "--shm-size", "512m",
    "--mount", `type=volume,source=${volume},target=/home/cua`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--tmpfs", "/run:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0755",
    "-e", "MADANI_START_URL=about:blank", "-e", `MADANI_BROWSER_AT_START=${browser ? "on" : "off"}`, imageId,
  ]);
  const container = result.stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  return { name, container };
}

async function stop(fixture) {
  const at = performance.now();
  await docker(["stop", "--timeout", "10", fixture.name]);
  const elapsedMs = Math.round(performance.now() - at);
  const state = JSON.parse((await docker(["inspect", fixture.name, "--format", "{{json .State}}"])).stdout);
  assert.equal(state.Running, false);
  assert.notEqual(state.ExitCode, 137, "shutdown reached Docker's forced-kill deadline");
  assert.ok(elapsedMs < 8_000, "primary shutdown exceeded its browser-save bound");
  return { elapsedMs, exitCode: state.ExitCode };
}

async function browser(fixture, work, waitForSession = true) {
  if (waitForSession) await eventually(() => docker(["exec", "-u", "1000:1000", fixture.container, "python3", "-I", "-c",
    "import urllib.request; urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:9222/json/version',timeout=1).close()"]),
  () => true, "the primary session did not start Chromium");
  const relay = await boxChromeRelay(() => spawn("docker", boxChromeExecArgs(fixture.container), { stdio: ["pipe", "pipe", "ignore"] }));
  let client;
  const pending = new Map();
  try {
    const config = await eventually(() => fetch(`${relay.url}/json/version`, { signal: AbortSignal.timeout(2_000) }).then(response => response.json()), value => Boolean(value.webSocketDebuggerUrl), "primary CDP did not start");
    const address = new URL(config.webSocketDebuggerUrl);
    address.host = new URL(relay.url).host;
    client = new WebSocket(address);
    await once(client, "open", { signal: AbortSignal.timeout(5_000) });
    let nextId = 0;
    client.on("message", raw => {
      const message = JSON.parse(raw);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 5_000);
      pending.set(id, { resolve, reject, timer });
      client.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    return await work(send);
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    client?.terminate();
    relay.close();
  }
}

async function fixtureServer(fixture) {
  await docker(["exec", "-d", "-u", "1000:1000", fixture.container, "python3", "-I", "-c", httpFixture]);
}

async function navigate(send, url) {
  const target = await send("Target.createTarget", { url });
  return (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
}

try {
  await docker(["volume", "create", "--label", "bot.madani.verification=primary-lifecycle", volume]);
  madeVolume = true;
  const fixture = await create("cookie");
  await fixtureServer(fixture);
  await browser(fixture, async send => {
    await navigate(send, "http://127.0.0.1:8765/cookie?value=primary");
    const cookie = await eventually(async () => (await send("Storage.getCookies")).cookies.find(value => value.name === "FixtureScreen"), Boolean, "persistent fixture cookie was not set");
    assert.equal(cookie.value, "primary");
    assert.ok(cookie.expires > Date.now() / 1000 + 3_000);
  });
  const stopped = await stop(fixture);
  assert.equal(stopped.exitCode, 0);
  assert.match((await docker(["logs", fixture.name])).stdout, /"browserClosed":true/);
  await docker(["start", fixture.name]);
  await fixtureServer(fixture);
  await browser(fixture, async send => {
    assert.ok((await send("Storage.getCookies")).cookies.some(cookie => cookie.name === "FixtureScreen" && cookie.value === "primary"));
    const session = await navigate(send, "http://127.0.0.1:8765/observe?screen=primary");
    await eventually(async () => (await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }, session)).result.value,
      value => value?.includes("FixtureScreen=primary"), "the restored cookie was not sent to the fixture site");
  });
  receipt.cases.push({ case: "persistent HTTP cookie survives Docker stop/start", ...stopped });
  await browser(fixture, send => send("Browser.close"));
  await eventually(() => docker(["exec", "-u", "1000:1000", fixture.container, "python3", "-I", "-c",
    "import socket; s=socket.socket(); s.settimeout(1); assert s.connect_ex(('127.0.0.1',9222)) != 0"]),
  () => true, "the primary browser did not close");
  await browser(fixture, async send => {
    await navigate(send, "http://127.0.0.1:8765/cookie?value=reopened");
    await eventually(async () => (await send("Storage.getCookies")).cookies.some(cookie => cookie.name === "FixtureScreen" && cookie.value === "reopened"),
      Boolean, "the relay-reopened browser did not set its cookie");
  }, false);
  const ownership = JSON.parse((await docker(["exec", "-u", "1000:1000", fixture.container, "python3", "-I", "-c", `import json
from pathlib import Path
state=json.loads(Path('/run/user/1000/omb-primary/browser.json').read_text())
for key in ('parent','browser'):
 entry=state[key]; fields=(Path('/proc')/str(entry['pid'])/'stat').read_text().rsplit(')',1)[1].split()
 assert entry == dict(pid=entry['pid'],start=fields[19],group=int(fields[2]),session=int(fields[3]))
assert state['browser']['pid']==state['browser']['group']==state['browser']['session']
assert b'/usr/local/bin/omb-session' in (Path('/proc')/str(state['parent']['pid'])/'cmdline').read_bytes().split(b'\\0')
print(json.dumps(state))`])).stdout);
  const reopened = await stop(fixture);
  assert.equal(reopened.exitCode, 0);
  assert.equal((await docker(["logs", fixture.name])).stdout.match(/"browserClosed":true/g)?.length, 2);
  await docker(["start", fixture.name]);
  await browser(fixture, async send => {
    assert.ok((await send("Storage.getCookies")).cookies.some(cookie => cookie.name === "FixtureScreen" && cookie.value === "reopened"));
  });
  receipt.cases.push({ case: "relay-reopened browser cookie survives Docker stop/start", ...reopened, ownership });
  await stop(fixture);
  await docker(["rm", fixture.name]);
  names.delete(fixture.name);

  const idle = await create("no-browser", false);
  await eventually(() => docker(["exec", "-u", "1000:1000", idle.container, "python3", "-I", "-c", `from pathlib import Path; assert Path(${JSON.stringify(socket)}).is_socket()`]), () => true, "primary CUA did not start without Chromium");
  const native = await connectMcp(idle.container);
  try {
    const state = await native.call("get_desktop_state", { screenshot_out_file: "/tmp/lazy-desktop.png" });
    assert.equal(state.platform, "linux");
    assert.ok(!state.windows.some(window => /chromium/i.test(window.app_name)), "Chromium opened before a browser request");
  } finally { await native.close(); }
  await new Promise(resolve => setTimeout(resolve, 700));
  await docker(["exec", "-u", "1000:1000", idle.container, "python3", "-I", "-c", "import socket; s=socket.socket(); s.settimeout(1); assert s.connect_ex(('127.0.0.1',9222)) != 0"]);
  await fixtureServer(idle);
  await browser(idle, async send => {
    await navigate(send, "http://127.0.0.1:8765/cookie?value=lazy-primary");
    await eventually(async () => (await send("Storage.getCookies")).cookies.some(cookie => cookie.name === "FixtureScreen" && cookie.value === "lazy-primary"), Boolean, "on-demand browser did not set its persistent cookie");
  }, false);
  const lazyStopped = await stop(idle);
  await docker(["start", idle.name]);
  await eventually(() => docker(["exec", "-u", "1000:1000", idle.container, "python3", "-I", "-c", `from pathlib import Path; assert Path(${JSON.stringify(socket)}).is_socket()`]), () => true, "restarted CUA did not become ready");
  await browser(idle, async send => {
    assert.ok((await send("Storage.getCookies")).cookies.some(cookie => cookie.name === "FixtureScreen" && cookie.value === "lazy-primary"));
  }, false);
  receipt.cases.push({ case: "desktop wakes without Chromium and on-demand browser preserves its profile across restart", ...lazyStopped });
  await stop(idle);
  await docker(["rm", idle.name]);
  names.delete(idle.name);

  const early = await create("early");
  receipt.cases.push({ case: "primary stops during startup", ...await stop(early) });
  await docker(["start", early.name]);
  await browser(early, async send => {
    assert.ok((await send("Storage.getCookies")).cookies.some(cookie => cookie.name === "FixtureScreen" && cookie.value === "lazy-primary"));
  });
  receipt.ok = true;
} catch (error) {
  receipt.error = error.message;
  for (const name of names) {
    const logs = await docker(["logs", name]).then(value => value.stdout + value.stderr, value => value.message);
    await writeFile(join(evidence, `${name}.log`), logs);
  }
  throw error;
} finally {
  const cleanup = await Promise.allSettled([...names].map(name => docker(["rm", "-f", name])));
  if (madeVolume) cleanup.push(...await Promise.allSettled([docker(["volume", "rm", volume])]));
  const failures = cleanup.filter(result => result.status === "rejected");
  receipt.cleaned = failures.length === 0;
  if (failures.length) receipt.cleanupErrors = failures.map(result => result.reason.message);
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
assert.equal(receipt.cleaned, true, "Fixture cleanup failed");
