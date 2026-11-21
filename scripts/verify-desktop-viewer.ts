// Full server + built viewer + synthetic Docker/RFB, in disposable homes.
// Build first, then run with explicit MADANI_AGENT_BROWSER_PATH and
// AGENT_BROWSER_EXECUTABLE_PATH if reusing installed browser binaries.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, runControlMadani, type VerificationServer } from "./control-madani.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./testing/control-madani-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { connectCdp } from "../server/browser-sites.ts";
import { fakeVnc } from "./testing/fake-vnc.ts";
import { BASE_IMAGE_DIGEST, CUA_DRIVER_VERSION, IMAGE, IMAGE_LAYER_VERSION } from "../server/container-computer.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "madani-viewer-fixture-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
mkdirSync(join(scratch, "tmp"));
const desktop = await fakeVnc();
let fixture: VerificationServer | undefined;
let browser: { binary: string; env: NodeJS.ProcessEnv } | undefined;
let preview: MountedPreview | undefined;
let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
const inlineEvidence: string[] = [];
try {
  // No fixture command can reach the machine's real Docker installation.
  writeFileSync(join(bin, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const stopped = ${JSON.stringify(join(scratch, "stopped"))};
let args = process.argv.slice(2);
if (args[0] === "-H") args = args.slice(2);
const labels = ${JSON.stringify({ "bot.madani.local-vm": "1", "bot.madani.cua-driver": CUA_DRIVER_VERSION, "bot.madani.cua-base": BASE_IMAGE_DIGEST, "bot.madani.image-layer": IMAGE_LAYER_VERSION, "bot.madani.workspace": "1" })};
let result;
const imageId = 'sha256:' + 'a'.repeat(64);
if (args[0] === 'inspect' && /^madanibot-vps-/.test(args[1])) result = [{
  Id:'b'.repeat(64), Image:imageId, State:{Running:!fs.existsSync(stopped)}, Mounts:[],
  Config:{Image:${JSON.stringify(IMAGE)}, Env:['VNC_PW=fixture-password'], Labels:{...labels,
    'bot.madani.vps':'1', 'bot.madani.container':args[1], 'bot.madani.vps-viewer':'1'}},
  HostConfig:{Privileged:false,NetworkMode:'bridge',PortBindings:{},Memory:4294967296,MemorySwap:4294967296,NanoCpus:2000000000,
    PidsLimit:4096,CapDrop:['ALL'],CapAdd:['CAP_SETUID','CAP_SETGID'],IpcMode:'private',ShmSize:536870912,
    CgroupnsMode:'private',SecurityOpt:[],RestartPolicy:{Name:'unless-stopped',MaximumRetryCount:0}},
  NetworkSettings:{Networks:{bridge:{IPAddress:'172.17.0.5'}}}
}];
else if (['start','stop'].includes(args[0]) && (/^madanibot-vps-/.test(args[1]) || args[1] === 'b'.repeat(64))) { if(args[0]==='start') fs.rmSync(stopped,{force:true}); else fs.writeFileSync(stopped,'stopped'); result = args[1]; }
else if (args[0] === 'exec') result = args.includes('--version') ? 'cua-driver ${CUA_DRIVER_VERSION}'
  : (args.includes('madani-desktop-probe') || args.includes('health_report')) ? {schema_version:'1',overall:'ok',checks:[]} : {};
else if (args[0] === 'info') result = 'fixture';
else if (args[0] === 'image' && args[1] === 'inspect') result = [{Id:imageId,Config:{Labels:labels}}];
else if (args[0] === 'inspect' && args[1] === 'madanibot-computer') result = [{
  Config:{Image:${JSON.stringify(IMAGE)},Labels:labels,Env:['VNC_PW=fixture-password']},
  State:{Running:true},Image:imageId,
  HostConfig:{PortBindings:{'6901/tcp':[{HostIp:'127.0.0.1',HostPort:'${desktop.port}'}]}},
  NetworkSettings:{Ports:{'6901/tcp':[{HostIp:'127.0.0.1',HostPort:'${desktop.port}'}]}}
}];
else if (args[0] === 'ps') result = '';
else process.exit(1);
process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
`, { mode: 0o700 });
  // Stand in for SSH with an owned loopback TCP forward. It cannot dial a VPS.
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const net = require('node:net');
const fs = require('node:fs');
const args = process.argv.slice(2);
const forward = args[args.indexOf('-L') + 1];
if (!args.includes('-N') || !/^127\\.0\\.0\\.1:[0-9]+:172\\.17\\.0\\.5:6901$/.test(forward)) process.exit(1);
const log = ${JSON.stringify(join(scratch, "tunnels.log"))};
const server = net.createServer(socket => {
  const peer = net.connect(${desktop.port}, '127.0.0.1');
  socket.on('error',()=>peer.destroy()); peer.on('error',()=>socket.destroy());
  socket.on('close',()=>peer.destroy()); peer.on('close',()=>socket.destroy());
  socket.pipe(peer).pipe(socket);
});
server.listen(Number(forward.split(':')[1]),'127.0.0.1',()=>fs.appendFileSync(log,'open '));
process.on('SIGTERM',()=>{fs.appendFileSync(log,'close ');process.exit(0)});
`, { mode: 0o700 });
  fixture = await launchVerificationServer(process.env, undefined, {
    binDir: bin, host: "ssh://127.0.0.1:1", sshKey: join(scratch, "unused-key"), staticDir: join(root, "dist"),
  });
  console.log(JSON.stringify(fixture.info));
  const api = fixtureApi(fixture.info.url);
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  const { binary, chrome } = await ensureUiBrowser(process.env);
  const env = sessionEnv({ home: scratch, session: `viewer-${process.pid}`, chrome });
  browser = { binary, env };
  const command = (...args: string[]) => agentBrowser(binary, env, args);
  const evaluate = async <T = unknown>(js: string) => (await command("eval", js)).result as T;
  await command("open", `${fixture.info.url}/desktop-viewer#target=local%2Fshared`);
  // Pair through the actual HTTP endpoint in this disposable browser. The
  // resulting cookie forces both status and upgrades through session auth.
  assert.equal(await evaluate(`(async () => (await fetch('/api/auth/pair', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:${JSON.stringify(pairing.code)},cookie:true,label:'Viewer fixture'})})).status)()`), 200);
  const verifyLiveComputer = async (botId: string, wake = false) => {
    preview ??= await mountPreview(fixture, {
      entry: "/scripts/testing/live-computer-preview.tsx", route: "/__live-computer.html",
      title: "Isolated live computer", logLevel: "silent", hmr: false,
    });
    const snapshot = async (state: string) => {
      if (!wake) return;
      const path = join(dirname(fixture!.info.logPath), `inline-${state}-${process.pid}.png`);
      await command("screenshot", path);
      inlineEvidence.push(path);
    };
    const connectedBeforeWatch = desktop.connections();
    await command("set", "viewport", "1100", "850");
    desktop.pauseFrames();
    if (wake) await api("POST", `/api/bots/${botId}/computer/sleep`, {});
    await command("open", `${preview.previewUrl}?bot=${botId}&inline=1`);
    await command("wait", "[data-panel-tab=computer]");
    await command("click", "[data-panel-tab=computer]");
    await command("wait", "--fn", "document.querySelector('[data-panel-tab=computer]').getAttribute('aria-selected') === 'true'");
    console.log(JSON.stringify({ step: "inline-open", botId, wake }));
    if (wake) {
      await command("wait", "--fn", "document.querySelector('[data-inline-computer][data-stage=asleep] button[aria-label=\"Wake computer\"]:not(:disabled)') !== null && window.liveComputerFixture.status.configured === true && window.liveComputerFixture.status.container === 'stopped'");
      assert.equal(desktop.connections(), connectedBeforeWatch);
      await snapshot("asleep");
      console.log(JSON.stringify({ step: "inline-wake", botId }));
      await command("click", "[data-panel-screen] button");
    }
    await command("wait", "--fn", "document.querySelector('[data-live-desktop] canvas') !== null");
    assert.equal(await evaluate("document.querySelector('[data-inline-computer]').dataset.stage"), "loading");
    assert.equal(await evaluate("document.querySelector('[data-computer-waking] [data-asleep-mascot]') !== null"), true);
    assert.equal(await evaluate("document.querySelector('[data-live-desktop][data-expanded]') === null"), true);
    assert.equal(await evaluate("(() => { const buttons = Array.from(document.querySelectorAll('button')).filter(button => button.getAttribute('aria-label') === 'Take control' || button.textContent.trim() === 'Take control'); return buttons.every(button => button.disabled); })()"), true);
    assert.equal((await api("GET", `/api/bots/${botId}/computer/control`)).held, false);
    await snapshot("waking");
    desktop.releaseFrames();
    await command("wait", "--fn", "document.querySelector('[data-live-desktop][data-state=connected][data-view-only=true] canvas') !== null");
    await command("wait", "--fn", "document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[0] === 255");
    assert.equal(desktop.connections(), connectedBeforeWatch + 1);
    assert.equal(await evaluate("document.querySelector('[data-computer-waking]') === null"), true);
    assert.equal(await evaluate("document.querySelector('[data-live-desktop][data-expanded]') === null"), true);
    assert.equal((await api("GET", `/api/bots/${botId}/computer/control`)).held, false);
    await snapshot("watching");
    desktop.keys.length = 0;
    desktop.pointers.length = 0;
    await evaluate("document.querySelector('canvas').focus(); true");
    await command("press", "q");
    let point = await evaluate<{ x: number; y: number }>("(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
    const { cdpUrl } = await command("get", "cdp-url");
    assert.equal(typeof cdpUrl, "string");
    cdp ??= await connectCdp(cdpUrl as string);
    const { targetInfos } = await cdp.send("Target.getTargets") as { targetInfos: Array<{ type: string; targetId: string; url: string }> };
    const page = targetInfos.find(target => target.type === "page" && target.url.startsWith(preview!.previewUrl));
    assert.ok(page);
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const wheel = (deltaY: number, deltaX = 0) => cdp!.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaY, deltaX }, sessionId as string);
    const selectAll = async () => {
      const key = (type: string, key: string, code: string, windowsVirtualKeyCode: number, modifiers: number) => cdp!.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, modifiers }, sessionId as string);
      await key("keyDown", "Control", "ControlLeft", 17, 2);
      await key("keyDown", "a", "KeyA", 65, 2);
      await key("keyUp", "a", "KeyA", 65, 2);
      await key("keyUp", "Control", "ControlLeft", 17, 0);
    };

    await command("mouse", "move", String(point.x), String(point.y));
    await command("mouse", "down", "right");
    await command("mouse", "up", "right");
    await command("mouse", "down", "middle");
    await command("mouse", "up", "middle");
    await wheel(120);
    await selectAll();
    assert.equal(desktop.keys.length, 0);
    assert.equal(desktop.pointers.length, 0);
    const watchConnections = desktop.connections();
    await command("mouse", "move", String(point.x), String(point.y));
    await command("mouse", "down", "left");
    await command("mouse", "up", "left");
    await command("wait", "--fn", "document.querySelector('[data-live-desktop][data-state=connected][data-expanded=true][data-view-only=true]') !== null");
    assert.equal((await api("GET", `/api/bots/${botId}/computer/control`)).held, false);
    assert.equal(await evaluate("document.querySelector('[data-computer-control=watching]') !== null"), true);
    assert.equal(await evaluate("(() => { const r = document.querySelector('[data-computer-fullscreen]').getBoundingClientRect(); return r.x === 0 && r.y === 0 && r.width === innerWidth && r.height === innerHeight; })()"), true);
    await snapshot("viewer-watching");
    await command("find", "role", "button", "click", "--name", "Take control");
    await command("wait", "--fn", "document.querySelector('[data-live-desktop][data-state=connected][data-expanded=true]:not([data-view-only])') !== null");
    assert.equal(desktop.connections(), watchConnections);
    point = await evaluate("(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
    await snapshot("controlling");
    await command("press", "z");
    await desktop.untilKey(122);
    assert.ok(desktop.keys.includes(122));
    const pointer = desktop.nextPointer();
    await command("mouse", "move", String(point.x + 2), String(point.y + 2));
    await pointer;
    assert.ok(desktop.pointers.length > 0);
    console.log(JSON.stringify({step:"right-middle-wheel",botId}));
    desktop.pointers.length = 0;
    await command("mouse", "down", "right");
    await desktop.untilPointer(4);
    await command("mouse", "up", "right");
    await desktop.untilPointer(0);
    const contextBlocked = await evaluate("(() => { const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }); document.querySelector('canvas').dispatchEvent(event); return event.defaultPrevented; })()");
    assert.equal(contextBlocked, true);
    desktop.pointers.length = 0;
    await command("mouse", "down", "middle");
    await desktop.untilPointer(2);
    await command("mouse", "up", "middle");
    await desktop.untilPointer(0);
    desktop.pointers.length = 0;
    await wheel(120);
    await desktop.untilPointer(16);
    await wheel(-120);
    await desktop.untilPointer(8);
    await wheel(0, 120);
    await desktop.untilPointer(64);
    await wheel(0, -120);
    await desktop.untilPointer(32);
    desktop.keys.length = 0;
    await selectAll();
    await desktop.untilKey(0xffe3);
    await desktop.untilKey(97);
    await command("press", "Enter");
    await desktop.untilKey(0xff0d);
    await command("press", "Backspace");
    await desktop.untilKey(0xff08);
    await command("find", "role", "button", "click", "--name", "Stop");
    await command("wait", "--fn", "document.querySelector('[data-live-desktop][data-state=connected][data-view-only=true]') !== null");
    assert.equal(desktop.connections(), watchConnections);
    desktop.keys.length = 0;
    desktop.pointers.length = 0;
    assert.equal(await evaluate("document.querySelector('[data-computer-control=watching]') !== null"), true);
    await evaluate("document.querySelector('canvas').focus(); true");
    await command("press", "r");
    point = await evaluate("(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
    await command("mouse", "move", String(point.x + 4), String(point.y + 4));
    await command("mouse", "down", "right");
    await command("mouse", "up", "right");
    await wheel(120);
    assert.equal(desktop.keys.length, 0);
    assert.equal(desktop.pointers.length, 0);
    assert.equal((await api("GET", `/api/bots/${botId}/computer/control`)).held, false);
    assert.equal(await evaluate("window.liveComputerFixture.screenshots"), 0);
    assert.equal(await evaluate("window.liveComputerFixture.requests.filter(request => request.method === 'POST' && request.url.includes('/computer/join')).length"), 1);
    assert.equal(await evaluate("window.liveComputerFixture.requests.filter(request => request.method === 'GET' && request.url.includes('/desktop-viewer/')).length"), 0);
  };
  if (process.argv.includes("--live-only")) {
    await runControlMadani(["new-bot", "--name", "Live watch fixture", "--url", fixture.info.url]);
    const { bots } = await api("GET", "/api/bots?messages=0");
    const bot = bots.find((candidate: { name: string }) => candidate.name === "Live watch fixture");
    await api("PATCH", "/api/config", { vps: { sshAlias: "viewer-fixture", independentScreens: false } });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud", cloudBackend: "vps" });
    const loopbackProxy = await api("POST", `/api/bots/${bot.id}/computer/join?viewer=proxy`, {});
    assert.equal(new URL(loopbackProxy.joinUrl, fixture.info.url).pathname, "/desktop-viewer");
    await verifyLiveComputer(bot.id, true);
    await command("open", "about:blank");
    const shared = await api("POST", "/api/team-computers", { name: "Shared live fixture", requestId: crypto.randomUUID(), acknowledgeCost: true });
    await api("PATCH", `/api/team-computers/${shared.id}`, { section: "", acknowledgeSharedAccess: true });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: null });
    const sharedStatus = await api("GET", `/api/bots/${bot.id}/computer?threadId=${bot.threadId}`);
    assert.equal(sharedStatus.teamComputer.id, shared.id);
    assert.equal(sharedStatus.ready, true);
    assert.equal((await api("GET", `/api/bots/${bot.id}/computer/control`)).held, false);
    await verifyLiveComputer(bot.id);
    console.log(JSON.stringify({ ok: true, checks: ["Wake shows animated mascot then persistent live preview without fullscreen or control", "second preview click opens the original viewer read-only; only explicit Take control enables input", "Take control disabled until decoded RFB pixels", "real ComputerPanel renders synthetic RFB pixels", "view-only keyboard/pointer blocked", "right/middle click and vertical/horizontal wheel reach RFB only after takeover", "native canvas context menu suppressed", "Control+A/Enter/Backspace reach RFB", "fullscreen preserves the connection", "take sends keyboard input after lease", "hand-back blocks input", "one RFB connection for watch/take/hand-back with zero screenshots", "loopback proxy viewer URL", "shared team desktop watches without taking control and reuses its connection for take/hand-back"], logPath: fixture.info.logPath, screenshots: inlineEvidence }));
  } else {
  await command("wait", "--fn", "document.getElementById('retry') !== null");
  let nextConnection = desktop.nextConnection();
  await command("click", "#retry");
  await nextConnection;
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  assert.equal(await evaluate("document.querySelector('canvas').width"), 16);
  await command("wait", "--fn", "document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[0] === 255");
  assert.equal(await evaluate("document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[0]"), 255);
  const status = await evaluate<{ viewer_url: string }>("fetch('/api/local-computer').then(r=>r.json())");
  assert.equal(status.viewer_url, "/desktop-viewer#target=local%2Fshared");
  assert.equal(status.viewer_url.includes("password"), false);
  const matchingBackgrounds = "getComputedStyle(document.querySelector('#screen > div')).backgroundColor === getComputedStyle(document.querySelector('main')).backgroundColor";
  assert.equal(await evaluate(matchingBackgrounds), true);
  const evidenceDir = process.env.MADANI_UI_EVIDENCE_DIR ? resolve(root, process.env.MADANI_UI_EVIDENCE_DIR) : dirname(fixture.info.logPath);
  mkdirSync(evidenceDir, { recursive: true });
  const desktopScreenshot = join(evidenceDir, `viewer-${process.pid}-desktop.png`);
  await command("wait", "--fn", "document.getAnimations().every(a => a.playState !== 'running')");
  await command("screenshot", desktopScreenshot);
  await command("click", "#keyboard");
  await command("fill", "#text", "Hello\n世界");
  await command("click", "#send");
  await desktop.untilKey(0x0100754c);
  assert.ok(desktop.keys.includes(72));
  assert.ok(desktop.keys.includes(0xff0d));
  assert.ok(desktop.keys.includes(0x01004e16));
  await command("click", "#ctrl-alt-del");
  await desktop.untilKey(0xffff);
  assert.ok(desktop.keys.includes(0xffff));
  await command("click", "#clipboard");
  desktop.sendClipboard("From the desktop");
  await command("wait", "--fn", "document.getElementById('clipboard-text').value === 'From the desktop'");
  assert.equal(await evaluate("document.getElementById('send') === null"), true);
  await command("wait", "--fn", "document.getAnimations().every(a => a.playState !== 'running')");
  assert.equal(await evaluate("(() => { const title = document.querySelector('section h1').getBoundingClientRect(), close = document.querySelector('section button').getBoundingClientRect(); return close.height <= 32 && Math.abs((title.top + title.bottom - close.top - close.bottom) / 2) < 1; })()"), true);
  const clipboardScreenshot = join(evidenceDir, `viewer-${process.pid}-clipboard.png`);
  await command("screenshot", clipboardScreenshot);
  let nextClipboard = desktop.nextClipboard();
  await command("fill", "#clipboard-text", "To the desktop");
  assert.deepEqual(await nextClipboard, ["To the desktop"]);
  nextClipboard = desktop.nextClipboard();
  await evaluate("document.getElementById('clipboard-text').select()");
  await command("press", "Backspace");
  assert.deepEqual(await nextClipboard, [""]);
  // Editing this field syncs automatically; device clipboard permissions are never requested.
  await command("click", "#clipboard");
  assert.equal(await evaluate("document.getElementById('fit') === null"), true);
  const normalFit = "(() => { const r = document.getElementById('screen').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect(); return r.width / m.width > .94 && r.width / m.width < .96 && r.height / m.height > .94 && r.height / m.height < .96; })()";
  assert.equal(await evaluate(normalFit), true);
  assert.equal(await evaluate("document.getElementById('keyboard').title"), "Keyboard");
  assert.equal(await evaluate("document.getElementById('viewer-notice').title"), "noVNC licenses and source");
  assert.equal(await evaluate("document.getElementById('viewer-notice').target"), "_blank");
  assert.ok((await api("GET", "/api/local-computer")).viewer_url);
  const notice = await fetch(await evaluate<string>("document.getElementById('viewer-notice').href"));
  assert.equal(notice.status, 200);
  assert.equal(notice.headers.get("content-type"), "text/plain; charset=utf-8");
  const noticeText = await notice.text();
  assert.equal(noticeText, readFileSync(join(root, "public/novnc-NOTICE.txt"), "utf8"));
  const novncVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@novnc/novnc"];
  assert.ok(noticeText.includes(`https://github.com/novnc/noVNC/tree/v${novncVersion}`));
  assert.ok(noticeText.includes(readFileSync(join(root, "node_modules/@novnc/novnc/vendor/pako/LICENSE"), "utf8")));
  const desNotice = readFileSync(join(root, "node_modules/@novnc/novnc/core/crypto/des.js"), "utf8").split("*/", 1)[0] + "*/";
  assert.ok(noticeText.includes(desNotice));
  const dockedWidth = await evaluate<number>("document.querySelector('main').getBoundingClientRect().width");
  await command("click", "#hide-controls");
  await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 0");
  assert.ok(await evaluate<number>("document.querySelector('main').getBoundingClientRect().width") > dockedWidth);
  assert.equal(await evaluate("document.querySelector('aside').inert"), true);
  await command("wait", "--fn", "document.activeElement?.id === 'show-controls'");
  assert.equal(await evaluate("(() => { const link = document.getElementById('viewer-notice'), r = link.getBoundingClientRect(); return !link.closest('[inert]') && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === link; })()"), true);
  const balancedMargins = "(() => { const r = document.querySelector('main').getBoundingClientRect(); return r.left > 0 && Math.abs(r.left - (innerWidth - r.right)) < 1; })()";
  assert.equal(await evaluate(balancedMargins), true);
  await command("click", "#show-controls");
  await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 72");
  await command("wait", "--fn", "document.activeElement?.id === 'hide-controls'");
  if (await evaluate("document.fullscreenEnabled")) {
    await command("click", "#fullscreen");
    await command("wait", "--fn", "Boolean(document.fullscreenElement)");
    const fullscreenFit = "(() => { const r = document.getElementById('screen').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect(); return r.top === 0 && r.bottom === innerHeight && r.left === m.left && r.right === innerWidth; })()";
    await command("wait", "--fn", fullscreenFit);
    await command("screenshot", join(evidenceDir, `viewer-${process.pid}-fullscreen.png`));
    await command("click", "#hide-controls");
    await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 0");
    assert.equal(await evaluate(fullscreenFit), true);
    assert.equal(await evaluate("document.getElementById('screen').getBoundingClientRect().left"), 0);
    await command("click", "#show-controls");
    await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 72");
    await command("click", "#fullscreen");
    await command("wait", "--fn", "!document.fullscreenElement");
    await command("wait", "--fn", normalFit);
  }
  await command("set", "viewport", "390", "844");
  await command("click", "#hide-controls");
  await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 0");
  assert.equal(await evaluate(balancedMargins), true);
  await command("click", "#show-controls");
  await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 72");
  await command("click", "#keyboard");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  const phoneScreenshot = join(evidenceDir, `viewer-${process.pid}-phone.png`);
  await command("wait", "--fn", "document.getAnimations().every(a => a.playState !== 'running')");
  await command("screenshot", phoneScreenshot);
  assert.equal(await evaluate("(() => { const r = document.querySelector('section').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"), true);
  await evaluate("document.documentElement.dataset.skin = 'daylight'");
  await command("wait", "--fn", "getComputedStyle(document.getElementById('retry')).color === 'rgb(87, 87, 87)'");
  assert.equal(await evaluate(matchingBackgrounds), true);
  const lightScreenshot = join(evidenceDir, `viewer-${process.pid}-light.png`);
  await command("screenshot", lightScreenshot);
  // Match the shared skin rules for both enabled and disabled accent buttons.
  await evaluate("document.documentElement.dataset.skin = 'foundry'");
  await command("wait", "--fn", "getComputedStyle(document.getElementById('send')).color === 'rgb(176, 166, 150)'");
  await command("fill", "#text", "Foundry preview");
  await command("wait", "--fn", "getComputedStyle(document.getElementById('send')).color === 'rgb(28, 21, 12)'");
  const foundryScreenshot = join(evidenceDir, `viewer-${process.pid}-foundry.png`);
  await command("screenshot", foundryScreenshot);
  // A short landscape viewport must keep both the dock and panel scrollable.
  await command("set", "viewport", "844", "390");
  assert.equal(await evaluate("document.documentElement.scrollHeight <= innerHeight && document.querySelector('section').getBoundingClientRect().height <= innerHeight"), true);
  assert.equal(await evaluate("(async () => { document.getElementById('keyboard').click(); await new Promise(requestAnimationFrame); const p = document.querySelector('section'); return !p || p.inert; })()"), true);
  await command("wait", "--fn", "!document.querySelector('section')");
  // Reuse the app's reduced-motion path and verify that a closed panel leaves
  // no focusable controls behind, including during its normal animated exit.
  await evaluate("document.documentElement.dataset.reducedMotion = 'true'");
  await command("click", "#keyboard");
  await command("click", "#keyboard");
  await command("wait", "--fn", "!document.querySelector('section')");
  nextConnection = desktop.nextConnection();
  await command("click", "#retry");
  await nextConnection;
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  // Leaving while the credentials request is in flight must abort it. A
  // persisted-page restore must then establish a fresh connection.
  await evaluate(`(() => {
    const fetch = window.fetch;
    window.fetch = async (input, init) => {
      if (input !== '/api/desktop-viewer/local/shared') return fetch(input, init);
      window.fetch = fetch;
      window.viewerSignal = init.signal;
      const response = await fetch(input, init);
      await new Promise(resolve => { window.releaseViewerRequest = resolve; });
      return response;
    };
  })()`);
  await command("click", "#retry");
  await command("wait", "--fn", "typeof window.releaseViewerRequest === 'function'");
  assert.equal(await evaluate("(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true})); return window.viewerSignal.aborted; })()"), true);
  await evaluate("window.releaseViewerRequest()");
  nextConnection = desktop.nextConnection();
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))");
  await nextConnection;
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  // Exercise the real VPS join route, SSH process lifecycle and the same UI.
  await runControlMadani(["new-bot", "--name", "VPS fixture", "--url", fixture.info.url]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const vpsBot = bots.find((bot: { name: string }) => bot.name === "VPS fixture");
  await api("PATCH", "/api/config", { vps: { sshAlias: "viewer-fixture", independentScreens: false } });
  await api("PATCH", `/api/bots/${vpsBot.id}`, { computer: "cloud", cloudBackend: "vps" });
  const loopbackProxy = await api("POST", `/api/bots/${vpsBot.id}/computer/join?viewer=proxy`, {});
  assert.equal(new URL(loopbackProxy.joinUrl, fixture.info.url).pathname, "/desktop-viewer");
  // Two tabs opening at once share one join instead of the second being refused.
  const [joined] = await evaluate<{joinUrl:string}[]>(`Promise.all([0, 1].map(() => fetch('/api/bots/${vpsBot.id}/computer/join',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(async r=>{if(!r.ok)throw new Error(await r.text());return r.json()})))`);
  const viewer = new URL(joined.joinUrl, fixture.info.url);
  assert.equal(viewer.pathname, "/desktop-viewer");
  const target = new URLSearchParams(viewer.hash.slice(1));
  assert.equal(target.get("target"), `vps/${vpsBot.id}`);
  assert.ok(target.get("threadId"));
  assert.equal(target.has("password"), false);
  await command("click", "#clipboard");
  desktop.sendClipboard("Only on the previous desktop");
  await command("wait", "--fn", "document.getElementById('clipboard-text').value === 'Only on the previous desktop'");
  nextConnection = desktop.nextConnection();
  await Promise.all([nextConnection, command("open", `${fixture.info.url}${joined.joinUrl}`)]);
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  assert.equal(await evaluate("document.querySelector('section') === null || document.querySelector('section').inert"), true);
  await command("click", "#clipboard");
  assert.equal(await evaluate("document.getElementById('clipboard-text').value"), "");
  await command("click", "#clipboard");
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  await command("wait", "--fn", "document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[0] === 255");
  nextConnection = desktop.nextConnection();
  await command("click", "#retry");
  await nextConnection;
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  assert.equal(readFileSync(join(scratch, "tunnels.log"), "utf8").split("open").length - 1, 1);
  await verifyLiveComputer(vpsBot.id);
  await command("open", `${fixture.info.url}${joined.joinUrl}`);
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  const beforeLogout = desktop.connections();
  assert.equal(await evaluate("fetch('/api/auth/session').then(r=>r.json()).then(s=>s.kind)"), "session");
  assert.equal(await evaluate("fetch('/api/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)"), 200);
  await command("wait", "--fn", "document.getElementById('status').textContent.includes('disconnected')");
  assert.ok(beforeLogout >= 2);
  console.log(JSON.stringify({ ok: true, checks: ["built noVNC renders RFB pixels", "paired status uses app URL", "keyboard, Unicode and Ctrl-Alt-Del", "clipboard sync without Send, including clearing", "matching desktop backgrounds in both themes", "Foundry accent text", "95% fit, full-height fullscreen and fit restoration", "balanced collapsed margins and compact panel header", "native tooltips and reduced-motion panels", "phone and landscape viewports", "reconnect", "page exit aborts pending connection and restore reconnects", "VPS join, synthetic SSH forward and reconnect", "live ComputerPanel watch sends no input; take and handback reuse its RFB connection", "logout closes socket"], logPath: fixture.info.logPath, screenshots: [desktopScreenshot, clipboardScreenshot, phoneScreenshot, lightScreenshot, foundryScreenshot] }));
  }
} catch (error) {
  if (browser) {
    console.error(await agentBrowser(browser.binary, browser.env, ["console"]).catch(() => "Browser console unavailable"));
    console.error(await agentBrowser(browser.binary, browser.env, ["errors"]).catch(() => "Browser errors unavailable"));
    console.error(await agentBrowser(browser.binary, browser.env, ["eval", "JSON.stringify({text:document.body.innerText,fixture:window.liveComputerFixture})"]).catch(() => "Browser unavailable"));
  }
  throw error;
} finally {
  cdp?.close();
  if (browser) await agentBrowser(browser.binary, browser.env, ["close"], 10_000).catch(() => {});
  await preview?.close();
  await fixture?.close();
  await desktop.close();
  rmSync(scratch, { recursive: true, force: true });
}
