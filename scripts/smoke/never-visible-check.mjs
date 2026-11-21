// The smoke shim's dry run, without the app: `electron -r scripts/smoke/electron-smoke-shim.cjs scripts/smoke/never-visible-check.mjs`
// (real-setup.mjs runs it first and stops if it fails). The shim must be in place before any window exists; then a
// window asked to show, focus and come forward stays invisible, its view and page still paint, and the watchdog saw nothing.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { app, BrowserWindow, WebContentsView } from "electron";

const raw = createRequire(import.meta.url)("electron");
const result = { hooked: BrowserWindow !== raw.BrowserWindow && WebContentsView !== raw.WebContentsView, showIsNoop: false, visible: [], painted: false, viewPainted: false };
const finish = (code) => { console.log(`never-visible ${JSON.stringify(result)}`); app.exit(code); };
const events = () => { try { return readFileSync(process.env.MADANI_SMOKE_EVENTS, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
setTimeout(() => finish(3), 30_000).unref();

app.whenReady().then(async () => {
  result.showIsNoop = raw.BaseWindow.prototype.show.toString().replace(/\s/g, "") === "function(){}";
  // no window is made unless the shim is in place
  if (!result.hooked || !result.showIsNoop || !process.env.MADANI_SMOKE_EVENTS) return finish(2);
  const win = new BrowserWindow({ show: true, width: 900, height: 700, x: 0, y: 0 });
  const view = new WebContentsView();
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 200, height: 700 });
  await Promise.all([
    win.loadURL("data:text/html,<body style='background:%23c9f63f'><h1>smoke</h1></body>"),
    view.webContents.loadURL("data:text/html,<body style='background:%23d0cefb'>rail</body>"),
  ]);
  for (const call of ["show", "showInactive", "focus", "moveTop", "maximize", "center"]) win[call]();
  app.focus({ steal: true });
  await new Promise((done) => setTimeout(done, 1500));
  result.visible = [win.isVisible(), ...events().filter((event) => event.kind === "visible").map((event) => event.title)].filter(Boolean);
  result.painted = !(await win.webContents.capturePage()).isEmpty();
  result.viewPainted = !(await view.webContents.capturePage()).isEmpty();
  finish(result.visible.length === 0 && result.painted && result.viewPainted ? 0 : 1);
});
