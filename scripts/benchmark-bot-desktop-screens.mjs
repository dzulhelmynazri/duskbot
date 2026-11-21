import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { closeFixtureBrowser, connectMcp, driver, eventually, httpFixture, sleep, socket } from "./testing/bot-desktop-fixture.mjs";

const run = promisify(execFile);
const image = process.env.MADANI_VERIFY_DESKTOP_IMAGE;
assert.ok(image, "set MADANI_VERIFY_DESKTOP_IMAGE to an immutable fixture image");
const counts = (process.argv.find(arg => arg.startsWith("--counts="))?.split("=")[1] || "1,4").split(",").map(Number);
assert.ok(counts.every(count => Number.isInteger(count) && count > 0 && count <= 20));
const idleMs = Number(process.argv.find(arg => arg.startsWith("--idle-ms="))?.split("=")[1] || 10_000);
assert.ok(idleMs >= 1000 && idleMs <= 30_000);
const browserLimit = Number(process.argv.find(arg => arg.startsWith("--browser-limit="))?.split("=")[1] || 4);
assert.ok(Number.isInteger(browserLimit) && browserLimit >= 1 && browserLimit <= 20);
const evidence = await mkdtemp("/tmp/madani-screen-bench-");
const root = fileURLToPath(new URL("..", import.meta.url));
const guestSources = [];
if (process.argv.includes("--guest-source")) {
  await mkdir(join(evidence, "guest"));
  for (const name of ["omb-screen", "omb-session"]) {
    const source = join(root, "deploy/bot-desktop/rootfs/usr/local/bin", name);
    const path = join(evidence, "guest", name);
    await copyFile(source, path);
    await chmod(path, 0o755);
    guestSources.push({ source, path, destination: `/usr/local/bin/${name}` });
  }
}
process.env.MADANI_DATA_DIR = join(evidence, "server-data");
const { independentScreenTarget } = await import("../server/shared-desktop-screens.ts");
const { boxChromeRelay, boxChromeExecArgs } = await import("../server/vps-local.ts");
const imageId = (await run("docker", ["image", "inspect", image, "--format", "{{.Id}}"])).stdout.trim();
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const receipt = { imageId, evidence, limits: { cpu: 2, memoryBytes: 4 * 1024 ** 3, swapBytes: 0, pids: 4096, runBytes: 64 * 1024 ** 2, browserLimit }, storage: "owned named home volume; tmpfs runtime and temporary files", primary: "one common desktop and about:blank Chromium, in addition to the independent screen count", cases: [], ok: false };
receipt.guestSources = await Promise.all(guestSources.map(async source => ({ ...source, sha256: createHash("sha256").update(await readFile(source.path)).digest("hex") })));
async function mapBounded(items, concurrency, operation) {
  const answers = Array(items.length);
  let cursor = 0;
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try { answers[index] = { status: "fulfilled", value: await operation(items[index]) }; }
      catch (reason) { answers[index] = { status: "rejected", reason }; }
    }
  }));
  return answers;
}
const sampler = `from pathlib import Path
import json,time
cg=Path('/sys/fs/cgroup')
def text(name):
    try: return (cg/name).read_text().strip()
    except OSError: return None
def number(name):
    raw=text(name)
    return int(raw) if raw and raw.isdigit() else raw
def pairs(name):
    raw=text(name)
    return dict((k,int(v)) for k,v in (line.split() for line in raw.splitlines())) if raw else {}
groups={}
errors=0
for p in Path('/proc').iterdir():
    if not p.name.isdigit(): continue
    try:
        status=dict(line.split(':',1) for line in (p/'status').read_text().splitlines() if ':' in line)
        rss=int(status.get('VmRSS','0 kB').strip().split()[0])*1024
        comm=(p/'comm').read_text().strip()
        name='chromium' if comm in ('chromium','chrome_crashpad') else 'Xvnc' if comm=='Xvnc' else 'cua-driver' if comm=='cua-driver' else 'other'
        group=groups.setdefault(name,dict(processes=0,rssBytes=0,pssBytes=0,pssUnavailable=0))
        group['processes']+=1; group['rssBytes']+=rss
        try:
            smaps=dict(line.split(':',1) for line in (p/'smaps_rollup').read_text().splitlines() if ':' in line)
            group['pssBytes']+=int(smaps['Pss'].strip().split()[0])*1024
        except (OSError,KeyError): group['pssUnavailable']+=1
    except (OSError,ValueError): errors+=1
print(json.dumps(dict(at=time.time(),memoryCurrent=number('memory.current'),memoryPeak=number('memory.peak'),memoryMax=number('memory.max'),memorySwapMax=number('memory.swap.max'),memoryEvents=pairs('memory.events'),memoryStat=pairs('memory.stat'),cpuStat=pairs('cpu.stat'),pidsCurrent=number('pids.current'),processGroups=groups,procReadErrors=errors)))
`;
async function benchmark(count) {
  const result = { count, stages: {}, starts: [], ok: false };
  receipt.cases.push(result);
  let container;
  let volume;
  try {
    volume = `madani-screen-bench-home-${process.pid}-${count}`;
    await run("docker", ["volume", "create", "--label", "bot.madani.verification=screen-benchmark", volume]);
    result.volume = volume;
    const boot = performance.now();
    container = (await run("docker", ["run", "--rm", "-d", "--name", `madani-screen-bench-${process.pid}-${count}`, "--label", "bot.madani.verification=screen-benchmark",
      "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
      "--memory", "4g", "--memory-swap", "4g", "--cpus", "2", "--pids-limit", "4096", "--shm-size", "512m",
      "--mount", `type=volume,source=${volume},target=/home/cua`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
      ...guestSources.flatMap(source => ["--mount", `type=bind,source=${source.path},target=${source.destination},readonly`]),
      "--tmpfs", "/run:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0755", "-e", "MADANI_START_URL=about:blank",
      "--entrypoint", "/usr/local/bin/omb-session", imageId], { timeout: 15_000 })).stdout.trim();
    result.container = container;
    const exec = (args, timeout = 20_000) => run("docker", ["exec", "-u", "1000:1000", container, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 });
    const sample = async () => JSON.parse((await exec(["python3", "-I", "-c", sampler])).stdout);
    await eventually(() => exec([driver, "status", "--socket", socket]), () => true, "primary desktop did not start");
    result.primaryBootMs = Math.round(performance.now() - boot);
    const info = JSON.parse((await run("docker", ["inspect", container])).stdout)[0];
    assert.equal(info.HostConfig.NetworkMode, "none");
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(info.Mounts.filter(mount => mount.Type === "bind").map(mount => [mount.Destination, mount.RW]).sort(), guestSources.map(source => [source.destination, false]).sort());
    assert.deepEqual(info.Mounts.filter(mount => mount.Type === "volume").map(mount => [mount.Name, mount.Destination]), [[volume, "/home/cua"]]);
    const primary = await connectMcp(container);
    try {
      const state = await eventually(() => primary.call("get_desktop_state", { screenshot_out_file: "/tmp/primary.png" }), state => state.windows.some(window => window.title === "about:blank - Chromium"), "primary blank browser did not settle");
      const window = state.windows.find(window => window.title === "about:blank - Chromium");
      result.primaryWindow = { pid: window.pid, title: window.title };
    } finally { await primary.close(); }
    await sleep(1000);
    result.stages.primary = await sample();
    const version = JSON.parse((await exec(["/usr/local/bin/omb-screen", "version"])).stdout);
    assert.ok(version.displays.length >= count, `image supports ${version.displays.length} extra screens, requested ${count}`);
    const begin = performance.now();
    const targets = Array.from({ length: count }, (_, index) => ({ botId: `benchmark-bot-${index}`, display: index + 2, hash: createHash("sha256").update(`benchmark-bot-${index}`).digest("hex"), generation: randomUUID() }));
    const closeBrowser = async target => {
      const closed = JSON.parse((await exec(["/usr/local/bin/omb-screen", "browser-close", String(target.display), target.hash, target.generation])).stdout);
      assert.equal(closed.browserClosed, true);
      return { display: target.display, ...closed };
    };
    const starts = await mapBounded(targets, 2, async target => {
      const at = performance.now();
      const ready = JSON.parse((await exec(["/usr/local/bin/omb-screen", "ensure", String(target.display), target.hash, target.generation], 60_000)).stdout);
      assert.equal(ready.ready, true);
      assert.equal(ready.generation, target.generation);
      const answer = { display: target.display, elapsedMs: Math.round(performance.now() - at) };
      result.starts.push(answer);
      return answer;
    });
    result.parallelStartMs = Math.round(performance.now() - begin);
    result.startConcurrency = 2;
    result.stages.afterStart = await sample();
    const failed = starts.find(answer => answer.status === "rejected");
    if (failed) throw failed.reason;
    const before = await sample();
    await sleep(idleMs);
    const after = await sample();
    result.stages.idle = { before, after, seconds: after.at - before.at, cpuCores: (after.cpuStat.usage_usec - before.cpuStat.usage_usec) / ((after.at - before.at) * 1e6) };
    assert.equal(after.memoryEvents.oom_kill, 0);
    await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ stage: "idle", count, memoryBytes: after.memoryCurrent, evidence }));
    if (process.argv.includes("--admission-stress")) {
      result.admission = { opened: [], declined: null };
      for (const target of targets) {
        const canonical = independentScreenTarget(target.botId, target.display, target.generation);
        let diagnostics = "";
        const relay = await boxChromeRelay(() => {
          const child = spawn("docker", boxChromeExecArgs(container, canonical), { stdio: ["pipe", "pipe", "pipe"] });
          child.stderr.on("data", data => { diagnostics += data.toString(); });
          return child;
        });
        try {
          const at = performance.now();
          const response = await fetch(`${relay.url}/json/version`, { signal: AbortSignal.timeout(20_000) });
          const version = await response.json();
          assert.ok(version.Browser);
          const resources = await sample();
          assert.equal(resources.memoryEvents.oom_kill, 0);
          result.admission.opened.push({ display: target.display, elapsedMs: Math.round(performance.now() - at), resources });
          await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
        } catch (error) {
          await sleep(100);
          result.admission.declined = { display: target.display, error: error.message, diagnostics, resources: await sample() };
          assert.match(diagnostics, /low on memory/i, "browser admission failed without an actionable memory refusal");
          break;
        } finally { relay.close(); }
      }
      for (const opened of result.admission.opened) await closeBrowser(targets.find(target => target.display === opened.display));
      result.admission.afterClose = await sample();
      assert.equal(result.admission.afterClose.memoryEvents.oom_kill, 0);
      console.log(JSON.stringify({ stage: "admission", count, opened: result.admission.opened.length, declined: result.admission.declined?.diagnostics, evidence }));
    }
    if (process.argv.includes("--forms")) {
      await exec(["python3", "-I", "-c", "from pathlib import Path; import sys; Path('/tmp/form-server.py').write_text(sys.argv[1]); Path('/home/cua/shared-fixture.txt').write_text('Shared benchmark file')", httpFixture]);
      await run("docker", ["exec", "-d", "-u", "1000:1000", container, "python3", "-I", "/tmp/form-server.py"]);
      await eventually(() => exec(["python3", "-I", "-c", "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8765/',timeout=2).status)"]), answer => answer.stdout.trim() === "200", "fixture HTTP did not start");
      const workload = async (name, work) => {
        const samples = [await sample()];
        let done = false;
        const operation = Promise.resolve().then(work).finally(() => { done = true; });
        operation.catch(() => {});
        while (!done) {
          await sleep(1000);
          samples.push(await sample());
        }
        const final = samples.at(-1);
        result.stages[name] = { samples, seconds: final.at - samples[0].at, cpuCores: (final.cpuStat.usage_usec - samples[0].cpuStat.usage_usec) / ((final.at - samples[0].at) * 1e6), peakMemoryBytes: Math.max(...samples.map(value => value.memoryCurrent)) };
        return operation;
      };
      const appForm = async (target, recheck = false) => {
        const canonical = independentScreenTarget(target.botId, target.display, target.generation);
        const home = join(evidence, `home-${count}-${target.display}`);
        const binary = process.env.MADANI_AGENT_BROWSER_PATH || join(root, ".madani-scratch/verify-tools/tools/agent-browser/0.37.0/agent-browser");
        const relay = await boxChromeRelay(() => spawn("docker", boxChromeExecArgs(container, canonical), { stdio: ["pipe", "pipe", "ignore"] }));
        const transport = await connectMcp(container, canonical.socket);
        const started = performance.now();
        try {
          const { tools } = await transport.list();
          const tag = `${recheck ? "restore" : "bench"}-${count}-${target.display}`;
          const flow = { botId: target.botId, display: target.display, tag, cookieExpected: `screen-${target.display}`, sharedText: "Shared benchmark file", ...(recheck ? { skipForm: true } : { inputText: `App${target.display}`, cookieSet: `screen-${target.display}`, leaveForm: true }) };
          const output = await run(process.execPath, ["--experimental-strip-types", join(root, "scripts/testing/bot-desktop-app-browser.mjs"), relay.url, evidence, JSON.stringify(tools.map(tool => tool.name)), JSON.stringify(flow)], {
            timeout: 90_000, maxBuffer: 4 * 1024 * 1024, cwd: root, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, MADANI_DATA_DIR: join(home, "data"), MADANI_AGENT_BROWSER_PATH: binary },
          }).catch(async error => { await writeFile(join(evidence, `${tag}.log`), (error.stdout || "") + (error.stderr || "")); throw error; });
          await writeFile(join(evidence, `${tag}.log`), output.stdout + output.stderr);
          return { display: target.display, elapsedMs: Math.round(performance.now() - started), app: JSON.parse(await readFile(join(evidence, `app-browser-${tag}.json`), "utf8")) };
        } finally {
          await transport.close();
          try { await closeFixtureBrowser(binary, home, target.botId); }
          finally { relay.close(); }
        }
      };
      const nativeForm = async target => {
        const transport = await connectMcp(container, `/run/user/1000/omb-screens/${target.display}/cua.sock`);
        const started = performance.now();
        try {
          const state = await transport.call("get_desktop_state", { screenshot_out_file: `/tmp/bench-${target.display}.png` });
          const window = state.windows.find(window => window.title.includes("Isolated browser fixture"));
          assert.ok(window, `screen ${target.display} did not retain its form`);
          const args = { pid: window.pid, window_id: window.window_id, session: "benchmark", include_screenshot: false, tree_format: "elements", timeout_ms: 5000 };
          const tree = await transport.call("get_window_state", args);
          const input = tree.elements.find(element => element.role === "entry" && element.label === "Fixture name");
          assert.ok(input);
          const action = { pid: window.pid, window_id: window.window_id, session: args.session, delivery_mode: "foreground" };
          await transport.call("click", { ...action, element_token: input.element_token });
          await transport.call("type_text", { ...action, element_token: input.element_token, text: `Native${target.display}` });
          const entered = await transport.call("get_window_state", args);
          const button = entered.elements.find(element => element.role === "button" && element.label === "Save fixture");
          assert.ok(button);
          await transport.call("click", { ...action, element_token: button.element_token });
          await eventually(() => transport.call("get_desktop_state", { screenshot_out_file: `/tmp/bench-${target.display}.png` }), state => state.windows.some(window => window.title.includes(`Saved Native${target.display}`)), "native form did not submit");
          return { display: target.display, pid: window.pid, elapsedMs: Math.round(performance.now() - started) };
        } finally { await transport.close(); }
      };
      result.appForms = [];
      result.nativeForms = [];
      result.browserCloses = [];
      for (let offset = 0; offset < targets.length; offset += browserLimit) {
        const batch = targets.slice(offset, offset + browserLimit);
        result.appForms.push(...await workload(`appBusy${offset}`, () => Promise.allSettled(batch.map(target => appForm(target)))));
        result.nativeForms.push(...await workload(`nativeBusy${offset}`, () => Promise.allSettled(batch.map(nativeForm))));
        result.browserCloses.push(...await Promise.allSettled(batch.map(closeBrowser)));
        await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
        console.log(JSON.stringify({ stage: "forms", count, completed: Math.min(offset + browserLimit, targets.length), evidence }));
      }
      const failedForm = [...result.appForms, ...result.nativeForms].find(item => item.status === "rejected");
      result.formErrors = [...result.appForms, ...result.nativeForms].filter(item => item.status === "rejected").map(item => item.reason?.message);
      if (failedForm) throw new Error(result.formErrors.join("; "));
      const failedClose = result.browserCloses.find(item => item.status === "rejected");
      if (failedClose) throw failedClose.reason;
      result.cookieRechecks = [];
      for (const target of targets) {
        result.cookieRechecks.push(await appForm(target, true));
        await closeBrowser(target);
      }
      const beforeIdle = await sample();
      await sleep(idleMs);
      const afterIdle = await sample();
      result.stages.afterBusyIdle = { before: beforeIdle, after: afterIdle, seconds: afterIdle.at - beforeIdle.at, cpuCores: (afterIdle.cpuStat.usage_usec - beforeIdle.cpuStat.usage_usec) / ((afterIdle.at - beforeIdle.at) * 1e6) };
      assert.equal(afterIdle.memoryEvents.oom_kill, 0);
      const old = targets.at(-1);
      const newer = { ...old, generation: randomUUID() };
      await exec(["/usr/local/bin/omb-screen", "stop", String(old.display), old.hash, old.generation]);
      await exec(["/usr/local/bin/omb-screen", "ensure", String(newer.display), newer.hash, newer.generation], 60_000);
      const stale = JSON.parse((await exec(["/usr/local/bin/omb-screen", "stop", String(old.display), old.hash, old.generation])).stdout);
      assert.equal(stale.stopped, false);
      await exec(["/usr/local/bin/omb-screen", "check", String(newer.display), newer.hash, newer.generation]);
      await appForm(newer, true);
      await closeBrowser(newer);
      result.staleGenerationRefused = { display: newer.display, old: old.generation, current: newer.generation };
      const resetting = performance.now();
      await exec(["/usr/local/bin/omb-screen", "reset"], 60_000);
      result.resetMs = Math.round(performance.now() - resetting);
      const primaryAfter = await connectMcp(container);
      try {
        const state = await primaryAfter.call("get_desktop_state", { screenshot_out_file: "/tmp/primary-after.png" });
        assert.ok(state.windows.some(window => window.pid === result.primaryWindow.pid && window.title === result.primaryWindow.title));
      } finally { await primaryAfter.close(); }
      result.resetPreservedPrimary = true;
      const restored = { ...targets[0], generation: randomUUID() };
      await exec(["/usr/local/bin/omb-screen", "ensure", String(restored.display), restored.hash, restored.generation], 60_000);
      await appForm(restored, true);
      await closeBrowser(restored);
      result.resetPreservedProfile = true;
      result.stages.afterGenerationChecks = await sample();
      assert.equal(result.stages.afterGenerationChecks.memoryEvents.oom_kill, 0);
    }
    if (process.argv.includes("--native-profile-probe")) {
      const probeTargets = targets.slice(0, 2).map(target => ({ ...target, generation: randomUUID() }));
      const preparedScreens = await mapBounded(probeTargets, 2, target => exec(["/usr/local/bin/omb-screen", "ensure", String(target.display), target.hash, target.generation], 60_000));
      for (const screen of preparedScreens) if (screen.status === "rejected") throw screen.reason;
      result.nativeProfileProbe = await Promise.allSettled(probeTargets.map(async target => {
        const transport = await connectMcp(container, `/run/user/1000/omb-screens/${target.display}/cua.sock`);
        try {
          const prepared = await transport.call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_named", name: "same-fixture-name" }, session: `native-${target.display}` });
          const processInfo = prepared.prepared_pid ? JSON.parse((await exec(["python3", "-I", "-c", "from pathlib import Path; import json,sys; p=Path('/proc')/sys.argv[1]; print(json.dumps(dict(argv=(p/'cmdline').read_bytes().decode().split('\\0'),stat=(p/'stat').read_text(),managed=json.loads((Path('/run/user/1000/omb-screens')/sys.argv[2]/'state.json').read_text()))))", String(prepared.prepared_pid), String(target.display)])).stdout) : null;
          return { display: target.display, prepared, processInfo };
        } finally { await transport.close(); }
      }));
      for (const answer of result.nativeProfileProbe) {
        if (answer.status === "rejected") throw answer.reason;
        assert.equal(answer.value.prepared.prepared, true, JSON.stringify(answer.value.prepared));
        const target = targets.find(target => target.display === answer.value.display);
        const argv = answer.value.processInfo.argv.join(" ");
        assert.ok(argv.includes(`--user-data-dir=/home/cua/.local/state/omb/screens/${target.hash}/cua-driver/browser-profiles/same-fixture-name`), argv);
      }
    }
    result.ok = true;
    console.log(JSON.stringify({ count, parallelStartMs: result.parallelStartMs, idleMemoryBytes: after.memoryCurrent, idleCpuCores: result.stages.idle.cpuCores, evidence }));
  } catch (error) { result.error = error.message; throw error; }
  finally {
    const cleanupErrors = [];
    try {
      if (container) {
        result.finalState = await run("docker", ["inspect", container]).then(answer => JSON.parse(answer.stdout)[0].State, () => ({ missing: true }));
        await writeFile(join(evidence, `container-${count}.log`), await run("docker", ["logs", container]).then(answer => answer.stdout, () => ""));
        const stopping = performance.now();
        await run("docker", ["stop", "--time", "10", container], { timeout: 20_000 }).catch(async () => {
          await run("docker", ["rm", "--force", container], { timeout: 10_000 }).catch(async error => {
            if (await run("docker", ["inspect", container]).then(() => true, () => false)) throw error;
          });
        });
        result.stopMs = Math.round(performance.now() - stopping);
        await eventually(() => run("docker", ["inspect", container]).then(() => true, () => false), exists => !exists, "owned benchmark container did not clean up", 5000);
        result.cleaned = true;
      }
    } catch (error) { cleanupErrors.push(error.message); }
    try {
      if (volume) {
        await run("docker", ["volume", "rm", volume], { timeout: 10_000 });
        result.volumeCleaned = true;
      }
    } catch (error) { cleanupErrors.push(error.message); }
    if (cleanupErrors.length) result.cleanupErrors = cleanupErrors;
    await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
    assert.equal(cleanupErrors.length, 0, cleanupErrors.join("; "));
  }
}
try {
  for (const count of counts) await benchmark(count);
  receipt.ok = true;
} finally {
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ evidence, ok: receipt.ok }));
}
