import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { savedVpsStartupTarget, startPackagedAlongsideVps } from "../electron/saved-vps-startup.mjs";

const flag = "--saved-vps-startup-fixture";
if (!process.versions.electron) {
  const output = mkdtempSync(join(tmpdir(), "madani-saved-vps-startup-"));
  const env = { ...process.env, HOME: output, USERPROFILE: output, APPDATA: join(output, "roaming"), LOCALAPPDATA: join(output, "local") };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(import.meta.url), flag, output], { env, stdio: "inherit" });
  const watchdog = setTimeout(() => child.kill(), 30_000);
  const code = await new Promise(resolve => { child.once("error", error => { console.error(error); resolve(1); }); child.once("exit", value => resolve(value ?? 1)); });
  clearTimeout(watchdog);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(output, "receipt.json"), "utf8")).passed, true);
  console.log(`Saved VPS startup evidence: ${output}`);
} else {
  assert.ok(process.argv.includes(flag));
  const output = process.argv[process.argv.indexOf(flag) + 1];
  const { app, BrowserWindow, session, ipcMain } = await import("electron");
  app.setPath("userData", join(output, "profile"));
  app.setPath("sessionData", join(output, "profile"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.on("window-all-closed", () => {});
  void app.whenReady().then(async () => {
  const servers = [];
  const page = async title => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><div id="root">${title}</div>`);
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const oldOrigin = await page("Occupied original port");
  const origin = await page("Saved VPS ready");
  const actualOrigin = await page("This Mac ready");
  session.defaultSession.webRequest.onBeforeRequest((request, callback) => callback({ cancel: ![oldOrigin, origin, actualOrigin].some(allowed => request.url.startsWith(`${allowed}/`)) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const active = { id: "fixture-saved-vps", kind: "remote", origin };
  const link = { stage: "linked", mode: "relay", server: { id: active.id, origin } };
  const target = () => savedVpsStartupTarget({ packaged: true, hidden: false, remoteAccess: null,
    active, link, priority: false, cloudHome: false, rememberedPlace: null });
  const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const from = main.indexOf("function rendererOrigin() {");
  const to = main.indexOf("\nfunction respondToDisplayMediaRequest", from);
  const context = { app: { isPackaged: true }, desktopRemoteAccess: null, serverReady: false,
    SERVER_PORT: new URL(oldOrigin).port, URL, ipcMain };
  assert.ok(from > 0 && to > from);
  runInNewContext(main.slice(from, to), context);
  const localOrigin = createRequire(import.meta.url)("../electron/local-origin.cjs");
  localOrigin.setLocalOrigin(null);
  ipcMain.handle("cloud-account:state", localOrigin.localOnly("cloud-account:state", () => ({ fixture: true })));
  for (const channel of ["home:page", "home:updating", "desktop-analytics:read", "desktop-language:read"]) {
    ipcMain.on(channel, event => { event.returnValue = false; });
  }
  let finishLocal, window;
  let localReady = false;
  const local = new Promise(resolve => { finishLocal = resolve; });
  const observed = local.then(() => {
    context.SERVER_PORT = new URL(actualOrigin).port; context.serverReady = true;
    localOrigin.setLocalOrigin(actualOrigin); localReady = true;
  });
  try {
    const startup = startPackagedAlongsideVps({ startLocal: () => local, target,
      ready: async id => ({ id, origin }), open: async () => {
        window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
          preload: fileURLToPath(new URL("../electron/preload.cjs", import.meta.url)), additionalArguments: [
            `--madani-local-origin=${oldOrigin}`, "--madani-current-local-origin=1", "--madani-company-desktop=1",
          ] } });
        await window.loadURL(origin);
        return true;
      } });
    assert.equal(await startup.remote, true);
    assert.equal(localReady, false);
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("root").textContent'), "Saved VPS ready");
    assert.equal(await window.webContents.executeJavaScript("typeof process"), "undefined");
    assert.equal(await window.webContents.executeJavaScript("window.madaniDesktop.app.ownPage"), false);
    await window.loadURL(oldOrigin);
    assert.equal(await window.webContents.executeJavaScript("window.madaniDesktop.app.ownPage"), false);
    assert.equal(await window.webContents.executeJavaScript("typeof window.madaniDesktop.cloudAccount"), "undefined");
    finishLocal(); await startup.local; await observed;
    await window.loadURL(actualOrigin);
    assert.equal(await window.webContents.executeJavaScript("window.madaniDesktop.app.ownPage"), true);
    assert.deepEqual(await window.webContents.executeJavaScript("window.madaniDesktop.cloudAccount.state()"), { fixture: true });
    await window.loadURL(oldOrigin);
    assert.equal(await window.webContents.executeJavaScript("window.madaniDesktop.app.ownPage"), false);
    context.serverReady = false; localOrigin.setLocalOrigin(null);
    let failLocal;
    const failing = new Promise((_resolve, reject) => { failLocal = reject; });
    const recovering = startPackagedAlongsideVps({ startLocal: () => failing, target,
      ready: async id => ({ id, origin }), open: async () => { await window.loadURL(origin); return true; } });
    const localFailure = recovering.local.catch(error => error.message);
    assert.equal(await recovering.remote, true);
    failLocal(new Error("fixture local server failed"));
    assert.equal(await localFailure, "fixture local server failed");
    assert.equal(window.isDestroyed(), false);
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("root").textContent'), "Saved VPS ready");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "receipt.json"), JSON.stringify({ passed: true,
      checks: ["sandboxed hidden renderer loaded saved VPS while local startup held", "occupied original port denied local bridge before and after startup", "same early window gained local bridge at confirmed alternate port", "local private IPC worked after local boot", "local failure left remote renderer usable", "permission handlers installed before navigation"],
      limitations: "Synthetic loopback VPS and held local startup; no full app, real tunnel, provider, installed package or user data exercised." }, null, 2));
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    finishLocal(); window?.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    app.exit(process.exitCode ?? 0);
  }
  }).catch(error => { console.error(error); app.exit(1); });
}
