export const BOOT_PROBE_FAST_INTERVAL_MS = 25;
export const BOOT_PROBE_FAST_WINDOW_MS = 5_000;
export const BOOT_PROBE_INTERVAL_MS = 500;

export const SERVER_BOOT_TIMEOUT_MS = 60_000;
export const SERVER_LISTENING_GRACE_MS = 180_000;
/** A child that has printed anything is alive and loading: on a slow PC its first start may need more than the boot
 * budget, and stopping it only makes the next one redo the same cold work. */
export const SERVER_STARTING_GRACE_MS = 120_000;
const LISTENING_LINE = "madanibot server on ";

export function listeningSignal() {
  let tail = "";
  let heard = false;
  let spoke = false;
  return {
    hear(chunk) {
      if (String(chunk).trim()) spoke = true;
      if (heard) return;
      const text = tail + chunk;
      tail = text.slice(-LISTENING_LINE.length);
      heard = text.includes(LISTENING_LINE);
    },
    heard: () => heard,
    spoke: () => spoke,
  };
}

/** @param {number} port @param {{ outcome: string, waitedMs?: number }} identity */
export function bootFailureMessage(port, identity) {
  if (identity.outcome === "exited") return `child on port ${port} exited before answering /api/health`;
  if (identity.outcome === "foreign-owner") return `port ${port} answered health checks from another process`;
  if (identity.outcome === "ready") return `child on port ${port} answered after it stopped being the current server`;
  return `child on port ${port} did not answer /api/health within ${Math.round((identity.waitedMs ?? 0) / 1000)}s`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   port: number,
 *   pid: () => number | undefined,
 *   bootTimeoutMs: number,
 *   isExited?: () => boolean,
 *   isListening?: () => boolean,
 *   listeningGraceMs?: number,
 *   isStarting?: () => boolean,
 *   startingGraceMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ outcome: "ready" | "foreign-owner" | "timeout" | "exited", latencyMs?: number, waitedMs?: number }>}
*/
export async function pollServerIdentity({
  port,
  pid,
  bootTimeoutMs,
  isExited = () => false,
  isListening = () => false,
  listeningGraceMs = 0,
  isStarting = () => false,
  startingGraceMs = 0,
  now = Date.now,
  sleep = defaultSleep,
  fetchImpl = globalThis.fetch,
}) {
  const startedAt = now();
  const deadline = () => startedAt + bootTimeoutMs + (isListening() ? listeningGraceMs : isStarting() ? startingGraceMs : 0);
  for (;;) {
    if (isExited()) return { outcome: "exited" };
    const remainingMs = Math.max(0, deadline() - now());
    if (remainingMs <= 0) return { outcome: "timeout", waitedMs: now() - startedAt };

    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch {
      const intervalMs =
        now() - startedAt < BOOT_PROBE_FAST_WINDOW_MS ? BOOT_PROBE_FAST_INTERVAL_MS : BOOT_PROBE_INTERVAL_MS;
      await sleep(Math.min(intervalMs, Math.max(1, deadline() - now())));
      continue;
    }
    const body = await res.json().catch(() => null);
    // Past the deadline a null body is a timeout, not another process answering.
    if (now() >= deadline()) return { outcome: "timeout", waitedMs: now() - startedAt };
    // Read now: Electron's utilityProcess sets proc.pid only on the async `spawn` event, so undefined is not our child.
    const expectedPid = pid();
    const identified =
      res.ok &&
      expectedPid !== undefined &&
      body?.app === "madanibot" &&
      body.pid === expectedPid &&
      body.static;
    if (!identified) return { outcome: "foreign-owner" };
    if (now() >= deadline()) return { outcome: "timeout", waitedMs: now() - startedAt };
    return { outcome: "ready", latencyMs: now() - startedAt };
  }
}
