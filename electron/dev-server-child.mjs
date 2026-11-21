import net from "node:net";
import { UTILITY_NAMES } from "./utility-names.mjs";

// `pnpm dev:app` (MADANI_DEV_OWN_SERVER=1): a source checkout runs the harness as this app's own utility child, the way
// the packaged app does, so the local computer grant reaches it over the child's private port and nowhere else.
export const DEV_OWN_SERVER = "MADANI_DEV_OWN_SERVER";
const QUICK_EXIT_MS = 10_000;
const MAX_QUICK_EXITS = 5;

export function devOwnServerWanted(env, packaged) {
  return !packaged && env[DEV_OWN_SERVER] === "1";
}

/** Taken when something answers on the port or the port cannot be bound. */
export async function portTaken(port, host = "127.0.0.1") {
  const answers = await new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  if (answers) return true;
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(true));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(false)));
  });
}

export function devServerConflictMessage(port) {
  return `127.0.0.1:${port} already has a server on it, most likely a separate \`pnpm dev:server\`. ` +
    "That server is not this app's own child, so it cannot use This Mac, and the app will not attach to it.\n\n" +
    "Stop it and run `pnpm dev:app` again, or keep it and use `pnpm dev:desktop` (This Mac stays unavailable there).";
}

/** `fork(entry, args, options)` is Electron's utilityProcess.fork; `grant(proc, isCurrent)` hands a spawned child this
 * computer. A child that dies is started again; one that keeps dying right away stops after a few tries (`gaveUp`). */
export function createDevServerChild({
  fork, entry, env: startEnv, grant, taken = portTaken, port, conflict = () => {}, gaveUp = () => {}, log = () => {},
  restartDelayMs = 1_000, stopTimeoutMs = 6_500, now = Date.now,
}) {
  let env = startEnv;
  let current = null;
  /** Waiting on the next child to spawn (retarget). */
  let spawned = [];
  let exited = Promise.resolve();
  let stopping = false;
  let restartWanted = false;
  let quickExits = 0;
  let timer = null;

  const spawn = () => {
    timer = null;
    if (stopping) return;
    const proc = fork(entry, [], { env, stdio: "inherit", execArgv: ["--experimental-strip-types"], serviceName: UTILITY_NAMES.devServer });
    const startedAt = now();
    current = proc;
    let markExited;
    exited = new Promise((resolve) => { markExited = resolve; });
    proc.once("spawn", () => {
      log(`dev server pid=${proc.pid} port=${port}`);
      if (proc === current) grant(proc, (child) => child === current);
      const waiting = spawned; spawned = [];
      for (const done of waiting) done(proc === current);
    });
    proc.once("exit", (code) => {
      markExited();
      if (proc !== current) return;
      current = null;
      if (stopping) return;
      if (restartWanted) {
        restartWanted = false;
        quickExits = 0;
        spawn();
        return;
      }
      quickExits = now() - startedAt < QUICK_EXIT_MS ? quickExits + 1 : 0;
      log(`dev server exited code=${code}`);
      if (quickExits >= MAX_QUICK_EXITS) {
        gaveUp(quickExits);
        return;
      }
      timer = setTimeout(spawn, restartDelayMs);
    });
  };

  const child = Object.freeze({
    /** False when the port is already someone else's; nothing is started then. */
    async start() {
      if (await taken(port)) {
        conflict(port);
        return false;
      }
      spawn();
      return true;
    },
    /** Stops the running child and starts a fresh one, as after a server source change. */
    restart() {
      if (stopping) return;
      if (!current) {
        clearTimeout(timer);
        quickExits = 0;
        spawn();
        return;
      }
      restartWanted = true;
      current.kill();
    },
    /** The same restart with another environment (another data folder): true once the new child has spawned. */
    retarget(nextEnv) {
      if (stopping) return Promise.resolve(false);
      env = nextEnv;
      const next = new Promise((resolve) => { spawned.push(resolve); });
      child.restart();
      return next;
    },
    /** The environment the next child starts with. */
    env: () => env,
    current: () => current,
    async stop() {
      stopping = true;
      const waiting = spawned; spawned = [];
      for (const done of waiting) done(false);
      clearTimeout(timer);
      if (!current) return true;
      current.kill();
      let wait;
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => { wait = setTimeout(() => resolve(false), stopTimeoutMs); wait.unref?.(); }),
      ]);
      clearTimeout(wait);
      return stopped;
    },
  });
  return child;
}

/** Restarts on a change to server or shared source, tests aside, a moment after the last save. */
export function watchServerSource({ watch, dirs, restart, delayMs = 300 }) {
  let timer = null;
  const watchers = dirs.map((dir) => watch(dir, { recursive: true }, (_event, file) => {
    const name = String(file ?? "");
    if (!/\.(ts|mjs|js|json)$/.test(name) || /\.test\.|node-test/.test(name)) return;
    clearTimeout(timer);
    timer = setTimeout(restart, delayMs);
  }));
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
