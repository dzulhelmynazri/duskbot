// how many bot desktops one VPS keeps awake at once, and the limits each one runs under, so bots never take their host down.
import { DOCKER_NAMES } from "../electron/legacy-names.mjs";
import { totalmem } from "node:os";
import { isThisServerVps } from "./vps-local.ts";
import { MANAGED_VPS_CONTAINER_NAME, VPS_CONTAINER_LABEL, VPS_MANAGED_LABEL } from "./vps-managed-names.ts";

const GIB = 1024 ** 3;
/** the os, sshd, docker, this server and its engines keep this much whatever the bots do */
export const HOST_RESERVE_BYTES = 2.5 * GIB;
/** one bot desktop: xvfb, the cua driver and chromium with a few tabs */
export const DESKTOP_BYTES = 1.5 * GIB;
export const MAX_DESKTOPS = 20;
/** below the server and sshd: when memory runs out the kernel takes a desktop first */
export const DESKTOP_OOM_SCORE = 500;
/** host services win the cpu from desktops under contention (docker's default weight is 1024) */
export const DESKTOP_CPU_SHARES = 256;
const WAIT_MS = 30_000;
const POLL_MS = 3_000;
const MEMORY_TTL_MS = 10 * 60_000;
const ENVIRONMENT_LABEL = DOCKER_NAMES.label("environment");

export interface VpsDesktopLimits { memoryMb: number }
export type VpsDocker = (args: string[], timeoutMs?: number) => Promise<{ stdout: string }>;
export interface VpsCapacityHost {
  /** container names of the desktops this server's bots and team computers own now */
  owned(): Set<string>;
  /** puts the least recently used idle desktop among `awake` to sleep; true once one stopped */
  sleepLeastRecent(alias: string, awake: string[]): Promise<boolean>;
}

/** the server side: which desktops are its own, when each was last used, and how one is put to sleep */
export function createVpsCapacityHost(deps: {
  owners(): string[];
  containerName(ownerId: string): string;
  lastActivityAt(ownerId: string, alias: string): number;
  /** false when that desktop is in use or could not be stopped */
  sleep(ownerId: string, alias: string): Promise<boolean>;
}): VpsCapacityHost {
  const byName = () => new Map(deps.owners().map(owner => [deps.containerName(owner), owner]));
  return {
    owned: () => new Set(byName().keys()),
    async sleepLeastRecent(alias, awake) {
      const names = byName();
      const owners = awake.flatMap(name => names.has(name) ? [names.get(name)!] : [])
        .sort((left, right) => deps.lastActivityAt(left, alias) - deps.lastActivityAt(right, alias));
      for (const owner of owners) if (await deps.sleep(owner, alias)) return true;
      return false;
    },
  };
}

let host: VpsCapacityHost | null = null;
export function setVpsCapacityHost(next: VpsCapacityHost | null): void { host = next; }

/** MADANI_VPS_MAX_DESKTOPS overrides the memory rule for a host whose desktops are lighter or heavier than usual. */
export function desktopCapacity(memoryBytes: number, env: NodeJS.ProcessEnv = process.env): number {
  const forced = Number(env.MADANI_VPS_MAX_DESKTOPS);
  if (Number.isInteger(forced) && forced >= 1) return Math.min(MAX_DESKTOPS, forced);
  return Math.max(1, Math.min(MAX_DESKTOPS, Math.floor((memoryBytes - HOST_RESERVE_BYTES) / DESKTOP_BYTES)));
}

/** a bot's own desktop gets one desktop's share; a shared computer, whose screens are capped by the same rule, the whole budget */
export function desktopLimits(memoryBytes: number, shared: boolean): VpsDesktopLimits {
  const perDesktop = DESKTOP_BYTES / 1024 ** 2;
  return { memoryMb: shared ? Math.max(perDesktop, Math.floor((memoryBytes - HOST_RESERVE_BYTES) / 1024 ** 2)) : perDesktop };
}

export function desktopLimitArgs(limits: VpsDesktopLimits): string[] {
  const memory = `${limits.memoryMb}m`;
  return ["--memory", memory, "--memory-swap", memory, "--cpu-shares", String(DESKTOP_CPU_SHARES), "--oom-score-adj", String(DESKTOP_OOM_SCORE)];
}

/** a desktop made under the old 4 GB cap, or set to come back after a reboot, changes in place before it starts */
export function desktopUpdateArgs(containerRef: string, limits: VpsDesktopLimits): string[] {
  const memory = `${limits.memoryMb}m`;
  return ["update", "--memory", memory, "--memory-swap", memory, "--cpu-shares", String(DESKTOP_CPU_SHARES), "--restart", "no", containerRef];
}

