// main's side of "Add your VPS": the controller (vps-link.mjs) over electron's own pieces, ipc for this computer's page
// only, a pinned tls key for a server reached directly, and this mac's own ai sign-ins read or made locally.
import { spawn } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fsp, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createMacControlHost } from "./mac-control.mjs";
import { watchNetwork } from "./network-change.mjs";
import { createLinkAwake } from "./vps-link-awake.mjs";
import { createMacExecutor } from "./mac-control-tools.mjs";
import { cloudConnector, cloudRegister, cloudRelayUrl, newDirectKey, sshConnector, wssConnector } from "./vps-link-direct.mjs";
import { loadDataChannel, rtcConnector } from "./vps-link-rtc.mjs";

/** webrtc for the whole link where this app carries node-datachannel; turn servers from the signed-in account */
function rtcWay(screenIce) {
  const ndc = loadDataChannel();
  if (!ndc) return null;
  return { connector: ({ signal }) => rtcConnector({ ndc, signal, turn: async () => (await screenIce?.()) ?? [] }) };
}
import { createEgressDialer, createEgressEndpoint, seenAsCache } from "./vps-link-egress.mjs";
import { createVpsLink } from "./vps-link.mjs";
import { serverRequests } from "./own-home-main.mjs";
import { createHomeEgressLink } from "./home-egress-link.mjs";
import { proxyFromPac } from "./vps-link-protocol.mjs";

export const DEFAULT_LINK_BASE = "https://link.madani.bot";

/**
 * a linked server's page is http://vps-<id>.localhost, and every request it makes crosses the tunnel. chromium gives a
 * host six connections, so a page's burst (startup asks ~20 things) waited in line a whole tunnel round trip per six;
 * measured on a linked vps, requests queued up to 12 s. "localhost" covers every vps-<id>.localhost and only loopback
 * names. call before the app is ready.
 */
export function unlimitTunnelConnections(app) {
  app.commandLine.appendSwitch("ignore-connections-limit", "localhost");
}

/** reads a value saved by protect; electron's async safeStorage decrypt answers { result }, not a bare string */
export function unprotectWith(encryption) {
  return async (value) => {
    if (!value.startsWith("e:")) return value.slice(2);
    const out = await encryption.decrypt(Buffer.from(value.slice(2), "base64"));
    return typeof out === "string" ? out : String(out?.result ?? "");
  };
}
const METHODS = ["state", "start", "cancel", "reset", "engines", "signIn", "signInStatus", "signInCode", "signInCancel", "openUrl", "preview", "move", "retryMove", "open", "where", "backups", "backupNow", "restore", "moveBack", "forget"];

/** the tls verifier for the servers this app pinned: their own key, on top of the usual checks; every other host as usual */
export function createPins() {
  const pins = new Map();
  return {
    add: (host, spki) => pins.set(host.toLowerCase(), spki),
    size: () => pins.size,
    verify(request, callback) {
      const pin = pins.get(String(request.hostname).toLowerCase());
      if (!pin) return callback(-3);
      if (request.verificationResult !== "net::OK") return callback(-2);
      try {
        const der = new X509Certificate(request.certificate.data).publicKey.export({ type: "spki", format: "der" });
        return callback(createHash("sha256").update(der).digest("base64") === pin ? 0 : -2);
      } catch { return callback(-2); }
    },
  };
}

/** `claude setup-token` on this mac: it opens the browser itself and prints a long-lived token for headless use */
export function claudeSetupToken(cli, signal, { spawnImpl = spawn, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cli, ["setup-token"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
    let output = "";
    const done = (error, token) => { clearTimeout(timer); signal.removeEventListener("abort", stop); if (error) reject(error); else resolve(token); };
    const stop = () => { child.kill(); done(new Error("cancelled")); };
    const timer = setTimeout(() => { child.kill(); done(new Error("Claude sign-in timed out")); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    const read = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-65_536);
      const match = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/.exec(output);
      if (match) { done(null, match[0]); child.stdin?.end(); }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (error) => done(error));
    child.on("exit", () => done(new Error("Claude closed before it finished signing in")));
  });
}

async function folderSize(dir, limit = 200_000) {
  let total = 0, seen = 0;
  const walk = async (folder) => {
    let entries;
    try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++seen > limit) return;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) { try { total += (await fsp.stat(full)).size; } catch { /* gone */ } }
    }
  };
  await walk(dir);
  return total;
}

