// Main-process side of "Let my cloud bots use this Mac" (cloud-mac.mjs): the bridge's IPC for this app's own page and
// its own My Cloud page, the native confirm before it turns on, the folder picker, and the indicator's updates.
// Security invariant: turning it on always passes a native dialog on this Mac, so a page alone can never turn it on.
// MADANI_MAC_CONTROL=off leaves it out.
import path from "node:path";

import { createCloudMac } from "./cloud-mac.mjs";
import { macLogFile } from "./mac-control-tools.mjs";

export const CLOUD_MAC_CHANNELS = Object.freeze(["state", "setEnabled", "setMode", "setLimitFolders", "addFolder", "removeFolder", "openLog"]);
const FOLLOW_MS = 5_000;

/**
 * @param {{
 *   ipcMain: Electron.IpcMain, dialog: Electron.Dialog, shell: Electron.Shell,
 *   allowed(event: Electron.IpcMainInvokeEvent): boolean,
 *   window(): Electron.BrowserWindow | null,
 *   fetch: typeof fetch, label(): string, userData: string,
 *   jsonFile(file: string): { read(): any, write(value: any): void },
 *   myCloud(): string | null, cloudAwake(): boolean,
 *   linkKey(): Promise<string | null>, reauth(origin: string): Promise<boolean>,
 *   log(line: string): void,
 * }} deps
 */
export function installCloudMac(deps) {
  if (process.env.MADANI_MAC_CONTROL === "off") return null;
  const send = (view) => {
    const win = deps.window();
    if (win && !win.isDestroyed()) win.webContents.send("cloud-mac:changed", view);
  };
  const core = createCloudMac({
    fetch: deps.fetch, name: deps.label, log: deps.log,
    prefs: deps.jsonFile(path.join(deps.userData, "cloud-mac.json")),
    cloud: () => ({ origin: deps.myCloud(), awake: deps.cloudAwake() }),
    linkKey: deps.linkKey, reauth: deps.reauth, onChange: send,
  });
  const parent = () => { const win = deps.window(); return win && !win.isDestroyed() ? win : undefined; };

  async function confirmOn() {
    const options = {
      type: "warning", buttons: ["Let them use this Mac", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
      message: "Let your cloud bots use this Mac?",
      detail: "Bots on your madani cloud will be able to run any command, download files, open apps and links, and read and change your files on this Mac, as you. By default they ask you first only for risky things. You can change that, or keep them to some folders, in Settings, and turn this off any time.",
    };
    const win = parent();
    const { response } = win ? await deps.dialog.showMessageBox(win, options) : await deps.dialog.showMessageBox(options);
    return response === 0;
  }

  const handlers = {
    state: () => core.view(),
    async setEnabled(on) { return on === true && !(await confirmOn()) ? core.view() : core.setEnabled(on === true); },
    setMode: (mode) => core.setMode(String(mode)),
    setLimitFolders: (on) => core.setLimitFolders(on === true),
    async addFolder() {
      const win = parent();
      const options = { properties: ["openDirectory", "createDirectory"], buttonLabel: "Allow this folder" };
      const picked = win ? await deps.dialog.showOpenDialog(win, options) : await deps.dialog.showOpenDialog(options);
      return picked.canceled || !picked.filePaths[0] ? core.view() : core.addFolder(picked.filePaths[0]);
    },
    removeFolder: (folder) => core.removeFolder(String(folder)),
    async openLog() { await deps.shell.openPath(macLogFile()); },
  };
  for (const name of CLOUD_MAC_CHANNELS) {
    deps.ipcMain.handle(`cloud-mac:${name}`, (event, ...args) => {
      if (!deps.allowed(event)) throw new Error(`cloud-mac:${name} is only available in this app's window`);
      return handlers[name](...args);
    });
  }
  const tick = () => void core.sync().catch((error) => deps.log(`cloud mac: ${error?.message ?? error}`));
  tick();
  const timer = setInterval(tick, FOLLOW_MS);
  timer.unref?.();
  return { view: core.view, close() { clearInterval(timer); core.close(); } };
}
