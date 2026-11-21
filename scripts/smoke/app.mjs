// The real-setup smoke's own copy of the desktop app: real Electron from a checkout, its own Vite (own port, own
// cacheDir), its own harness port, HOME, user data and data folder, mock keychain, every window hidden
// (electron-smoke-shim.cjs). Driven over the Chrome DevTools Protocol of its main window.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** the owner's running dev app and demo: never bound, never touched */
export const OWNER_PORTS = new Set([5199, 8799, 8800, 5299, 8899, 8900, 9335, 8810, 8811]);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const launched = new Set();
function killGroup(child, signal = "SIGKILL") {
  try { process.kill(-child.pid, signal); } catch {}
  try { child.kill(signal); } catch {}
}
/** every app this process started dies with it: normal exit, an error, Ctrl-C or a kill */
let trapped = false;
function trapExit() {
  if (trapped) return;
  trapped = true;
  process.once("exit", () => { for (const child of launched) killGroup(child); });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => { for (const child of launched) killGroup(child); process.exit(130); });
  process.once("uncaughtException", (error) => { for (const child of launched) killGroup(child); console.error(error); process.exit(1); });
}

export async function freePort() {
  for (;;) {
    const server = createNetServer();
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address();
    await new Promise((done) => server.close(done));
    if (!OWNER_PORTS.has(port) && !OWNER_PORTS.has(port + 1)) return port;
  }
}