/**
 * Settings > Computer "Fast direct connection", asked by a linked server's own page: main names the link from the page
 * that asks (the main window at the active server), never from anything the page says.
 * @param {{ ipcMain: any, pageOrigin(event: any): string | null, link: { directSetting(origin: string): unknown, setDirect(origin: string, on: boolean): Promise<unknown> } }} deps
 */
export function installLinkDirectIpc({ ipcMain, pageOrigin, link }) {
  ipcMain.handle("link-direct:state", (event) => {
    const origin = pageOrigin(event);
    return origin ? link.directSetting(origin) : null;
  });
  ipcMain.handle("link-direct:set", (event, on) => {
    const origin = pageOrigin(event);
    if (!origin) throw new Error("This page cannot change the connection.");
    return link.setDirect(origin, on === true);
  });
}

/**
 * @param {{
 *   ipcMain: any, guard(channel: string, handler: Function): Function, userData: string, session: any, shell: any,
 *   encryption: { available(): Promise<boolean>, encrypt(text: string): Promise<Buffer>, decrypt(value: Buffer): Promise<string | { result: string }> },
 *   jsonFile(file: string): { read(): unknown, write(value: unknown): void },
 *   environments(): any, persist(next: any): void, withEnvironment: Function, makeId(): string, forgetEnvironment(id: string, how?: { replaced?: boolean }): unknown,
 *   ownHome: any, localRequest(route: string, init?: RequestInit): Promise<Response>, switchTo(id: string): unknown, relaunch(): void,
 *   dataDir(): string | null, label(): string, tell(view: unknown): void, log(line: string): void, base?: string,
 *   powerMonitor?: { on(event: string, listener: () => void): unknown, isOnBatteryPower?(): boolean },
 *   powerSaveBlocker?: { start(type: string): number, stop(id: number): void, isStarted(id: number): boolean },
 *   pageOrigin?(event: any): string | null,
 *   appVersion?: string,
 *   linkGrant?(): Promise<string | null>,
 *   signIn?(): Promise<unknown>,
 *   screenIce?(): Promise<Array<{ urls: string[], username?: string, credential?: string }> | null>,
 *   myCloud?(): string | null,
 *   cloudAwake?(): boolean,
 *   clean?: { holding<T>(work: () => Promise<T>): Promise<T> } | null,
 * }} deps `clean`: this computer's clean workspace; bots brought back go into its own copy.
 */
// the home has no tunnel node to ask for this computer's public address, so the dialer goes by the interfaces alone
export function homeEgressEndpoint(tunnel, awake = null) {
  return createEgressEndpoint({ ...tunnel, dialer: createEgressDialer(), ...(awake ? { onUse: awake.touch } : {}) });
}