const memoryByHost = new Map<string, { bytes: number; at: number }>();
export async function vpsHostMemory(alias: string, docker: VpsDocker, local: boolean): Promise<number> {
  const known = memoryByHost.get(alias);
  if (known && Date.now() - known.at < MEMORY_TTL_MS) return known.bytes;
  let bytes = local ? totalmem() : 0;
  try {
    const reported = Number((await docker(["info", "--format", "{{.MemTotal}}"], 20_000)).stdout.trim());
    if (Number.isSafeInteger(reported) && reported > 0) bytes = reported;
  } catch {}
  // unknown: assume a small 8 GB host rather than an unlimited one
  if (!bytes) return 8 * GIB;
  memoryByHost.set(alias, { bytes, at: Date.now() });
  return bytes;
}

/** read synchronously by the screen broker; a host never measured yet counts as 8 GB until it is */
export function knownScreenCapacity(alias: string | null): number {
  const bytes = alias ? memoryByHost.get(alias)?.bytes : undefined;
  return desktopCapacity(bytes ?? (isThisServerVps(alias) ? totalmem() : 8 * GIB));
}

export function resetVpsCapacityForTests(): void { memoryByHost.clear(); locks.clear(); host = null; }

interface AwakeDesktop { name: string; ours: boolean }
/** null when docker cannot list them: the start itself then reports what is wrong */
async function awakeDesktops(docker: VpsDocker, environmentId: string): Promise<AwakeDesktop[] | null> {
  try {
    const { stdout } = await docker(["ps", "--filter", `label=${VPS_MANAGED_LABEL}=1`, "--format", `{{.Names}}\t{{.Label "${ENVIRONMENT_LABEL}"}}\t{{.Label "${VPS_CONTAINER_LABEL}"}}`], 20_000);
    return stdout.split("\n").filter(Boolean).map(line => {
      const [name = "", environment = "", labelled = ""] = line.split("\t");
      // a renamed backup still uses memory, but is never ours to put to sleep
      const ours = (environment === "" || environment === environmentId) && MANAGED_VPS_CONTAINER_NAME.test(name) && labelled === name;
      return { name, ours };
    });
  } catch { return null; }
}

export function capacityFullError(cap: number, memoryBytes: number): Error {
  const gb = Math.round(memoryBytes / GIB);
  return Object.assign(new Error(`This VPS has room for ${cap} awake bot computer${cap === 1 ? "" : "s"} (${gb} GB of memory) and all of them are busy with other bots right now. Wait for one of those bots to finish, or put one to sleep from its Computer panel, then try again.`),
    { status: 503, code: "vps_capacity_full" });
}

const locks = new Map<string, Promise<void>>();
async function withHostLock<T>(alias: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(alias) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const chained = previous.then(() => current);
  locks.set(alias, chained);
  await previous;
  try { return await work(); }
  finally { release(); if (locks.get(alias) === chained) locks.delete(alias); }
}

/**
 * Starts one desktop only while the host has room for it. Starts on one host take turns, so two never both see the last
 * free place. At the cap a desktop left behind by a deleted bot sleeps first, then the least recently used idle one; when
 * every awake desktop is busy the start waits a little, then refuses in plain words.
 */
export async function admitVpsDesktop<T>(input: {
  alias: string; containerName: string; shared: boolean; local: boolean; environmentId: string; docker: VpsDocker;
  requireAllowed?: () => void; waitMs?: number; pollMs?: number;
}, start: (limits: VpsDesktopLimits) => Promise<T>): Promise<T> {
  return withHostLock(input.alias, async () => {
    const memory = await vpsHostMemory(input.alias, input.docker, input.local);
    const cap = desktopCapacity(memory);
    const deadline = Date.now() + (input.waitMs ?? WAIT_MS);
    for (;;) {
      input.requireAllowed?.();
      const awake = await awakeDesktops(input.docker, input.environmentId);
      const others = awake?.filter(desktop => desktop.name !== input.containerName);
      if (!others || others.length < cap) break;
      const owned = host?.owned() ?? new Set<string>();
      const orphan = others.find(desktop => desktop.ours && !owned.has(desktop.name));
      if (orphan && await input.docker(["stop", "--time", "10", orphan.name], 60_000).then(() => true, () => false)) continue;
      const mine = others.filter(desktop => desktop.ours && owned.has(desktop.name)).map(desktop => desktop.name);
      if (mine.length && await host?.sleepLeastRecent(input.alias, mine).catch(() => false)) continue;
      if (Date.now() >= deadline) throw capacityFullError(cap, memory);
      await new Promise(resolve => setTimeout(resolve, input.pollMs ?? POLL_MS));
    }
    return start(desktopLimits(memory, input.shared));
  });
}
