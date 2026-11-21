import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { closeFixtureBrowser, connectMcp, driver, eventually, httpFixture, socket } from "./testing/bot-desktop-fixture.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const evidence = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "madani-ms-"));
const image = process.env.MADANI_VERIFY_DESKTOP_IMAGE;
assert.ok(image, "select a fixture image containing omb-screen with MADANI_VERIFY_DESKTOP_IMAGE");
const imageId = (await run("docker", ["image", "inspect", image, "--format", "{{.Id}}"])).stdout.trim();
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
process.env.MADANI_DATA_DIR = join(evidence, "server-data");
process.env.MADANI_VPS_DOCKER = "local";
const { createSharedScreenBroker, independentScreenTarget, independentScreenExecArgs } = await import("../server/shared-desktop-screens.ts");
const { createVpsScreenRuntime } = await import("../server/vps-screen.ts");
const { defaultRunner } = await import("../server/vps-computer.ts");
const { boxChromeRelay, boxChromeExecArgs } = await import("../server/vps-local.ts");
const receipt = { image, imageId, evidence, screens: [], ok: false };
const runtime = createVpsScreenRuntime({ runner: async (args, options) => {
  receipt.runtime = { args, phase: "start" };
  try {
    const result = await defaultRunner(args, options);
    receipt.runtime = { args, phase: "done", stdout: result.stdout };
    return result;
  } catch (error) {
    const diagnostic = container ? await run("docker", ["exec", "-u", "1000:1000", container, "python3", "-I", "-c", "from pathlib import Path; root=Path('/run/user/1000/omb-screens'); [print(str(p)+':\\n'+p.read_text(errors='replace')) for p in root.glob('*/session.log')]"], { timeout: 5000 }).then(result => result.stdout + result.stderr, error => (error.stdout || "") + (error.stderr || "")) : "";
    receipt.runtime = { args, phase: "error", error: error.message, diagnostic };
    throw error;
  }
} });
const transports = new Set();
let container;
let broker;
try {
  container = (await run("docker", [
    "run", "--rm", "-d", "--name", `madani-screens-${process.pid}`, "--label", "bot.madani.verification=screens",
    "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--memory", "4g", "--cpus", "2", "--pids-limit", "4096", "--shm-size", "512m",
    "--tmpfs", "/home/cua:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--tmpfs", "/run:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0755",
    "-e", "MADANI_START_URL=about:blank", "--entrypoint", "/usr/local/bin/omb-session", imageId,
  ], { timeout: 15_000 })).stdout.trim();
  receipt.container = container;
  const exec = args => run("docker", ["exec", "-u", "1000:1000", container, ...args], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  await eventually(() => exec([driver, "status", "--socket", socket]), () => true, "primary CUA did not start");
  const detail = JSON.parse((await run("docker", ["inspect", container])).stdout)[0];
  assert.equal(detail.HostConfig.NetworkMode, "none");
  assert.equal(detail.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(detail.HostConfig.PortBindings, {});
  assert.equal(detail.Mounts.some(mount => mount.Type === "bind" || mount.Type === "volume"), false);
  const primary = await connectMcp(container);
  transports.add(primary);
  const primaryDesktop = await eventually(() => primary.call("get_desktop_state", { screenshot_out_file: "/tmp/primary-before.png" }), state => state.windows.some(window => /Chromium/.test(window.app_name) && window.title === "about:blank - Chromium"), "primary browser did not finish its initial blank page");
  const primaryWindow = primaryDesktop.windows.find(window => /Chromium/.test(window.app_name) && window.title === "about:blank - Chromium");
  receipt.primary = { pid: primaryWindow.pid, title: primaryWindow.title };
  await exec(["python3", "-I", "-c", "from pathlib import Path; import sys; Path('/tmp/form-server.py').write_text(sys.argv[1]); Path('/home/cua/shared-fixture.txt').write_text('Shared fixture marker')", httpFixture]);
  await run("docker", ["exec", "-d", "-u", "1000:1000", container, "python3", "-I", "/tmp/form-server.py"]);
  await eventually(() => exec(["python3", "-I", "-c", "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8765/').status)"]), answer => answer.stdout.trim() === "200", "fixture HTTP did not start");
  const descriptor = { sshAlias: "this-server", ownerId: "fixture-team", containerId: container };
  const revoked = [];
  broker = createSharedScreenBroker({ ...runtime, revoke: (_container, target) => revoked.push({ display: target.display, generation: target.generation }) });
  const started = performance.now();
  const leases = await Promise.all(["fixture-alice", "fixture-bob"].map(bot => broker.acquire(descriptor, bot, { kind: "turn" })));
  receipt.startMs = Math.round(performance.now() - started);
  assert.notEqual(leases[0].target.display, leases[1].target.display);
  assert.notEqual(leases[0].target.chromiumProfile, leases[1].target.chromiumProfile);
  const app = async (target, flow) => {
    const binary = process.env.MADANI_AGENT_BROWSER_PATH || join(root, ".madani-scratch", "verify-tools", "tools", "agent-browser", "0.37.0", "agent-browser");
    const home = join(evidence, `home-${flow.tag}`);
    const relay = await boxChromeRelay(() => spawn("docker", boxChromeExecArgs(container, target), { stdio: ["pipe", "pipe", "ignore"] }));
    try {
      const transport = await connectMcp(container, target.socket);
      transports.add(transport);
      const { tools } = await transport.list();
      const output = await run(process.execPath, ["--experimental-strip-types", join(root, "scripts/testing/bot-desktop-app-browser.mjs"), relay.url, evidence, JSON.stringify(tools.map(tool => tool.name)), JSON.stringify({ ...flow, botId: target.botId, display: target.display })], {
        cwd: root, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, MADANI_DATA_DIR: join(home, "data"), MADANI_AGENT_BROWSER_PATH: binary },
      }).catch(async error => {
        await writeFile(join(evidence, `${flow.tag}.log`), (error.stdout ?? "") + (error.stderr ?? ""));
        throw new Error(`App browser failed: ${flow.tag}; see ${evidence}`);
      });
      await writeFile(join(evidence, `${flow.tag}.log`), output.stdout + output.stderr);
      await transport.close();
      transports.delete(transport);
      return JSON.parse(await readFile(join(evidence, `app-browser-${flow.tag}.json`), "utf8"));
    } finally {
      try { await closeFixtureBrowser(binary, home, target.botId); }
      finally { relay.close(); }
    }
  };
  const screenshots = [];
  const appSettled = await Promise.allSettled(leases.map(lease => app(lease.target, { tag: `screen-${lease.target.display}`, inputText: `Screen${lease.target.display}AppInput`, cookieSet: `screen-${lease.target.display}`, cookieExpected: `screen-${lease.target.display}`, sharedText: "Shared fixture marker", leaveForm: true })));
  const failedApp = appSettled.find(result => result.status === "rejected");
  if (failedApp) throw failedApp.reason;
  const appResults = appSettled.map(result => result.value);
  for (const [index, lease] of leases.entries()) {
    const target = lease.target;
    const value = `Screen${target.display}NativeInput`;
    const record = { target, value };
    receipt.screens.push(record);
    record.app = appResults[index];
    const transport = await connectMcp(container, target.socket);
    transports.add(transport);
    const state = await transport.call("get_desktop_state", { screenshot_out_file: `/tmp/screen-${target.display}-before.png` });
    assert.equal(state.platform, "linux");
    const window = state.windows.find(window => window.title.includes("Isolated browser fixture"));
    assert.ok(window, "app CDP did not address this independent screen's browser");
    record.window = { pid: window.pid, windowId: window.window_id };
    const args = { pid: window.pid, window_id: window.window_id, session: "screen-fixture", include_screenshot: false, tree_format: "elements", timeout_ms: 5000 };
    const tree = await transport.call("get_window_state", args);
    const input = tree.elements.find(element => element.role === "entry" && element.label === "Fixture name");
    assert.ok(input);
    const action = { pid: window.pid, window_id: window.window_id, session: args.session, delivery_mode: "foreground" };
    await transport.call("click", { ...action, element_token: input.element_token });
    await transport.call("type_text", { ...action, element_token: input.element_token, text: value });
    const typed = await transport.call("get_window_state", args);
    const button = typed.elements.find(element => element.role === "button" && element.label === "Save fixture");
    assert.ok(button);
    await transport.call("click", { ...action, element_token: button.element_token });
    await eventually(() => exec(["cat", "/tmp/submission.json"]), answer => JSON.parse(answer.stdout).value === value, "independent native form did not submit");
    const after = await transport.call("get_desktop_state", { screenshot_out_file: `/tmp/screen-${target.display}-after.png` });
    assert.ok(after.windows.some(window => window.title.includes(`Saved ${value}`)));
    record.screenshot = join(evidence, `screen-${target.display}.png`);
    await writeFile(record.screenshot, Buffer.from((await exec(["base64", "-w0", `/tmp/screen-${target.display}-after.png`])).stdout, "base64"));
    screenshots.push({ target, value, transport });
  }
  assert.notEqual(receipt.screens[0].window.pid, receipt.screens[1].window.pid);
  for (const { target, value, transport } of screenshots) {
    const unchanged = await transport.call("get_desktop_state", { screenshot_out_file: `/tmp/screen-${target.display}-unchanged.png` });
    assert.ok(unchanged.windows.some(window => window.title.includes(`Saved ${value}`)), "work in another screen changed this browser");
    await transport.close();
    transports.delete(transport);
    await app(target, { tag: `cookie-${target.display}`, skipForm: true, cookieExpected: `screen-${target.display}`, sharedText: "Shared fixture marker" });
    assert.equal(JSON.parse((await exec(["cat", `/tmp/cookie-${target.display}.json`])).stdout).cookie, `FixtureScreen=screen-${target.display}`);
  }
  const oldTarget = leases[0].target;
  for (const lease of leases) lease.release();
  await broker.close();
  broker = undefined;
  receipt.stage = "restart";
  const newer = independentScreenTarget(oldTarget.botId, oldTarget.display);
  await runtime.start(descriptor, newer, new AbortController().signal);
  const stale = JSON.parse((await run("docker", independentScreenExecArgs(container, "stop", oldTarget))).stdout);
  assert.equal(stale.stopped, false);
  await exec([driver, "status", "--socket", newer.socket]);
  receipt.staleGenerationRefused = true;
  await app(newer, { tag: "after-stale", skipForm: true, cookieExpected: `screen-${newer.display}` });
  await runtime.reset(descriptor, new AbortController().signal);
  receipt.stage = "reset";
  await exec([driver, "status", "--socket", socket]);
  const primaryAfter = await primary.call("get_desktop_state", { screenshot_out_file: "/tmp/primary-after-reset.png" });
  assert.ok(primaryAfter.windows.some(window => window.pid === primaryWindow.pid && window.title === primaryWindow.title));
  const second = independentScreenTarget(leases[1].target.botId, leases[1].target.display);
  await runtime.start(descriptor, second, new AbortController().signal);
  await app(second, { tag: "after-reset", skipForm: true, cookieExpected: `screen-${second.display}` });
  await runtime.reset(descriptor, new AbortController().signal);
  receipt.resetPreservedPrimaryAndProfiles = true;
  receipt.revoked = revoked;
  receipt.ok = true;
} catch (error) {
  receipt.error = error.message;
  throw error;
} finally {
  for (const transport of transports) await transport.close();
  await broker?.close().catch(error => { receipt.cleanupError = error.message; });
  if (container) {
    await writeFile(join(evidence, "container.log"), (await run("docker", ["logs", container])).stdout);
    await run("docker", ["stop", "--time", "2", container], { timeout: 10_000 });
    await eventually(() => run("docker", ["inspect", container]).then(() => true, () => false), exists => !exists, "owned container was not removed", 5000);
    receipt.cleaned = true;
  }
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
