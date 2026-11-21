/** Runs one docker command (already aimed at the right host) with a hard deadline. */
export type DockerCall = (args: string[], timeoutMs: number) => Promise<{ stdout: string }>;

export const STOP_GRACE_SECONDS = 10;
const STOP_TIMEOUT_MS = (STOP_GRACE_SECONDS + 20) * 1000;
const KILL_TIMEOUT_MS = 20_000;
const INSPECT_TIMEOUT_MS = 10_000;
const REAPER_TIMEOUT_MS = 30_000;
const SETTLE_POLLS = 10;
const SETTLE_POLL_MS = 1_000;

export type ForcedStop = "stopped" | "killed" | "sandbox-killed";

const PID = /^\d+$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const notRunning = (error: unknown) => /is not running|no such container/i.test(message(error));

async function running(docker: DockerCall, containerId: string): Promise<{ running: boolean; pid: number; image: string }> {
  const { stdout } = await docker(["inspect", "--format", "{{.State.Running}} {{.State.Pid}} {{.Image}}", containerId], INSPECT_TIMEOUT_MS);
  const [state, pid, image] = stdout.trim().split(/\s+/);
  return { running: state === "true", pid: pid && PID.test(pid) ? Number(pid) : 0, image: image ?? "" };
}

/**
 * Stops a container even when its runtime no longer answers. Under gVisor (runsc) a sandbox at its memory cap can leave
 * `docker stop`, `docker kill` and `docker rm -f` hanging, while SIGKILL of the sandbox process on the host still frees it.
 * That last step runs a throwaway runc helper in the host PID namespace, from the stuck container's own image.
 */
export async function forceStopContainer(docker: DockerCall, containerId: string, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))): Promise<ForcedStop> {
  const failures: string[] = [];
  try {
    await docker(["stop", "--time", String(STOP_GRACE_SECONDS), containerId], STOP_TIMEOUT_MS);
    return "stopped";
  } catch (error) {
    if (notRunning(error)) return "stopped";
    failures.push(`stop: ${message(error)}`);
  }
  try {
    await docker(["kill", containerId], KILL_TIMEOUT_MS);
    return "killed";
  } catch (error) {
    if (notRunning(error)) return "killed";
    failures.push(`kill: ${message(error)}`);
  }
  const state = await running(docker, containerId);
  if (!state.running) return "killed";
  if (state.pid <= 1 || !IMAGE.test(state.image)) {
    throw Object.assign(new Error(`The computer did not stop and its process could not be found (${failures.join("; ")})`), { status: 503 });
  }
  await docker([
    "run", "--rm", "--runtime", "runc", "--pid", "host", "--userns", "host", "--privileged", "--network", "none", "--user", "0:0",
    "--label", "madani.role=sandbox-reaper", "--entrypoint", "sh", state.image, "-c", 'kill -9 "$1"', "sh", String(state.pid),
  ], REAPER_TIMEOUT_MS);
  for (let poll = 0; poll < SETTLE_POLLS; poll++) {
    if (!(await running(docker, containerId)).running) return "sandbox-killed";
    await sleep(SETTLE_POLL_MS);
  }
  throw Object.assign(new Error("The computer's sandbox was killed but Docker still reports it running"), { status: 503 });
}

export interface ContainerMemory {
  usedBytes: number;
  limitBytes: number;
  fraction: number;
  processes: number | null;
}

const UNITS: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };

function bytes(text: string): number | null {
  const match = /^([\d.]+)\s*([a-z]+)$/i.exec(text.trim());
  const unit = match ? UNITS[match[2]!.toLowerCase()] : undefined;
  return match && unit ? Number(match[1]) * unit : null;
}

/** `docker stats` MemUsage and PIDs columns, e.g. "7.18GiB / 7.2GiB" and "355". */
export function parseContainerMemory(line: string): ContainerMemory | null {
  const [usage, pids] = line.trim().split("\t");
  const [used, limit] = (usage ?? "").split("/").map(part => bytes(part));
  if (used == null || !limit) return null;
  const processes = pids && PID.test(pids.trim()) ? Number(pids.trim()) : null;
  return { usedBytes: used, limitBytes: limit, fraction: used / limit, processes };
}

const STATS_TIMEOUT_MS = 15_000;

export async function containerMemory(docker: DockerCall, containerId: string): Promise<ContainerMemory | null> {
  const { stdout } = await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}\t{{.PIDs}}", containerId], STATS_TIMEOUT_MS);
  return parseContainerMemory(stdout.split("\n")[0] ?? "");
}

/** Above this share of its memory limit a shared computer opens no new bot screen: each one starts its own browser. */
export const MEMORY_PRESSURE_FRACTION = 0.85;

const gb = (value: number) => (value / 1024 ** 3).toFixed(1);

export function outOfMemoryText(memory: ContainerMemory): string {
  return `The shared computer is out of memory (${gb(memory.usedBytes)} of ${gb(memory.limitBytes)} GB in use by the bots already on it), so this bot cannot open its own screen there now. ` +
    "It can start once another bot finishes, or restart the shared computer in Settings > Computers.";
}

/** Remembers each probe briefly: a burst of turns asks Docker once. A probe that fails reads as unknown, never as full. */
export function createMemoryGate(ttlMs = 15_000, now = Date.now) {
  const seen = new Map<string, { at: number; memory: Promise<ContainerMemory | null> }>();
  return {
    async pressure(containerId: string, probe: () => Promise<ContainerMemory | null>): Promise<ContainerMemory | null> {
      const cached = seen.get(containerId);
      const entry = cached && now() - cached.at < ttlMs ? cached : { at: now(), memory: probe().catch(() => null) };
      seen.set(containerId, entry);
      for (const [id, other] of seen) if (now() - other.at >= ttlMs && id !== containerId) seen.delete(id);
      const memory = await entry.memory;
      return memory && memory.fraction >= MEMORY_PRESSURE_FRACTION ? memory : null;
    },
    forget(containerId: string): void { seen.delete(containerId); },
  };
}