export async function until(check, { timeout = 30_000, every = 300, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    await sleep(every);
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? ` (${last.message})` : ""}`);
}

export function connectCdp(url) {
  const socket = new WebSocket(url);
  let next = 0;
  const waiting = new Map();
  const listeners = new Set();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) { waiting.get(message.id)?.(message); waiting.delete(message.id); }
    else for (const listen of listeners) listen(message);
  };
  const ready = new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error("devtools socket failed")); });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++next;
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`${method} timed out`)); }, 60_000);
    waiting.set(id, (message) => { clearTimeout(timer); if (message.error) fail(new Error(`${method}: ${message.error.message}`)); else done(message.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description?.split("\n")[0] ?? reply.exceptionDetails.text);
    return reply.result?.value;
  };
  return { ready, send, evaluate, on: (listen) => listeners.add(listen), close: () => socket.close() };
}

/**
 * root: the checkout to run. profile: the smoke's own persistent folder (HOME, user data, data). env: extra environment.
 */
/** the shim's dry run (never-visible-check.mjs): a window told to show stays invisible and still paints. No app starts unless it passes. */
export async function neverVisibleCheck(root, profile) {
  const binary = createRequire(join(root, "package.json"))("electron");
  const events = join(profile, "never-visible.jsonl");
  rmSync(events, { force: true });
  mkdirSync(join(profile, "never-visible"), { recursive: true });
  const child = spawn(binary, ["-r", join(root, "scripts", "smoke", "electron-smoke-shim.cjs"), join(root, "scripts", "smoke", "never-visible-check.mjs"),
    `--user-data-dir=${join(profile, "never-visible")}`, "--use-mock-keychain", "--password-store=basic"],
  { cwd: root, env: { PATH: process.env.PATH, HOME: join(profile, "never-visible"), MADANI_SMOKE_EVENTS: events, MADANI_SMOKE_PROFILE: join(profile, "never-visible") }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  launched.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await Promise.race([new Promise((done) => child.once("exit", (exit) => done(exit))), sleep(60_000).then(() => "timeout")]);
  killGroup(child);
  launched.delete(child);
  const line = /never-visible (\{.*\})/.exec(output)?.[1];
  if (code !== 0) throw new Error(`the never-visible dry run failed (${code}): ${line ?? output.slice(-500)}`);
  return JSON.parse(line);
}

export async function launchSmokeApp({ root, profile, env: extra = {}, log: print = () => {} }) {
  trapExit();
  await neverVisibleCheck(root, profile);
  const home = join(profile, "home"), userData = join(profile, "electron"), dataDir = join(home, ".madanibot");
  for (const dir of [home, userData, dataDir]) mkdirSync(dir, { recursive: true });
  const eventsFile = join(profile, "events.jsonl");
  rmSync(eventsFile, { force: true });
  rmSync(join(profile, "links.txt"), { force: true });
  rmSync(join(userData, "DevToolsActivePort"), { force: true });
  const port = await freePort(), uiPort = await freePort(), webhookPort = await freePort();
  const requireFromRoot = createRequire(join(root, "package.json"));
  // vite.config.ts reads MADANI_PORT for its /api proxy when it loads
  process.env.MADANI_PORT = String(port);
  const { createServer } = await import(pathToFileURL(requireFromRoot.resolve("vite")).href);
  const vite = await createServer({
    root, configFile: join(root, "vite.config.ts"), logLevel: "error",
    // never the checkout's node_modules/.vite: that cache is the owner's running dev app's
    cacheDir: join(profile, "vite-cache"),
    server: { host: "127.0.0.1", port: uiPort, strictPort: true, hmr: false, fs: { allow: [root, realpathSync(join(root, "node_modules"))] } },
  });
  await vite.listen();
  let output = "";
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: join(profile, "tmp"), LANG: "en_US.UTF-8",
    MADANI_PORT: String(port), MADANI_WEBHOOK_PORT: String(webhookPort), MADANI_DATA_DIR: dataDir,
    MADANI_DEV_OWN_SERVER: "1", MADANI_DEV_SERVER_WATCH: "0", MADANI_NO_TEST_BOTS: "1",
    MADANI_CLOUD_STAGING: "1", MADANI_ERROR_REPORTS: "0", MADANI_ANALYTICS: "0",
    ELECTRON_START_URL: `http://127.0.0.1:${uiPort}`,
    MADANI_SMOKE_EVENTS: eventsFile, MADANI_SMOKE_LINKS: join(profile, "links.txt"), MADANI_SMOKE_PROFILE: profile, MADANI_LOG_DIR: join(profile, "app-paths", "logs"),
    ...extra,
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const binary = requireFromRoot("electron");
  const shim = join(root, "scripts", "smoke", "electron-smoke-shim.cjs");
  // its own process group, so teardown takes the app and every helper and harness child with it
  const child = spawn(binary, ["-r", shim, root, `--user-data-dir=${userData}`, "--remote-debugging-port=0", "--use-mock-keychain", "--password-store=basic"],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  launched.add(child);
  child.once("exit", () => launched.delete(child));
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (const stream of [child.stdout, child.stderr]) stream.on("error", () => {});
  const fail = async (error) => { killGroup(child); await vite.close().catch(() => {}); throw new Error(`${error.message}\n${output.slice(-2000)}`); };
  const portFile = join(userData, "DevToolsActivePort");
  try {
    await until(() => { if (child.exitCode !== null || child.signalCode) throw new Error(`the app exited (${child.exitCode ?? child.signalCode})`); return existsSync(portFile); }, { timeout: 90_000, what: "the app's devtools port" });
  } catch (error) { await fail(error); }
  const cdpPort = readFileSync(portFile, "utf8").split("\n")[0].trim();
  // the main window: not the rail, the ambient dock and island, or a floating panel
  const pageTarget = async (origin) => {
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    return targets.find((target) => target.type === "page" && /^https?:/.test(target.url) && !/^\/(?:rail|ambient|float|overlay|talk)/.test(new URL(target.url).pathname)
      && (!origin || new URL(target.url).origin === origin));
  };
  let target;
  try { target = await until(pageTarget, { timeout: 120_000, what: "the main window" }); } catch (error) { await fail(error); }
  let cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  print(`app up: ui ${uiPort}, harness ${port}, devtools ${cdpPort}`);

  const app = {
    root, profile, port, uiPort, cdpPort, eventsFile,
    output: () => output,
    /** hands a madanibot:// link to the app, as the OS does when a page opens one */
    openLink: (url) => appendFileSync(join(profile, "links.txt"), `${url}\n`),
    events: () => { try { return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } },
    /** windows the shim caught visible: any is a failure of the run */
    onScreen: () => app.events().filter((event) => event.kind === "visible"),
    targets: async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(),
    get cdp() { return cdp; },
    send: (...args) => cdp.send(...args),
    evaluate: (expression) => cdp.evaluate(expression),
    /** the main window navigated to another origin (a server's own page): reattach to whatever page it shows now */
    async reattach(origin) {
      target = await until(() => pageTarget(origin), { timeout: 60_000, what: `the main window${origin ? ` on ${origin}` : ""}` });
      cdp.close();
      cdp = connectCdp(target.webSocketDebuggerUrl);
      await cdp.ready;
      return target.url;
    },
    async screenshot(file) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      return file;
    },
    async close() {
      cdp.close();
      if (child.exitCode === null && !child.signalCode) {
        const exited = new Promise((done) => child.once("exit", done));
        killGroup(child, "SIGTERM");
        await Promise.race([exited, sleep(10_000)]);
      }
      killGroup(child, "SIGKILL");
      await vite.close();
    },
  };
  return app;
}
