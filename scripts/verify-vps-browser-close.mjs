import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { closeVpsBrowser } from "../server/vps-browser-close.ts";
import { boxChromeExecArgs, boxChromeRelay } from "../server/vps-local.ts";

const run = promisify(execFile);
const image = process.env.MADANI_VERIFY_DESKTOP_IMAGE;
assert(image, "Set MADANI_VERIFY_DESKTOP_IMAGE to an explicitly selected fixture image");
const imageId = (await run("docker", ["image", "inspect", image, "--format", "{{.Id}}"])).stdout.trim();
const evidence = await mkdtemp(join(tmpdir(), "madani-browser-close-"));
const name = `madani-browser-close-${process.pid}`;
process.env.MADANI_VPS_DOCKER = "local";
let container, relay;
const receipt = { imageId, evidence, results: [], ok: false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  container = (await run("docker", ["run", "--rm", "-d", "--name", name, "--label", "bot.madani.verification=browser-close", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--memory", "2g", "--cpus", "2", "--pids-limit", "512", "--shm-size", "512m", "--tmpfs", "/home/cua:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--tmpfs", "/run:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0755", "-e", "MADANI_START_URL=about:blank", "--entrypoint", "/usr/local/bin/omb-init", imageId], { timeout: 15_000 })).stdout.trim();
  const target = { ownerId: "primary-fixture", sshAlias: "this-server", containerId: container };
  relay = await boxChromeRelay(() => spawn("docker", boxChromeExecArgs(container), { stdio: ["pipe", "pipe", "ignore"] }));
  let version;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { version = await (await fetch(relay.url + "/json/version", { signal: AbortSignal.timeout(1500) })).json(); break; }
    catch { await pause(100); }
  }
  assert(version?.Browser);
  const cdp = async () => {
    const info = await (await fetch(relay.url + "/json/version")).json();
    const endpoint = new URL(info.webSocketDebuggerUrl); endpoint.host = new URL(relay.url).host;
    const ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    let serial = 0;
    return { close: () => ws.close(), call(method, params = {}) {
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 3000);
        const listener = event => { const message = JSON.parse(event.data); if (message.id !== id) return; clearTimeout(timer); ws.removeEventListener("message", listener); if (message.error) reject(new Error(message.error.message)); else resolve(message.result); };
        ws.addEventListener("message", listener); ws.send(JSON.stringify({ id, method, params }));
      });
    } };
  };
  const before = await cdp();
  await before.call("Storage.setCookies", { cookies: [{ name: "lifecycle-proof", value: "retained", domain: "fixture.invalid", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 }] });
  before.close();
  const at = performance.now();
  await closeVpsBrowser(target, () => true);
  receipt.results.push({ stage: "browser", elapsedMs: Math.round(performance.now() - at), browser: version.Browser });
  const after = await cdp();
  const cookies = await after.call("Storage.getCookies");
  assert(cookies.cookies.some(cookie => cookie.name === "lifecycle-proof" && cookie.value === "retained"));
  after.close();
  await closeVpsBrowser(target, () => true);
  receipt.results.push({ stage: "reopen", persistentCookie: true });
  await run("docker", ["exec", "-d", "-u", "1000:1000", container, "python3", "-I", "-m", "http.server", "9222", "--bind", "127.0.0.1"]);
  await pause(250);
  await assert.rejects(closeVpsBrowser(target, () => true));
  const foreign = await run("docker", ["exec", container, "python3", "-I", "-c", "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:9222').status)"]);
  assert.equal(foreign.stdout.trim(), "200");
  receipt.results.push({ stage: "foreign-listener", refused: true, listenerStillAlive: true });
  receipt.ok = true;
} catch (error) {
  receipt.problem = error.message;
  if (container) {
    const processProbe = `import os,json
from pathlib import Path
inodes=set()
for name in ("tcp","tcp6"):
 for line in Path("/proc/net",name).read_text().splitlines()[1:]:
  f=line.split()
  if f[3]=="0A" and int(f[1].rsplit(":",1)[1],16)==9222: inodes.add("socket:["+f[9]+"]")
for p in Path("/proc").iterdir():
 if not p.name.isdigit(): continue
 try:
  if any(os.readlink(fd) in inodes for fd in (p/"fd").iterdir()): print(json.dumps({"pid":p.name,"cmdline":(p/"cmdline").read_bytes().decode().split("\\0")}))
 except OSError: pass
`;
    await writeFile(join(evidence, "listener.jsonl"), (await run("docker", ["exec", container, "python3", "-I", "-c", processProbe])).stdout);
  }
  throw error;
} finally {
  relay?.close();
  if (container) { await writeFile(join(evidence, "container.log"), (await run("docker", ["logs", container])).stdout); await run("docker", ["stop", "--time", "2", container], { timeout: 10_000 }); }
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ receipt: join(evidence, "receipt.json"), ok: receipt.ok }));
}
