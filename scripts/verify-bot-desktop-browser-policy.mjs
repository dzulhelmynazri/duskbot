import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { connectMcp, driver, eventually, httpFixture, sleep, socket } from "./testing/bot-desktop-fixture.mjs";

const run = promisify(execFile);
const image = process.env.MADANI_VERIFY_DESKTOP_IMAGE;
const installedDefaults = process.argv.includes("--installed-defaults");
assert.ok(image, "set MADANI_VERIFY_DESKTOP_IMAGE to an isolated fixture image");
const imageId = (await run("docker", ["image", "inspect", image, "--format", "{{.Id}}"])).stdout.trim();
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const evidence = await mkdtemp("/tmp/madani-browser-policy-");
process.env.MADANI_DATA_DIR = join(evidence, "server-data");
const { boxChromeRelay } = await import("../server/vps-local.ts");
const policies = { HighEfficiencyModeEnabled: true, MemorySaverModeSavings: 1, NetworkPredictionOptions: 2 };
const sentinel = "owned-mv3-persistence-fixture";
const files = {
  "manifest.json": JSON.stringify({ manifest_version: 3, name: "Owned MV3 fixture", version: "1.0", permissions: ["storage"], background: { service_worker: "worker.js" }, content_scripts: [{ matches: ["http://127.0.0.1:8765/*"], js: ["content.js"] }] }),
  "worker.js": `chrome.runtime.onMessage.addListener((message,sender,reply)=>{chrome.storage.local.get(['sentinel','visits']).then(async state=>{const next={sentinel:state.sentinel||${JSON.stringify(sentinel)},visits:(state.visits||0)+1};await chrome.storage.local.set(next);reply({...next,worker:true})});return true});`,
  "content.js": "chrome.runtime.sendMessage({read:true},answer=>{if(answer)document.documentElement.dataset.extensionFixture=JSON.stringify(answer)});",
};
const extension = join(evidence, "extension");
await mkdir(extension);
for (const [name, content] of Object.entries(files)) await writeFile(join(extension, name), content);
const hashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")]));
const receipt = { imageId, evidence, installedDefaults, policies, sourceHashes: hashes, results: [], ok: false, limits: { cpus: 2, memoryBytes: 4 * 1024 ** 3, network: "none" } };
const docker = args => run("docker", args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
const relayScript = `import os,socket,sys,threading
s=socket.create_connection(('127.0.0.1',9222),2)
s.settimeout(None)
def up():
 while True:
  data=os.read(0,65536)
  if not data:break
  s.sendall(data)
 try:s.shutdown(socket.SHUT_WR)
 except OSError:pass
threading.Thread(target=up,daemon=True).start()
while True:
 data=s.recv(65536)
 if not data:break
 sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
`;
const sampler = `from pathlib import Path
import json,time
root=Path('/sys/fs/cgroup')
def pairs(name):return dict((k,int(v)) for k,v in (line.split() for line in (root/name).read_text().splitlines()))
pss=0
for p in Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  v=dict(line.split(':',1) for line in (p/'smaps_rollup').read_text().splitlines() if ':' in line);pss+=int(v['Pss'].split()[0])*1024
 except (OSError,KeyError):pass
print(json.dumps(dict(at=time.monotonic(),memoryCurrent=int((root/'memory.current').read_text()),memoryStat=pairs('memory.stat'),cpu=pairs('cpu.stat'),events=pairs('memory.events'),pss=pss)))`;
const rows = Array.from({ length: 300 }, (_, i) => `<tr><td>Project ${i}</td><td>Review notes and documents ${i}</td><td>Ready</td></tr>`).join("");
const pageScript = httpFixture.replace("content = PAGE", `content = PAGE + ${JSON.stringify(`<h2>Project notes</h2><table>${rows}</table><p>Grüße नमस्ते 中文 ✓</p>`)}`);
const sourceFiles = [new URL(import.meta.url), new URL("./testing/bot-desktop-fixture.mjs", import.meta.url)];
for (const path of sourceFiles) receipt.sourceHashes[path.pathname] = createHash("sha256").update(await readFile(path)).digest("hex");
receipt.sourceHashes.policyJson = createHash("sha256").update(JSON.stringify(policies)).digest("hex");

async function connect(container) {
  const relay = await boxChromeRelay(() => spawn("docker", ["exec", "-i", "-u", "1000:1000", container, "python3", "-I", "-c", relayScript], { stdio: ["pipe", "pipe", "ignore"] }));
  let client;
  const pending = new Map();
  try {
    const metadata = await eventually(() => fetch(`${relay.url}/json/version`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()), v => Boolean(v.webSocketDebuggerUrl), "fixture Chromium CDP did not start");
    const address = new URL(metadata.webSocketDebuggerUrl);
    address.host = new URL(relay.url).host;
    client = new WebSocket(address);
    await once(client, "open", { signal: AbortSignal.timeout(5000) });
    let nextId = 0;
    client.on("message", raw => {
      const message = JSON.parse(raw), entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
    });
    return {
      metadata,
      send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
          const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 5000);
          pending.set(id, { resolve, reject, timer });
          client.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      close() { for (const entry of pending.values()) clearTimeout(entry.timer); client.terminate(); relay.close(); },
    };
  } catch (error) { client?.terminate(); relay.close(); throw error; }
}
const evaluate = async (cdp, session, expression) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session)).result.value;
async function page(cdp, url) {
  const at = performance.now(), target = await cdp.send("Target.createTarget", { url });
  const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await eventually(() => evaluate(cdp, session, "document.readyState"), value => value === "complete", "fixture page did not load");
  return { ...target, session, elapsedMs: Math.round(performance.now() - at) };
}
async function extensionState(cdp, session) {
  return eventually(() => evaluate(cdp, session, "JSON.parse(document.documentElement.dataset.extensionFixture||'null')"), value => value?.worker && value.sentinel === sentinel, "MV3 content script/service worker did not run");
}

