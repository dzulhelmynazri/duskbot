import path from "node:path";

import { MANAGED_COMPANION_ORIGIN_PORT } from "./companion-origin-gateway.mjs";
import { defaultCompanionDir } from "./legacy-names.mjs";
import { portTaken } from "./server-port.mjs";

/** The desktop app serves its own page on the first of these that is free; each has its own page storage. */
export const DESKTOP_PORTS = Object.freeze([8799, 18799, 28799]);

/** The packaged app's phone companion: phones paired over Wi-Fi keep this address whichever desktop port it opens on. */
export const COMPANION_PORT = 8810;

/**
 * The phone companion's two ports: the packaged app's on 8810 with its control port from 8811 up, a dev app's from its
 * harness + 11 up, past both of those, so `pnpm dev:app` (MADANI_PORT=8811 too) never takes the packaged app's. Never the
 * harness's port, its webhook's next to it, or the hosted connector's origin port.
 */
export function companionPorts(harnessPort, { packaged = true } = {}) {
  const taken = new Set([harnessPort, harnessPort + 1, MANAGED_COMPANION_ORIGIN_PORT, ...(packaged ? [] : [COMPANION_PORT, COMPANION_PORT + 1])]);
  const free = (from, also = -1) => {
    let port = from;
    while (taken.has(port) || port === also) port += 1;
    return port;
  };
  const companion = packaged ? COMPANION_PORT : free(harnessPort + 11);
  return { companion, control: free(companion + 1, companion) };
}

/**
 * The ports a companion launches on: its control port, which only main speaks to, moves on past one another program
 * holds (a dev app's harness on MADANI_PORT=8811 beside the packaged app), so it never keeps the companion from starting.
 */
export async function companionLaunchPorts(harnessPort, { packaged = true, taken = portTaken } = {}) {
  const ports = companionPorts(harnessPort, { packaged });
  const skip = new Set([ports.companion, harnessPort, harnessPort + 1, MANAGED_COMPANION_ORIGIN_PORT]);
  for (let port = ports.control, tries = 0; tries < 20; port += 1) {
    if (skip.has(port)) continue;
    tries += 1;
    if (!(await taken(port))) return { ...ports, control: port };
  }
  return ports;
}

/**
 * The packaged app's companion keeps the person's paired phones in the usual folder; a dev app's gets its own beside it,
 * since each companion holds its devices in memory and writes them whole, and would drop the other app's pairings.
 */
export function companionFolder({ home, harnessPort, packaged }) {
  const folder = defaultCompanionDir(home);
  return packaged ? folder : path.join(folder, `dev-${harnessPort}`);
}