export function installVpsLink(deps) {
  const { ipcMain, guard, userData, session, shell, encryption, jsonFile, log } = deps;
  const pins = createPins();
  let pinned = false;
  const backupsDir = path.join(userData, "vps-backups");
  const protect = async (text) => ((await encryption.available()) ? `e:${(await encryption.encrypt(text)).toString("base64")}` : `p:${text}`);
  const unprotect = unprotectWith(encryption);
  const ownHomeFiles = ["own-home.json", "own-home-choice.json", "own-home-send.json"].map((name) => jsonFile(path.join(userData, name)));

  const base = (deps.base || process.env.MADANI_LINK_BASE || DEFAULT_LINK_BASE).replace(/\/+$/, "");
  // the link service tells this computer the public address it connects from, so its home router stays out of reach
  // the linked server's bots reach this mac through the app's own session there (mac-control.mjs)
  // MADANI_LINK_KEEP_AWAKE=off lets this mac sleep even while its server's bots use it
  const awake = deps.powerSaveBlocker && process.env.MADANI_LINK_KEEP_AWAKE !== "off"
    ? createLinkAwake({ blocker: deps.powerSaveBlocker, onBattery: () => deps.powerMonitor?.isOnBatteryPower?.() === true, log })
    : null;
  const execute = createMacExecutor({ log });
  const macHost = process.env.MADANI_MAC_CONTROL === "off" ? null
    : createMacControlHost({ fetch: (...args) => session.defaultSession.fetch(...args), name: deps.label, execute: (job, io) => (awake ? awake.busy(execute(job, io)) : execute(job, io)), log });
  const followMac = (view) => macHost?.follow(view?.server?.origin ?? null);
  const link = createVpsLink({
    base,
    appVersion: deps.appVersion,
    linkGrant: deps.linkGrant,
    // not signed in to an account: the sign-in continues in the browser and the line is made once it is done
    ...(deps.signIn ? { signIn: deps.signIn } : {}),
    screenIce: deps.screenIce,
    // the home's public address comes from the tunnel's own node, over the relay's own connection (vps-link-protocol.mjs)
    egress: (tunnel) => createEgressEndpoint({ ...tunnel, dialer: createEgressDialer({ seenAs: seenAsCache(tunnel.seenAs, { log }) }), ...(awake ? { onUse: awake.touch } : {}) }),
    serverFetch: (...args) => session.defaultSession.fetch(...args),
    // setup sessions through chromium's network (the system proxy included); the relay's own connections ask chromium
    // which proxy it would use and tunnel through it
    fetch: (...args) => session.defaultSession.fetch(...args),
    proxy: async (url) => proxyFromPac(await session.defaultSession.resolveProxy(String(url))),
    store: jsonFile(path.join(userData, "vps-link.json")),
    protect, unprotect,
    label: deps.label,
    saveServer({ origin, name }) {
      const next = deps.withEnvironment(deps.environments(), { origin, name }, deps.makeId);
      deps.persist(next);
      return next.environments.find((entry) => entry.origin === origin)?.id;
    },
    forgetServer: (id, how) => deps.forgetEnvironment(id, how),
    retarget(from, to) {
      const state = deps.environments();
      deps.persist({ ...state, environments: state.environments.map((entry) => (entry.origin === from ? { ...entry, origin: to } : entry)) });
      const choice = ownHomeFiles[1], chosen = choice.read();
      if (chosen?.origin === from) choice.write({ ...chosen, origin: to });
    },
    rehome(from, to) {
      const choice = ownHomeFiles[1], chosen = choice.read();
      if (chosen?.id === from) choice.write({ ...chosen, id: to.id, origin: to.origin });
    },
    switchTo: deps.switchTo,
    pin(host, spki) {
      pins.add(host, spki);
      if (!pinned) { pinned = true; session.defaultSession.setCertificateVerifyProc((request, callback) => pins.verify(request, callback)); }
    },
    ownHome: deps.ownHome,
    places: () => deps.environments().environments ?? [],
    who: (place) => serverRequests(place, (...args) => session.defaultSession.fetch(...args)).who(),
    ...(deps.clean ? { holding: (work) => deps.clean.holding(work) } : {}),
    ownHomeReset: () => { for (const file of ownHomeFiles) { try { file.write(null); } catch (error) { log(`vps link: could not reset the move record (${error?.message ?? error})`); } } },
    localRequest: deps.localRequest,
    backups: {
      async save(name, body) {
        await fsp.mkdir(backupsDir, { recursive: true, mode: 0o700 });
        const file = path.join(backupsDir, path.basename(name));
        await pipeline(body instanceof Uint8Array ? Readable.from([body]) : Readable.fromWeb(body), createWriteStream(file, { flags: "wx", mode: 0o600 }));
        return { file, bytes: statSync(file).size };
      },
      async open(file) {
        if (path.dirname(file) !== backupsDir) throw new Error("That backup is not one this app saved.");
        return { body: createReadStream(file), size: statSync(file).size };
      },
    },
    localCredentials: {
      async codexAuth() {
        const file = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json");
        try { const text = readFileSync(file, "utf8"); JSON.parse(text); return text; } catch { return null; }
      },
      async claudeCli() {
        const response = await deps.localRequest("/api/cli-candidates?name=claude");
        const body = await response.json().catch(() => ({}));
        return Array.isArray(body?.candidates) && typeof body.candidates[0] === "string" ? body.candidates[0] : null;
      },
      claudeToken: (cli, signal) => claudeSetupToken(cli, signal),
    },
    relaunch: deps.relaunch,
    dataSize: async () => { const dir = deps.dataDir(); return dir ? folderSize(dir) : null; },
    // the direct path to a relay-linked server, over ssh or https on 443, then the cloud relay (vps-link-direct.mjs); MADANI_LINK_DIRECT=off keeps every link on the relay
    ...(process.env.MADANI_LINK_DIRECT === "off" ? {} : { direct: { newKey: newDirectKey, connector: sshConnector, wssConnector, cloud: { url: cloudRelayUrl(), connector: cloudConnector, register: cloudRegister }, rtc: rtcWay(deps.screenIce) } }),
    onChange: (view) => { deps.tell(view); followMac(view); },
    log,
  });

  const handlers = {
    state: () => link.view(),
    start: () => link.start(),
    cancel: () => link.cancel(),
    reset: () => link.reset(),
    engines: () => link.engines(),
    signIn: (_event, id) => link.signIn(String(id)),
    signInStatus: (_event, id, flowId) => link.signInStatus(String(id), String(flowId)),
    signInCode: (_event, id, flowId, code) => link.signInCode(String(id), String(flowId), String(code)),
    signInCancel: (_event, id, flowId) => link.signInCancel(String(id), String(flowId)),
    async openUrl(_event, url) {
      const parsed = new URL(String(url));
      if (parsed.protocol !== "https:") throw new Error("Only https links open from here.");
      await shell.openExternal(parsed.href);
    },
    preview: () => link.preview(),
    move: () => link.move(),
    retryMove: () => link.retryMove(),
    open: () => link.open(),
    async where() {
      const where = link.where();
      if (where.place !== "mac") return where;
      const { places, blocked } = await link.bringSources().catch(() => ({ places: [], blocked: null }));
      return places.length ? { ...where, bring: places, ...(blocked ? { blocked } : {}) } : where;
    },
    backups: () => link.backups(),
    backupNow: () => link.backupNow(),
    restore: (_event, id) => link.restore(String(id)),
    moveBack: (_event, placeId) => link.moveBack(typeof placeId === "string" ? placeId : undefined),
    forget: () => link.forget(),
  };
  for (const method of METHODS) ipcMain.handle(`vps-link:${method}`, guard(`vps-link:${method}`, handlers[method]));
  installLinkDirectIpc({ ipcMain, pageOrigin: deps.pageOrigin ?? (() => null), link });
  let stopNetwork = () => {}, closedLink = false;
  // safeStorage only works once electron is ready, and every saved tunnel key needs it
  void (deps.whenReady?.() ?? Promise.resolve()).then(() => {
    // a wake or an unlocked screen: sockets may be dead, so the tunnels reconnect now instead of after their timeouts
    // (powerMonitor only works once electron is ready)
    for (const event of ["resume", "unlock-screen"]) deps.powerMonitor?.on(event, () => link.nudge());
    // and a network switch with the lid open: the same, without waiting for the dead connections to time out
    if (!closedLink) stopNetwork = watchNetwork(() => link.nudge());
    for (const event of ["on-ac", "on-battery"]) deps.powerMonitor?.on(event, () => awake?.check());
    return link.resume();
  }).then(() => followMac(link.view())).catch((error) => log(`vps link: ${error?.message ?? error}`));
  // the person's madani cloud home (My Cloud) has no link agent: it gets this computer's connection over its own https,
  // for the sites that block it, while it is awake (home-egress-link.mjs)
  const homeEgress = deps.myCloud && process.env.MADANI_HOME_EGRESS !== "off" ? createHomeEgressLink({
    origin: () => deps.myCloud?.() ?? null,
    awake: () => deps.cloudAwake?.() !== false,
    cookie: async (origin) => {
      const cookies = await session.defaultSession.cookies.get({ url: origin }).catch(() => []);
      return cookies.length ? cookies.map((one) => `${one.name}=${one.value}`).join("; ") : null;
    },
    connect: (url, headers) => wssConnector({ url, spki: null, headers, via: "home",
      proxy: async (target) => proxyFromPac(await session.defaultSession.resolveProxy(String(target))) })(),
    endpoint: (tunnel) => homeEgressEndpoint(tunnel, awake),
    log,
  }) : null;
  const closeLink = link.close;
  link.close = () => { closedLink = true; stopNetwork(); macHost?.close(); homeEgress?.close(); awake?.close(); return closeLink(); };
  return link;
}