async function measure(trial) {
  const mode = installedDefaults ? "installed" : trial ? "trial" : "baseline", name = `madani-browser-policy-${process.pid}-${mode}`, volume = `${name}-home`;
  const recommended = join(evidence, mode);
  await mkdir(recommended);
  if (trial) await writeFile(join(recommended, "trial.json"), JSON.stringify(policies));
  const result = { mode, timings: {}, native: {}, ok: false };
  receipt.results.push(result);
  let container, madeVolume = false, transport, cdp;
  try {
    await docker(["volume", "create", "--label", "bot.madani.verification=browser-policy", volume]); madeVolume = true;
    container = (await docker(["run", "-d", "--name", name, "--label", "bot.madani.verification=browser-policy", "--network", "none", "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "4g", "--memory-swap", "4g", "--cpus", "2", "--pids-limit", "4096", "--shm-size", "512m", "--mount", `type=volume,source=${volume},target=/home/cua`, "--mount", `type=bind,source=${extension},target=/fixture-extension,readonly`, ...(installedDefaults ? [] : ["--mount", `type=bind,source=${recommended},target=/etc/chromium/policies/recommended,readonly`]), "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--tmpfs", "/run:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0755", "-e", "MADANI_BROWSER_AT_START=off", imageId])).stdout.trim();
    const exec = args => docker(["exec", "-u", "1000:1000", container, ...args]);
    const detail = JSON.parse((await docker(["inspect", container])).stdout)[0];
    assert.equal(detail.HostConfig.NetworkMode, "none"); assert.deepEqual(detail.HostConfig.PortBindings, {});
    assert.equal(detail.HostConfig.ReadonlyRootfs, true);
    await eventually(() => exec([driver, "status", "--socket", socket]), () => true, "fixture desktop did not start");
    result.version = (await exec(["chromium", "--version"])).stdout.trim();
    await docker(["exec", "-d", "-u", "1000:1000", container, "python3", "-I", "-c", pageScript]);
    await eventually(() => exec(["python3", "-I", "-c", "import urllib.request;assert urllib.request.urlopen('http://127.0.0.1:8765').status==200"]), () => true, "fixture HTTP did not start");
    const launch = async () => {
      const at = performance.now();
      await docker(["exec", "-d", "-u", "1000:1000", container, "chromium", "--load-extension=/fixture-extension", "--disable-extensions-except=/fixture-extension", "about:blank"]);
      await eventually(() => exec(["python3", "-I", "-c", "import socket;s=socket.create_connection(('127.0.0.1',9222),1);s.close()"]), () => true, "browser port not ready");
      cdp = await connect(container);
      return Math.round(performance.now() - at);
    };
    result.timings.startMs = await launch();
    const policyPage = await page(cdp, "chrome://policy");
    const policyRows = await eventually(() => evaluate(cdp, policyPage.session, `(()=>{const rows=[];function text(root){return [...root.childNodes].map(n=>n.nodeType===3?n.textContent.trim():n.nodeType===1&&!['STYLE','SCRIPT'].includes(n.tagName)&&getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden'?text(n.shadowRoot||n):'').filter(Boolean).join('\\n')}function walk(root){for(const node of root.querySelectorAll('*')){if(node.tagName.toLowerCase()==='policy-row')rows.push(text(node.shadowRoot||node));if(node.shadowRoot)walk(node.shadowRoot)}}walk(document);return rows.filter(Boolean)})()`), value => Array.isArray(value) && value.length > 0, "chrome://policy rows did not load");
    result.policyRows = policyRows;
    await writeFile(join(evidence, `${mode}-policy-rows.json`), JSON.stringify(policyRows, null, 2));
    result.policyStatus = Object.fromEntries(Object.keys(policies).map(name => [name, policyRows.find(row => row.includes(name)) || null]));
    if (trial) result.allTrialPoliciesKnown = Object.entries(result.policyStatus).every(([name, row]) => row && !/unknown policy|error/i.test(row) && row.includes("\nRecommended\n") && row.split("\n").includes(String(policies[name])) && /OK/.test(row));
    await cdp.send("Target.closeTarget", { targetId: policyPage.targetId });
    const initial = (await cdp.send("Target.getTargets")).targetInfos.filter(t => t.type === "page" && t.url === "about:blank");
    const tabs = [];
    for (let i = 0; i < 4; i++) { const tab = await page(cdp, `http://127.0.0.1:8765/document-${i}`); tab.extension = await extensionState(cdp, tab.session); tabs.push(tab); }
    for (const target of initial) await cdp.send("Target.closeTarget", { targetId: target.targetId });
    result.timings.navigationMs = tabs.map(tab => tab.elapsedMs);
    result.extension = { first: tabs[0].extension, workers: (await cdp.send("Target.getTargets")).targetInfos.filter(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://")).map(t => t.url) };
    assert.ok(result.extension.workers.some(url => url.endsWith("/worker.js")));
    result.loaded = JSON.parse((await exec(["python3", "-I", "-c", sampler])).stdout);
    const before = JSON.parse((await exec(["python3", "-I", "-c", sampler])).stdout); await sleep(2000);
    const after = JSON.parse((await exec(["python3", "-I", "-c", sampler])).stdout);
    result.idle = { seconds: after.at - before.at, cpuSeconds: (after.cpu.usage_usec - before.cpu.usage_usec) / 1e6, memoryCurrent: after.memoryCurrent, anon: after.memoryStat.anon, pss: after.pss };
    transport = await connectMcp(container);
    const desktop = await eventually(() => transport.call("get_desktop_state", { screenshot_out_file: "/tmp/before.png" }), state => state.windows.some(w => w.title.includes("Isolated browser fixture")), "visible fixture page absent");
    const window = desktop.windows.find(w => w.title.includes("Isolated browser fixture"));
    const args = { pid: window.pid, window_id: window.window_id, session: "policy-fixture", include_screenshot: false, tree_format: "elements", timeout_ms: 5000 };
    const tree = await transport.call("get_window_state", args), input = tree.elements.find(e => e.role === "entry" && e.label === "Fixture name"); assert.ok(input);
    const action = { pid: window.pid, window_id: window.window_id, session: args.session, delivery_mode: "foreground" };
    await transport.call("click", { ...action, element_token: input.element_token });
    const unicode = "Maus Grüße नमस्ते 中文 ✓";
    await transport.call("type_text", { ...action, element_token: input.element_token, text: unicode });
    const typed = await transport.call("get_window_state", args), button = typed.elements.find(e => e.role === "button" && e.label === "Save fixture"); assert.ok(button);
    await transport.call("click", { ...action, element_token: button.element_token });
    await eventually(() => exec(["cat", "/tmp/submission.json"]), value => JSON.parse(value.stdout).value === unicode, "native Unicode did not reach fixture");
    const saved = await transport.call("get_desktop_state", { screenshot_out_file: "/tmp/saved.png" });
    assert.ok(saved.windows.some(w => w.title.includes("Saved Maus Grüße")));
    const pixels = Buffer.from((await exec(["base64", "-w0", "/tmp/saved.png"])).stdout, "base64"); assert.equal(pixels.readUInt32BE(0), 0x89504e47);
    await writeFile(join(evidence, `${mode}-unicode.png`), pixels); result.native = { input: unicode, httpReceived: true, screenshot: join(evidence, `${mode}-unicode.png`) };
    await transport.close(); transport = null;
    const visits = Math.max(...tabs.map(tab => tab.extension.visits));
    await cdp.send("Browser.close"); cdp.close(); cdp = null;
    await eventually(() => exec(["python3", "-I", "-c", "import socket;s=socket.socket();assert s.connect_ex(('127.0.0.1',9222))!=0"]), () => true, "browser did not close");
    result.timings.reopenMs = await launch();
    const reopened = await page(cdp, "http://127.0.0.1:8765/persistence-check");
    result.extension.afterReopen = await extensionState(cdp, reopened.session);
    assert.ok(result.extension.afterReopen.visits > visits, "chrome.storage did not persist its counter");
    await cdp.send("Browser.close"); cdp.close(); cdp = null;
    assert.equal(after.events.oom_kill, 0); result.ok = true;
  } catch (error) { result.error = error.message; throw error; }
  finally {
    cdp?.close(); await transport?.close();
    if (container) { const logs = await docker(["logs", name]).catch(e => ({ stdout: e.stdout || "", stderr: e.stderr || "" })); await writeFile(join(evidence, `${mode}-container.log`), logs.stdout + logs.stderr); }
    const cleanup = await Promise.allSettled(container ? [docker(["rm", "-f", name])] : []);
    if (madeVolume) cleanup.push(...await Promise.allSettled([docker(["volume", "rm", volume])]));
    result.cleaned = cleanup.every(v => v.status === "fulfilled");
  }
}
try {
  if (!installedDefaults) await measure(false);
  await measure(true);
  const trial = receipt.results.at(-1);
  assert.equal(trial.allTrialPoliciesKnown, true, "trial policies must be recognized without errors");
  if (!installedDefaults) {
    const baseline = receipt.results[0];
    receipt.comparison = { memoryCurrentDeltaBytes: trial.idle.memoryCurrent - baseline.idle.memoryCurrent, anonDeltaBytes: trial.idle.anon - baseline.idle.anon, pssDeltaBytes: trial.idle.pss - baseline.idle.pss, startDeltaMs: trial.timings.startMs - baseline.timings.startMs, idleCpuDeltaSeconds: trial.idle.cpuSeconds - baseline.idle.cpuSeconds, repeats: 1, tabCount: 4, discardedTabs: "not forced or claimed" };
  }
  receipt.ok = receipt.results.every(result => result.ok && result.cleaned);
} catch (error) { receipt.error = error.message; throw error; }
finally { await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ imageId, evidence, ok: receipt.ok, comparison: receipt.comparison, results: receipt.results.map(({ mode, timings, policyStatus, allTrialPoliciesKnown, extension, native, idle, error, cleaned }) => ({ mode, timings, policyStatus, allTrialPoliciesKnown, extension, native, idle, error, cleaned })) })); }
assert.equal(receipt.ok, true);
