// How far an AI's install has got, measured, never guessed: bytes received of a known total while it downloads, then
// "setup" while it unpacks and checks. An install that can't be measured reports nothing and the app shows elapsed time.
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface InstallProgress {
  phase: "download" | "setup";
  received: number;
  /** null while the total is not known yet */
  total: number | null;
}

export type ProgressSink = (progress: InstallProgress) => void;

/** The latest progress per instance, read by the app while its install request is open. */
export class InstallProgressBoard {
  private byId = new Map<string, InstallProgress & { at: number }>();
  sink(id: string): ProgressSink {
    return (progress) => { this.byId.set(id, { ...progress, at: Date.now() }); };
  }
  get(id: string): InstallProgress | null {
    const found = this.byId.get(id);
    return found ? { phase: found.phase, received: found.received, total: found.total } : null;
  }
  clear(id: string): void {
    this.byId.delete(id);
  }
}

export const installProgress = new InstallProgressBoard();

export function downloadMeter(total: number | null, sink: ProgressSink | undefined) {
  let received = 0;
  sink?.({ phase: "download", received: 0, total });
  return {
    add(bytes: number) {
      received += bytes;
      sink?.({ phase: "download", received: total === null ? received : Math.min(received, total), total });
    },
    setup() {
      sink?.({ phase: "setup", received: total ?? received, total });
    },
  };
}

/** Apparent size of every regular file under `dir` (links skipped); a file that vanishes mid-walk counts as nothing. */
export async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await treeBytes(path);
    else if (entry.isFile()) total += (await lstat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** `add <name> <version>` lines from `npm install --dry-run`: the exact packages npm would put on this computer. */
export function parseDryRun(output: string): Array<{ name: string; version: string }> {
  const added: Array<{ name: string; version: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 3 && parts[0] === "add" && parts[1] && parts[2]) added.push({ name: parts[1], version: parts[2] });
  }
  return added;
}

type Fetch = typeof fetch;

/** The unpacked size of each package from the registry, summed; any size that can't be read makes the total unknown
 * rather than short. */
export async function unpackedTotal(packages: ReadonlyArray<{ name: string; version: string }>, options: { registry?: string; fetchImpl?: Fetch; signal?: AbortSignal } = {}): Promise<number | null> {
  if (packages.length === 0 || packages.length > 400) return null;
  const registry = (options.registry ?? "https://registry.npmjs.org/").replace(/\/?$/, "/");
  const doFetch = options.fetchImpl ?? fetch;
  const sizeOf = async (name: string, version: string): Promise<number | "absent" | null> => {
    try {
      const response = await doFetch(`${registry}${name.replace("/", "%2f")}/${encodeURIComponent(version)}`, { signal: options.signal, headers: { accept: "application/json" } });
      if (response.status === 404) return "absent";
      if (!response.ok) return null;
      const body = await response.json() as { dist?: { unpackedSize?: unknown } };
      const size = body?.dist?.unpackedSize;
      return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null;
    } catch {
      return null;
    }
  };
  const names = [...new Set(packages.map((pkg) => pkg.name))];
  const sizes = await Promise.all(packages.map(async ({ name, version }) => {
    const own = await sizeOf(name, version);
    if (own !== "absent") return own;
    // npm prints an `npm:` alias by its local name, which the registry doesn't know; Codex names its platform builds
    // `@openai/codex-<platform>` as aliases of `@openai/codex@<version>-<platform>`.
    const real = names.filter((other) => other !== name && name.startsWith(`${other}-`)).sort((x, y) => y.length - x.length)[0];
    if (!real) return null;
    const aliased = await sizeOf(real, version);
    return typeof aliased === "number" ? aliased : null;
  }));
  if (sizes.some((size) => size === null)) return null;
  return (sizes as number[]).reduce((sum, size) => sum + size, 0);
}

export interface FolderWatch {
  /** npm finished writing: whatever comes next is setup. */
  setup(): void;
  stop(): void;
}

/** Watches `folder` grow from `baseline` toward a total that `total()` finds alongside the install. Until the total is
 * known nothing is reported; once the bytes reach it, the phase is setup. */
export function watchFolder(folder: string, baseline: number, total: Promise<number | null>, sink: ProgressSink, intervalMs = 750, measure: (dir: string) => Promise<number> = treeBytes): FolderWatch {
  let known: number | null = null;
  let stopped = false;
  let settingUp = false;
  let busy = false;
  void total.then((value) => { known = value && value > 0 ? value : null; }, () => {});
  const tick = async () => {
    if (busy || stopped || settingUp) return;
    busy = true;
    try {
      const grown = Math.max(0, (await measure(folder)) - baseline);
      if (stopped || settingUp || known === null) return;
      if (grown >= known * 0.995) {
        settingUp = true;
        sink({ phase: "setup", received: known, total: known });
      } else sink({ phase: "download", received: grown, total: known });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    setup() {
      if (stopped) return;
      settingUp = true;
      if (known !== null) sink({ phase: "setup", received: known, total: known });
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function emptyPrefix(platform: NodeJS.Platform = process.platform): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "madani-npm-plan-"));
  // npm 11 refuses a POSIX global prefix with no lib/ folder
  if (platform !== "win32") await mkdir(join(path, "lib"));
  return { path, remove: () => rm(path, { recursive: true, force: true }).catch(() => {}) };
}
