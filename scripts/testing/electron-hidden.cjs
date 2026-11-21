// Loaded with NODE_OPTIONS=--require into a test-only Electron run: every BrowserWindow the app makes is created hidden,
// offscreen and painted offscreen, so a verification run never puts a window on the person's screen or takes focus.
// The app's main is ESM and Electron's exports cannot be redefined, so a resolve hook hands every importer but the shim
// a copy of "electron" whose BrowserWindow is the hidden one.
const electron = require("electron");
if (electron.app && process.type === "browser") {
  const { register } = require("node:module");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { pathToFileURL } = require("node:url");
  const shim = join(mkdtempSync(join(tmpdir(), "madani-hidden-electron-")), "electron-hidden.mjs");
  const names = Object.keys(electron).filter((name) => name !== "default" && name !== "BrowserWindow" && /^[A-Za-z_$][\w$]*$/.test(name));
  writeFileSync(shim, `import { createRequire } from "node:module";
const electron = createRequire(import.meta.url)("electron");
${names.map((name) => `export const ${name} = electron.${name};`).join("\n")}
export class BrowserWindow extends electron.BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false, x: -32000, y: -32000, skipTaskbar: true, focusable: false, webPreferences: { ...(options.webPreferences || {}), offscreen: true } });
  }
  show() {} showInactive() {} focus() {} moveTop() {} setAlwaysOnTop() {} maximize() {} setFullScreen() {}
}
export default { ...electron, BrowserWindow };
`);
  const shimUrl = pathToFileURL(shim).href;
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === "electron" && context.parentURL !== ${JSON.stringify(shimUrl)}) return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true };
  return next(specifier, context);
}`)}`);
  electron.app.dock?.hide();
  // CommonJS callers (preloads run in their own process; main-side .cjs helpers) get the same hidden windows
  electron.app.on("browser-window-created", (_event, window) => { if (window.isVisible()) window.hide(); });
}
