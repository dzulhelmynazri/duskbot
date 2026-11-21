// A server that "Add your VPS" installed runs on the VPS itself: its bots' VPS computers live on this machine's own
// Docker (the install gave the service user the docker group, gVisor and the host fence), with no SSH in between.
import { LEGACY } from "../electron/legacy-names.mjs";
import { independentScreenExecArgs, isManagedScreenViewerPort, type IndependentScreenTarget } from "./shared-desktop-screens.ts";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** The VPS alias that means this server's own Docker; only on a linked VPS, anywhere else it is an ordinary SSH alias. */
export const THIS_SERVER_VPS = "this-server";

const RECHECK_MS = 10_000;
let known: { at: number; value: boolean } | null = null;

/** MADANI_VPS_DOCKER=local forces it on, =ssh off; otherwise the link agent's tunnel file on Linux says so. */
export function detectThisServerVps(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = env.HOME || homedir(),
): boolean {
  if (env.MADANI_VPS_DOCKER === "local") return true;
  if (env.MADANI_VPS_DOCKER === "ssh" || platform !== "linux") return false;
  return ["madanibot-link", LEGACY.linkConfigDir].some((dir) => existsSync(join(home, ".config", dir, "tunnel.json")));
}

/** Rechecked every few seconds: the link step writes the tunnel file after the server first starts. */
export function vpsIsThisServer(now = Date.now()): boolean {
  const forced = process.env.MADANI_VPS_DOCKER;
  if (forced === "local" || forced === "ssh") return forced === "local";
  if (!known || now - known.at >= RECHECK_MS) known = { at: now, value: detectThisServerVps() };
  return known.value;
}

export function isThisServerVps(alias: string | null | undefined): boolean {
  return alias === THIS_SERVER_VPS && vpsIsThisServer();
}

/** One loopback port that reaches a container's noVNC: an SSH forward to a remote VPS, or a socket pipe on this one. */
export interface ViewerLink {
  port: number;
  alive(): boolean;
  stop(): void;
}

/** This server's own Docker: the container's private bridge address is a hop away, so no SSH, just a pipe. */
export async function forwardViewer(
  privateIp: string,
  dial: (() => Socket) | undefined = undefined,
  remotePort = 6901,
): Promise<ViewerLink> {
  if (!/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(privateIp)) throw new Error("invalid VPS private container address");
  if (!isManagedScreenViewerPort(remotePort)) throw new Error("invalid VPS viewer port");
  const connect = dial ?? (() => createConnection({ host: privateIp, port: remotePort }));
  const sockets = new Set<Socket>();
  let open = true;
  const server = createServer((client) => {
    const upstream = connect();
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.once("error", () => socket.destroy());
      socket.once("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream).pipe(client);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // SAFETY: bound to an IPv4 TCP address, so Node returns AddressInfo, not a socket path.
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return {
    port,
    alive: () => open,
    stop: () => {
      if (!open) return;
      open = false;
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

// The bot's browser is the Chromium on its own desktop, so the person watches it on the Screen and takes control of the
// same window. Its DevTools port stays on the box's loopback (Chromium binds nothing else); each connection runs this as
// uid 1000 inside the box over `docker exec`, which also reopens Chromium when someone closed it. No port is published.
const BOX_CHROME_RELAY = `import os, socket, subprocess, sys, threading, time
def dial():
    try:
        return socket.create_connection(("127.0.0.1", 9222), 2)
    except OSError:
        return None
s = dial()
if s is None:
    controller = "/usr/local/bin/omb-screen"
    if os.path.exists(controller):
        try:
            subprocess.run([controller, "primary-browser-ensure"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=True)
        except (OSError, subprocess.SubprocessError):
            sys.exit(4)
    else:
        env = dict(os.environ, DISPLAY=":1", HOME="/home/cua", XDG_RUNTIME_DIR="/run/user/1000", DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus")
        subprocess.Popen(["chromium"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env=env)
    for _ in range(150):
        time.sleep(0.1)
        s = dial()
        if s is not None:
            break
if s is None:
    sys.exit(3)
s.settimeout(None)
def up():
    while True:
        data = os.read(0, 65536)
        if not data:
            break
        s.sendall(data)
    try:
        s.shutdown(socket.SHUT_WR)
    except OSError:
        pass
threading.Thread(target=up, daemon=True).start()
out = sys.stdout.buffer
while True:
    data = s.recv(65536)
    if not data:
        break
    out.write(data)
    out.flush()
`;
/** The validated container id reaches only that box's loopback Chromium through Docker exec. */
export function boxChromeExecArgs(containerId: string, screen?: IndependentScreenTarget): string[] {
  if (!/^[a-f0-9]{12,64}$/i.test(containerId)) throw new Error("invalid VPS container");
  if (screen) {
    const args = independentScreenExecArgs(containerId, "ensure", screen);
    return ["exec", "-i", "-u", "cua", containerId, "/usr/local/bin/omb-screen", "relay", ...args.slice(-3)];
  }
  return ["exec", "-i", "-u", "1000:1000", containerId, "python3", "-I", "-c", BOX_CHROME_RELAY];
}

/** A loopback CDP address for the Chromium inside one box: every connection is piped through its own `docker exec`. */
export async function boxChromeRelay(spawnRelay: () => ChildProcess, failed?: () => void): Promise<{ url: string; close: () => void }> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.setNoDelay(true);
    const child = spawnRelay();
    const drop = () => { client.destroy(); if (child.exitCode === null && !child.killed) child.kill("SIGTERM"); };
    client.once("error", drop);
    client.once("close", () => { sockets.delete(client); drop(); });
    child.once("error", () => { failed?.(); drop(); });
    child.once("close", code => { if (code !== null && code !== 0) failed?.(); drop(); });
    child.stdin?.on("error", drop);
    if (!child.stdin || !child.stdout) return drop();
    client.pipe(child.stdin);
    child.stdout.pipe(client);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // SAFETY: bound to an IPv4 TCP address, so Node returns AddressInfo, not a socket path.
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  server.unref();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => { server.close(); for (const socket of sockets) socket.destroy(); },
  };
}
