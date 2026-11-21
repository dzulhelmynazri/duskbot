// Preloaded (`electron -r`) into every Electron the real-setup smoke starts. On macOS any shown window is a real native
// window, even an offscreen-rendered one, and the OS clamps far-off coordinates back onto the display; so nothing here
// ever shows: every window and view renders offscreen (painted for devtools capture without a native window on a
// display) and show, focus and friends do nothing. No dock icon, tray, global shortcut, login item, protocol handler or
// OS notification is made; native dialogs answer their default button; system-browser links are only recorded.
// A watchdog records ("visible") and hides any window that ever reports isVisible(); the smoke fails on that record.
// Events: MADANI_SMOKE_EVENTS, one JSON line each.
const electron = require("electron");
if (electron.app && process.type === "browser") {
  const { appendFileSync, mkdtempSync, writeFileSync } = require("node:fs");
  const { register } = require("node:module");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { pathToFileURL } = require("node:url");
  const { app, BrowserWindow, BaseWindow, dialog, shell, globalShortcut } = electron;
  const eventsFile = process.env.MADANI_SMOKE_EVENTS;
  const note = (kind, detail = {}) => { if (eventsFile) try { appendFileSync(eventsFile, `${JSON.stringify({ at: Date.now(), kind, ...detail })}\n`); } catch {} };
  try { app.dock?.hide(); } catch {}
  app.setActivationPolicy?.("prohibited");
  // the walkthrough shoots every screen in one look, whatever this Mac's appearance (MADANI_SMOKE_THEME=light|dark)
  const theme = /^(light|dark)$/.test(process.env.MADANI_SMOKE_THEME ?? "") ? process.env.MADANI_SMOKE_THEME : null;
  if (theme) { try { electron.nativeTheme.themeSource = theme; } catch {} app.whenReady().then(() => { try { electron.nativeTheme.themeSource = theme; } catch {} }); }

  // Electron names some folders after the app, not HOME or --user-data-dir (logs are ~/Library/Logs/madanibot, the
  // owner's own): every one of them goes into the smoke's profile instead
  const isolated = process.env.MADANI_SMOKE_PROFILE;
  if (isolated) {
    const { mkdirSync } = require("node:fs");
    const into = (name) => { const dir = join(isolated, "app-paths", name); mkdirSync(dir, { recursive: true }); return dir; };
    app.setAppLogsPath(into("logs"));
    for (const name of ["appData", "temp", "crashDumps", "downloads", "documents", "desktop", "music", "pictures", "videos", "recent"]) {
      try { app.setPath(name, into(name)); } catch {}
    }
  }

  // main's ESM imports of "electron" resolve to this copy: windows and views are made hidden and offscreen-rendered
  const replaced = ["default", "BrowserWindow", "WebContentsView", "Tray", "Notification"];
  const names = Object.keys(electron).filter((name) => !replaced.includes(name) && /^[A-Za-z_$][\w$]*$/.test(name));
  const shimFile = join(mkdtempSync(join(tmpdir(), "madani-smoke-electron-")), "electron-smoke.mjs");
  writeFileSync(shimFile, `import { createRequire } from "node:module";
const electron = createRequire(import.meta.url)("electron");
${names.map((name) => `export const ${name} = electron.${name};`).join("\n")}
const offscreen = (options = {}) => ({ ...options, show: false, x: -20000, y: -20000, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true, webPreferences: { ...(options.webPreferences || {}), offscreen: true, backgroundThrottling: false } });
export class BrowserWindow extends electron.BrowserWindow { constructor(options) { super(offscreen(options)); } }
export class WebContentsView extends electron.WebContentsView { constructor(options = {}) { super({ ...options, webPreferences: { ...(options.webPreferences || {}), offscreen: true, backgroundThrottling: false } }); } }
export class Tray { constructor() {} on() { return this; } once() { return this; } removeAllListeners() { return this; } setToolTip() {} setTitle() {} setImage() {} setPressedImage() {} setContextMenu() {} popUpContextMenu() {} closeContextMenu() {} setIgnoreDoubleClickEvents() {} getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; } isDestroyed() { return false; } destroy() {} }
export class Notification { static isSupported() { return false; } constructor(options = {}) { this.options = options; } on() { return this; } once() { return this; } show() {} close() {} }
export default { ...electron, BrowserWindow, WebContentsView, Tray, Notification };
`);
  const shimUrl = pathToFileURL(shimFile).href;
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === "electron" && context.parentURL !== ${JSON.stringify(shimUrl)}) return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true };
  return next(specifier, context);
}`)}`);

  // no window ever comes to the screen, whatever made it
  const never = ["show", "showInactive", "focus", "moveTop", "maximize", "restore", "setFullScreen", "setSimpleFullScreen", "setAlwaysOnTop", "setVisibleOnAllWorkspaces", "center", "flashFrame"];
  const hide = BaseWindow.prototype.hide;
  for (const proto of [BaseWindow.prototype, BrowserWindow.prototype]) for (const name of never) proto[name] = function () {};
  app.focus = () => {};
  app.show = () => {};
  app.on("browser-window-created", (_event, win) => {
    let offscreen = false;
    try { offscreen = win.webContents.isOffscreen(); } catch {}
    if (!offscreen) note("native-window", { title: win.getTitle() });
  });

  const answer = (options = {}) => ({ response: Number.isInteger(options.defaultId) ? options.defaultId : 0, checkboxChecked: false });
  const boxArgs = (args) => (args[0] && typeof args[0].isDestroyed === "function" ? args[1] : args[0]) ?? {};
  const told = (o) => ({ message: String(o.message ?? ""), detail: String(o.detail ?? "").slice(0, 300) });
  dialog.showMessageBox = async (...args) => { const o = boxArgs(args); note("dialog", told(o)); return answer(o); };
  dialog.showMessageBoxSync = (...args) => { const o = boxArgs(args); note("dialog", told(o)); return answer(o).response; };
  dialog.showErrorBox = (title, content) => note("error-box", { message: String(title), detail: String(content ?? "").slice(0, 300) });
  dialog.showOpenDialog = async () => { note("dialog", { message: "open dialog" }); return { canceled: true, filePaths: [] }; };
  dialog.showOpenDialogSync = () => { note("dialog", { message: "open dialog" }); return undefined; };
  dialog.showSaveDialog = async () => { note("dialog", { message: "save dialog" }); return { canceled: true }; };
  dialog.showSaveDialogSync = () => { note("dialog", { message: "save dialog" }); return undefined; };
  dialog.showCertificateTrustDialog = async () => {};
  shell.openExternal = async (url) => { note("open-external", { url: String(url) }); };
  shell.openPath = async (target) => { note("open-path", { path: String(target) }); return ""; };
  shell.showItemInFolder = (target) => note("open-path", { path: String(target) });
  shell.beep = () => {};
  app.setLoginItemSettings = () => note("login-item");
  app.setAsDefaultProtocolClient = () => true;
  app.setBadgeCount = () => true;
  globalShortcut.register = () => true;
  globalShortcut.registerAll = () => {};

  const watch = () => {
    for (const win of BaseWindow.getAllWindows()) {
      if (win.isDestroyed() || !win.isVisible()) continue;
      note("visible", { title: win.getTitle(), bounds: win.getBounds() });
      hide.call(win);
    }
  };
  setInterval(watch, 100).unref();
  // a madanibot:// link the browser hands to the app (no protocol handler is registered here): each new line of
  // MADANI_SMOKE_LINKS reaches main's own open-url handler, as macOS would deliver it
  const linkFile = process.env.MADANI_SMOKE_LINKS;
  if (linkFile) {
    const { existsSync, readFileSync } = require("node:fs");
    let seen = 0;
    setInterval(() => {
      if (!existsSync(linkFile)) return;
      const lines = readFileSync(linkFile, "utf8").split("\n").filter(Boolean);
      for (const url of lines.slice(seen)) { note("open-url", { url }); app.emit("open-url", { preventDefault() {} }, url); }
      seen = lines.length;
    }, 300).unref();
  }
  app.whenReady().then(() => {
    try { app.dock?.hide(); } catch {}
    watch();
    setTimeout(() => note("windows", { windows: BaseWindow.getAllWindows().map((win) => ({ visible: win.isVisible(), offscreen: (() => { try { return win.webContents.isOffscreen(); } catch { return null; } })() })) }), 15_000).unref();
  });
}
