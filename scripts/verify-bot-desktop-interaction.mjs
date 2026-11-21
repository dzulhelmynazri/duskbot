import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

import { closeFixtureBrowser, connectMcp, driver, eventually, httpFixture, socket } from "./testing/bot-desktop-fixture.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const image = process.env.MADANI_VERIFY_DESKTOP_IMAGE || "omb-bot-desktop:lean-fixture";
const evidence = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "madani-di-"));
const imageId = (await run("docker", ["image", "inspect", image, "--format", "{{.Id}}"])).stdout.trim();
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const receipt = { image, imageId, evidence, results: [], ok: false };

async function measure(forced) {
  const mode = forced ? "forced-accessibility" : "default-accessibility";
  const name = `madani-interaction-${process.pid}-${forced ? "forced" : "default"}`;
  const started = performance.now();
  let container;
  let transport;
  const result = { mode, name, imageId, timings: {}, tools: [] };
  receipt.results.push(result);
  try {
    container = (await run("docker", [
      "run", "--rm", "-d", "--name", name, "--label", "bot.madani.verification=interaction",
      "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--memory", "2g", "--cpus", "2", "--pids-limit", "512", "--shm-size", "512m",
      "--tmpfs", "/home/cua:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--tmpfs", "/run:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0755",
      "-e", "MADANI_BROWSER_AT_START=off", "--entrypoint", "/usr/local/bin/omb-session", imageId,
    ], { timeout: 15_000 })).stdout.trim();
    result.container = container;
    const exec = args => run("docker", ["exec", "-u", "1000:1000", "-e", "CUA_DRIVER_RS_TELEMETRY_ENABLED=0", container, ...args], {
      timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
    });
    const call = async (name, args) => {
      const at = performance.now();
      const answer = await transport.call(name, args);
      const elapsed = Math.round(performance.now() - at);
      result.tools.push({ name, elapsed });
      assert.notEqual(answer?.status, "refused", `${name} refused`);
      assert.notEqual(answer?.effect, "refused", `${name}: ${JSON.stringify(answer)}`);
      return answer;
    };
    await eventually(() => exec([driver, "status", "--socket", socket]), () => true, "driver did not start");
    result.timings.bootMs = Math.round(performance.now() - started);
    transport = await connectMcp(container);
    const detail = JSON.parse((await run("docker", ["inspect", container])).stdout)[0];
    assert.equal(detail.HostConfig.NetworkMode, "none");
    assert.equal(detail.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(detail.HostConfig.PortBindings, {});
    assert.equal(detail.Mounts.some(mount => mount.Type === "bind" || mount.Type === "volume"), false);
    result.isolation = { network: "none", user: detail.Config.User, publishedPorts: false, hostMounts: false };
    result.chromiumVersion = (await exec(["chromium", "--version"])).stdout.trim();
    await exec(["python3", "-I", "-c", "from pathlib import Path; import sys; Path('/tmp/form-server.py').write_text(sys.argv[1])", httpFixture]);
    await run("docker", ["exec", "-d", "-u", "1000:1000", container, "python3", "-I", "/tmp/form-server.py"]);
    await eventually(() => exec(["python3", "-I", "-c", "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8765/').status)"]), answer => answer.stdout.trim() === "200", "fixture HTTP server did not start");
    await run("docker", ["exec", "-d", "-u", "1000:1000", container, "chromium", "--user-data-dir=/tmp/fixture-chromium", ...(forced ? ["--force-renderer-accessibility"] : []), "http://127.0.0.1:8765/"]);
    const desktop = await eventually(() => call("get_desktop_state", { screenshot_out_file: "/tmp/initial.png" }), state => state.windows.some(window => window.title.includes("Isolated browser fixture")), "fixture browser did not open");
    const window = desktop.windows.find(window => window.title.includes("Isolated browser fixture"));
    result.window = { pid: window.pid, windowId: window.window_id, app: window.app_name, platform: desktop.platform };
    assert.equal(desktop.platform, "linux");
    const session = "computer-fixture";
    const snapshot = () => call("get_window_state", { pid: window.pid, window_id: window.window_id, session, include_screenshot: false, tree_format: "elements", timeout_ms: 5000 });
    const tree = await eventually(snapshot, state => state.elements.some(element => element.role === "entry" && element.label === "Fixture name"), "fixture web controls did not become accessible");
    await writeFile(join(evidence, `${mode}-tree.json`), JSON.stringify(tree, null, 2));
    result.accessibility = {
      elements: tree.element_count,
      webElements: tree.elements.filter(element => element.in_web_content).length,
      input: tree.elements.some(element => element.role === "entry" && element.label === "Fixture name"),
      button: tree.elements.some(element => element.role === "button" && element.label === "Save fixture"),
      truncated: tree.truncated ?? false,
    };
    const input = tree.elements.find(element => element.role === "entry" && element.label === "Fixture name");
    assert.ok(input, "named fixture input missing from AT-SPI");
    const target = { pid: window.pid, window_id: window.window_id, session, delivery_mode: "foreground" };
    await call("click", { ...target, element_token: input.element_token });
    const value = `${forced ? "Forced" : "Default"}NativeInput`;
    await call("type_text", { ...target, element_token: input.element_token, text: value });
    const typed = await snapshot();
    const button = typed.elements.find(element => element.role === "button" && element.label === "Save fixture");
    assert.ok(button, "named fixture button missing from AT-SPI");
    await call("click", { ...target, element_token: button.element_token });
    const saved = await eventually(() => exec(["cat", "/tmp/submission.json"]), answer => JSON.parse(answer.stdout).value === value, "native CUA form did not submit exact typed value");
    result.nativeSubmission = JSON.parse(saved.stdout).value;
    const captured = await call("get_desktop_state", { screenshot_out_file: "/tmp/submitted.png" });
    assert.ok(captured.windows.some(window => window.title.includes(`Saved ${value}`)));
    const pixels = Buffer.from((await exec(["base64", "-w0", "/tmp/submitted.png"])).stdout, "base64");
    assert.ok(pixels.length > 512 && pixels.readUInt32BE(0) === 0x89504e47);
    result.screenshot = join(evidence, `${mode}-submitted.png`);
    await writeFile(result.screenshot, pixels);
    if (!forced && process.argv.includes("--native-browser")) {
      const browserTools = await transport.list();
      await writeFile(join(evidence, `${mode}-browser-tools.json`), JSON.stringify(browserTools.tools.filter(tool => tool.name.startsWith("browser_") || tool.name === "get_browser_state"), null, 2));
      const browserSession = "browser-fixture";
      const prepared = await call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" }, session: browserSession });
      assert.equal(prepared.action, "launched_isolated_browser");
      assert.equal(prepared.endpoint_ownership.method, "spawned_by_driver");
      const browserDesktop = await eventually(() => call("get_desktop_state", { screenshot_out_file: "/tmp/browser-prepared.png" }), state => state.windows.some(window => window.pid === prepared.prepared_pid), "driver browser window did not open");
      const browserWindow = browserDesktop.windows.find(window => window.pid === prepared.prepared_pid);
      const bound = await call("get_browser_state", { pid: prepared.prepared_pid, window_id: browserWindow.window_id, session: browserSession });
      assert.equal(bound.binding_quality, "exact");
      assert.equal(bound.endpoint_access_class, "driver_owned");
      const tab = { target_id: bound.target_id, tab_id: bound.tabs[0].tab_id, session: browserSession };
      await call("get_browser_state", tab);
      await call("browser_navigate", { ...tab, url: "http://127.0.0.1:8765/" });
      const browserState = await call("get_browser_state", tab);
      await writeFile(join(evidence, `${mode}-browser-state.json`), JSON.stringify(browserState, null, 2));
      assert.equal(browserState.url, "http://127.0.0.1:8765/");
      const field = browserState.refs.find(ref => ref.node === "input" && ref.label?.includes("Fixture name"));
      assert.ok(field, "native browser snapshot did not expose fixture input");
      const typeResult = await call("browser_type", { ...tab, ref: field.ref, text: "BrowserToolInput", replace: true });
      const entered = await call("get_browser_state", tab);
      const submit = entered.refs.find(ref => ref.node === "button");
      assert.ok(submit, "native browser snapshot did not expose fixture button");
      const clickResult = await call("browser_click", { ...tab, ref: submit.ref, delivery_mode: "foreground" });
      await writeFile(join(evidence, `${mode}-browser-actions.json`), JSON.stringify({ typeResult, entered, clickResult }, null, 2));
      await eventually(() => exec(["cat", "/tmp/submission.json"]), answer => JSON.parse(answer.stdout).value === "BrowserToolInput", "native browser tools did not submit typed value");
      const browserSaved = await call("get_browser_state", tab);
      assert.equal(new URL(browserSaved.url).searchParams.get("name"), "BrowserToolInput");
      result.browser = { pid: prepared.prepared_pid, binding: bound.binding_quality, owner: bound.endpoint_access_class,
        url: browserSaved.url, submitted: "BrowserToolInput" };
      await call("get_desktop_state", { screenshot_out_file: "/tmp/browser-submitted.png" });
      result.browser.screenshot = join(evidence, `${mode}-browser-submitted.png`);
      await writeFile(result.browser.screenshot, Buffer.from((await exec(["base64", "-w0", "/tmp/browser-submitted.png"])).stdout, "base64"));
    }
    if (!forced) {
      const { boxChromeRelay, boxChromeExecArgs } = await import("../server/vps-local.ts");
      const binary = process.env.MADANI_AGENT_BROWSER_PATH || join(root, ".madani-scratch", "verify-tools", "tools", "agent-browser", "0.37.0", "agent-browser");
      const home = join(evidence, "app-home");
      const relay = await boxChromeRelay(() => spawn("docker", boxChromeExecArgs(container), { stdio: ["pipe", "pipe", "ignore"] }));
      try {
        const { tools } = await transport.list();
        const app = await run(process.execPath, ["--experimental-strip-types", join(root, "scripts/testing/bot-desktop-app-browser.mjs"), relay.url, evidence, JSON.stringify(tools.map(tool => tool.name))], {
          cwd: root, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
          env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, MADANI_DATA_DIR: join(evidence, "app-data"), MADANI_AGENT_BROWSER_PATH: binary },
        }).catch(async error => {
          await writeFile(join(evidence, "app-browser.log"), (error.stdout ?? "") + (error.stderr ?? ""));
          throw new Error(`App browser verification failed; see ${join(evidence, "app-browser.log")}`);
        });
        await writeFile(join(evidence, "app-browser.log"), app.stdout + app.stderr);
        const submitted = JSON.parse((await exec(["cat", "/tmp/submission.json"])).stdout);
        assert.equal(submitted.value, "AppBridgeInput");
        result.appBrowser = { submitted: submitted.value, evidence: join(evidence, "app-browser.json") };
        await call("get_desktop_state", { screenshot_out_file: "/tmp/app-browser.png" });
        result.appBrowser.screenshot = join(evidence, "app-browser.png");
        await writeFile(result.appBrowser.screenshot, Buffer.from((await exec(["base64", "-w0", "/tmp/app-browser.png"])).stdout, "base64"));
      } finally {
        try { await closeFixtureBrowser(binary, home, "desktop-fixture"); }
        finally { relay.close(); }
      }
    }
    await writeFile(join(evidence, `${mode}-container.log`), (await run("docker", ["logs", container])).stdout);
  } catch (error) {
    result.error = error.message;
    throw error;
  } finally {
    if (container) {
      const driverLog = await run("docker", ["exec", container, "cat", "/tmp/madani-log/cua-driver.error.log"]).then(answer => answer.stdout, () => "");
      await writeFile(join(evidence, `${mode}-driver.log`), driverLog);
    }
    await transport?.close();
    if (container) {
      await run("docker", ["stop", "--time", "2", container], { timeout: 10_000 });
      await eventually(() => run("docker", ["inspect", container]).then(() => true, () => false), value => value === false, "owned fixture container was not removed", 5000);
      result.cleaned = true;
    }
  }
}

try {
  await measure(false);
  await measure(true);
  receipt.ok = true;
} finally {
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, results: receipt.results }, null, 2));
}
