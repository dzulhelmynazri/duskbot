// Parts of the desktop app its installer leaves out (today the bots' built-in browser): the app fetches them in the
// background on its first open, so they are here before a bot needs one. Nothing downloaded is used until it matches
// the size and SHA-256 that Resources/parts.json pins, a file inside the signed app, and on a Mac until every Mach-O in it
// carries a valid signature from the app's own Developer ID team. A part a bot needs before it is here is waited for.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";

export const PARTS_FILE = "parts.json";
const READY_FILE = ".ready";
const DOWNLOADS = ".downloads";

export type PartName = "browser";
export interface PartSpec {
  name: PartName;
  /** what is inside, independent of the release: the same id in a later app reuses the unpacked part */
  id: string;
  /** PLATFORM-ARCH the part was built for */
  target: string;
  url: string;
  bytes: number;
  sha256: string;
  /** the Developer ID team every Mach-O in it is signed by; null in an ad-hoc (unsigned) build */
  teamId: string | null;
}
export interface PartsManifest { v: 1; parts: PartSpec[] }

const NAMES = new Set<PartName>(["browser"]);

/** Throws on anything but a well-formed manifest: a bad one is a broken build, never a part to fetch. */
export function parsePartsManifest(value: unknown): PartsManifest {
  const manifest = value as Partial<PartsManifest> | null;
  if (!manifest || manifest.v !== 1 || !Array.isArray(manifest.parts)) throw new Error("parts.json is not a v1 parts manifest");
  const seen = new Set<string>();
  for (const part of manifest.parts) {
    const ok = part && NAMES.has(part.name) && !seen.has(part.name)
      && typeof part.id === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(part.id) && !part.id.startsWith(".")
      && typeof part.target === "string" && /^[a-z0-9]+-[a-z0-9]+$/.test(part.target)
      && typeof part.url === "string" && /^https:\/\/[^\s]+$/.test(part.url)
      && Number.isSafeInteger(part.bytes) && part.bytes > 0
      && typeof part.sha256 === "string" && /^[0-9a-f]{64}$/.test(part.sha256)
      && (part.teamId === null || (typeof part.teamId === "string" && /^[A-Z0-9]{10}$/.test(part.teamId)));
    if (!ok) throw new Error(`parts.json has an invalid part: ${JSON.stringify(part?.name ?? null)}`);
    seen.add(part.name);
  }
  return { v: 1, parts: manifest.parts.map((part) => ({ ...part })) };
}

/** The manifest the packaged app ships, or null in a source checkout or a build that bundles everything. */
export function readPartsManifest(env: NodeJS.ProcessEnv = process.env): PartsManifest | null {
  const resources = env.MADANI_RESOURCES_PATH;
  if (!resources) return null;
  const file = join(resolve(resources), PARTS_FILE);
  if (!existsSync(file)) return null;
  return parsePartsManifest(JSON.parse(readFileSync(file, "utf8")));
}

/** Shared by every workspace of this app (Start fresh keeps them): beside its user data, not in a workspace. */
export function partsRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.MADANI_PARTS_DIR?.trim();
  if (explicit) return resolve(explicit);
  const userData = env.MADANI_USER_DATA?.trim();
  return userData ? join(resolve(userData), "parts") : null;
}

export function partDirectory(root: string, part: Pick<PartSpec, "name" | "id">): string {
  return join(root, part.name, part.id);
}

/** Unpacked and checked: the ready marker names the archive it came from. */
export function partInstalled(root: string, part: PartSpec): boolean {
  try { return readFileSync(join(partDirectory(root, part), READY_FILE), "utf8").trim() === part.id; }
  catch { return false; }
}

let cached: { key: string; manifest: PartsManifest | null } | null = null;
/** For lookups on request paths: what this app declares for `name`, and where it lives once here. */
export function declaredPart(name: PartName, env: NodeJS.ProcessEnv = process.env): { part: PartSpec; root: string; directory: string; installed: boolean } | null {
  const key = `${env.MADANI_RESOURCES_PATH ?? ""}\0${env.MADANI_PARTS_DIR ?? ""}\0${env.MADANI_USER_DATA ?? ""}`;
  if (cached?.key !== key) {
    let manifest: PartsManifest | null = null;
    try { manifest = readPartsManifest(env); } catch (error) { console.warn(`app parts: ${(error as Error).message}`); }
    cached = { key, manifest };
  }
  const part = cached.manifest?.parts.find((candidate) => candidate.name === name);
  const root = partsRoot(env);
  if (!part || !root) return null;
  return { part, root, directory: partDirectory(root, part), installed: partInstalled(root, part) };
}

export interface PartProgress { phase: "download" | "setup"; received: number; total: number }

/** Resumes a partial download with a Range request; the whole file must then match the pinned size and SHA-256. */
export async function downloadPart(part: PartSpec, options: {
  root: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: PartProgress) => void;
  /** a connection that sends nothing for this long is given up, so a waiting turn is never stuck on it */
  stallMs?: number;
  /** where to fetch it from this time: one of `partSources(part.url)` */
  url?: string;
}): Promise<string> {
  const stall = new AbortController();
  const stallMs = options.stallMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(new Error(`the ${part.name} download stalled`)), stallMs); timer.unref?.(); };
  const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
  alive();
  try { return await fetchPart(part, { ...options, signal, alive }); }
  catch (error) { throw stall.signal.aborted ? stall.signal.reason : error; }
  finally { clearTimeout(timer); }
}

async function fetchPart(part: PartSpec, options: {
  root: string;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
  alive: () => void;
  onProgress?: (progress: PartProgress) => void;
  url?: string;
}): Promise<string> {
  const directory = join(options.root, DOWNLOADS);
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${part.sha256}.zip`);
  let have = await stat(file).then((info) => info.size, () => 0);
  if (have > part.bytes) { await rm(file, { force: true }); have = 0; }
  options.onProgress?.({ phase: "download", received: have, total: part.bytes });
  if (have < part.bytes) {
    const response = await (options.fetchImpl ?? fetch)(options.url ?? part.url, {
      redirect: "follow",
      signal: options.signal,
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
    });
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
      if (!range || Number(range[1]) !== have) throw new Error(`the ${part.name} download resumed at the wrong place`);
    } else if (response.status === 200) {
      have = 0;
    } else {
      throw new Error(`the ${part.name} download failed (HTTP ${response.status})`);
    }
    if (!response.body) throw new Error(`the ${part.name} download had no body`);
    const handle = await open(file, have === 0 ? "w" : "a");
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        if (have + chunk.byteLength > part.bytes) throw new Error(`the ${part.name} download is larger than its pinned size`);
        await handle.write(chunk);
        have += chunk.byteLength;
        options.alive();
        options.onProgress?.({ phase: "download", received: have, total: part.bytes });
      }
    } finally {
      await handle.close();
    }
  }
  if (have !== part.bytes) throw new Error(`the ${part.name} download stopped early`);
  options.onProgress?.({ phase: "setup", received: part.bytes, total: part.bytes });
  if (await fileSha256(file) !== part.sha256) {
    await rm(file, { force: true });
    throw new Error(`the ${part.name} download failed its SHA-256 check; nothing was installed`);
  }
  return file;
}

export function fileSha256(file: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", fail).on("end", () => done(hash.digest("hex")));
  });
}

type Run = (file: string, args: string[]) => Promise<{ code: number; output: string }>;
const run: Run = (file, args) => new Promise((done) => {
  execFile(file, args, { encoding: "utf8", timeout: 300_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: `${stdout}${stderr}` });
  });
});

/** ditto keeps the signatures' extended attributes and the vendor's symlinks; Windows has bsdtar, Linux unzip. */
export function extractCommand(archive: string, into: string, platform: NodeJS.Platform = process.platform, systemRoot = process.env.SystemRoot ?? "C:\\Windows") {
  if (platform === "darwin") return { file: "/usr/bin/ditto", args: ["-x", "-k", archive, into] };
  if (platform === "win32") return { file: win32.join(systemRoot, "System32", "tar.exe"), args: ["-xf", archive, "-C", into] };
  return { file: "unzip", args: ["-q", archive, "-d", into] };
}

const MACHO = new Set(["feedfacf", "cffaedfe", "cafebabe", "bebafeca", "feedface", "cefaedfe"]);
async function machOFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await machOFiles(path));
    else if (entry.isFile()) {
      const handle = await open(path, "r");
      try {
        const head = Buffer.alloc(4);
        const { bytesRead } = await handle.read(head, 0, 4, 0);
        if (bytesRead === 4 && MACHO.has(head.toString("hex"))) found.push(path);
      } finally { await handle.close(); }
    }
  }
  return found;
}

/** Every Mach-O must pass codesign's strict check, and in a signed build carry the app's team: what Gatekeeper and the
 * hardened runtime would ask of it, checked before anything runs. */
export async function verifyMacSignatures(directory: string, teamId: string | null, exec: Run = run): Promise<number> {
  const files = await machOFiles(directory);
  if (files.length === 0) throw new Error("the part has no signed executables");
  const requirement = teamId ? [`--test-requirement==anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`] : [];
  for (const file of files) {
    const result = await exec("/usr/bin/codesign", ["--verify", "--strict", ...requirement, file]);
    if (result.code !== 0) throw new Error(`a file in the part failed its signature check: ${result.output.trim().split("\n").slice(-1)[0] ?? ""}`);
  }
  return files.length;
}

/** Unpacks a verified archive beside the final place and only then renames it in; a second app process that got
 * there first wins and this copy is dropped. */
export async function installPart(part: PartSpec, archive: string, options: {
  root: string;
  platform?: NodeJS.Platform;
  exec?: Run;
  check?: (directory: string) => void | Promise<void>;
}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? run;
  const parent = join(options.root, part.name);
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, ".unpack-"));
  const destination = partDirectory(options.root, part);
  try {
    const command = extractCommand(archive, scratch, platform);
    const result = await exec(command.file, command.args);
    if (result.code !== 0) throw new Error(`the ${part.name} part did not unpack: ${result.output.trim().split("\n").slice(-1)[0] ?? result.code}`);
    if (platform === "darwin") await verifyMacSignatures(scratch, part.teamId, exec);
    await options.check?.(scratch);
    await writeFile(join(scratch, READY_FILE), `${part.id}\n`);
    if (existsSync(destination)) {
      if (partInstalled(options.root, part)) return destination;
      await rm(destination, { recursive: true, force: true });
    }
    await rename(scratch, destination);
    await rm(archive, { force: true });
    await pruneOtherIds(parent, part.id);
    return destination;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Earlier versions of this part (another app version's) go once a newer one is in place. */
async function pruneOtherIds(parent: string, keep: string): Promise<void> {
  for (const name of await readdir(parent).catch(() => [] as string[])) {
    if (name === keep || name.startsWith(".")) continue;
    await rm(join(parent, name), { recursive: true, force: true }).catch(() => {});
  }
}

export type PartState =
  | { phase: "waiting" }
  | { phase: "download" | "setup"; received: number; total: number }
  | { phase: "ready"; directory: string }
  | { phase: "failed"; error: string; received: number; total: number };

/** Tries after a failure: soon, then less often; offline it keeps trying every ten minutes. */
export const PART_RETRY_MS = [5_000, 30_000, 120_000, 600_000];

const DOWNLOADS_PART = /^https:\/\/github\.com\/MadaniBotAI\/madanibot-releases\/releases\/download\/v(\d+\.\d+\.\d+)\/(MadaniBot-\1-[A-Za-z0-9_.-]+\.zip)$/;
/** where a part can come from, tried in turn after each failure: its pinned url, then madani.bot's copy of a downloads-repo
 * part (scripts/mirror-release.sh puts it there). either is checked against the same pinned size and SHA-256 */
export function partSources(url: string): string[] {
  const match = DOWNLOADS_PART.exec(url);
  return match ? [url, `https://madani.bot/releases/${match[1]}/${match[2]}`] : [url];
}

export interface PartsDownloader {
  start(): void;
  state(name: PartName): PartState | null;
  /** true once ready; false when the current try fails (the next one is already scheduled) */
  ready(name: PartName): Promise<boolean>;
  /** a person asked: try again now rather than at the next scheduled retry */
  retry(name: PartName): void;
  stop(): void;
}

export function createPartsDownloader(options: {
  manifest: PartsManifest;
  root: string;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  exec?: Run;
  check?: (part: PartSpec, directory: string) => void | Promise<void>;
  onChange?: (name: PartName, state: PartState) => void;
  log?: (line: string) => void;
  retryMs?: readonly number[];
}): PartsDownloader {
  const delays = options.retryMs ?? PART_RETRY_MS;
  const states = new Map<PartName, PartState>();
  const waiters = new Map<PartName, Array<(ok: boolean) => void>>();
  const running = new Set<PartName>();
  const timers = new Map<PartName, ReturnType<typeof setTimeout>>();
  const failures = new Map<PartName, number>();
  const controller = new AbortController();
  let stopped = false;

  for (const part of options.manifest.parts) {
    states.set(part.name, partInstalled(options.root, part) ? { phase: "ready", directory: partDirectory(options.root, part) } : { phase: "waiting" });
  }
  const set = (name: PartName, state: PartState) => {
    states.set(name, state);
    options.onChange?.(name, state);
    if (state.phase === "ready" || state.phase === "failed") {
      const list = waiters.get(name) ?? [];
      waiters.delete(name);
      for (const resolve of list) resolve(state.phase === "ready");
    }
  };

  async function attempt(part: PartSpec): Promise<void> {
    if (stopped || running.has(part.name)) return;
    clearTimeout(timers.get(part.name));
    timers.delete(part.name);
    running.add(part.name);
    let last: PartProgress = { phase: "download", received: 0, total: part.bytes };
    try {
      options.log?.(`app parts: getting ${part.name} ${part.id} (${Math.round(part.bytes / 1024 / 1024)} MB, digest pinned)`);
      const sources = partSources(part.url);
      const archive = await downloadPart(part, {
        root: options.root, fetchImpl: options.fetchImpl, signal: controller.signal, url: sources[(failures.get(part.name) ?? 0) % sources.length],
        onProgress: (progress) => { last = progress; set(part.name, progress); },
      });
      const directory = await installPart(part, archive, {
        root: options.root, platform: options.platform, exec: options.exec,
        check: options.check ? (dir) => options.check!(part, dir) : undefined,
      });
      failures.delete(part.name);
      options.log?.(`app parts: ${part.name} is ready`);
      set(part.name, { phase: "ready", directory });
    } catch (error) {
      if (stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      const count = (failures.get(part.name) ?? 0) + 1;
      failures.set(part.name, count);
      const delay = delays[Math.min(count - 1, delays.length - 1)] ?? 600_000;
      const timer = setTimeout(() => { begin(part); }, delay);
      timer.unref?.();
      timers.set(part.name, timer);
      options.log?.(`app parts: ${part.name} failed (${message}); trying again in ${Math.round(delay / 1000)} s`);
      set(part.name, { phase: "failed", error: message, received: last.received, total: part.bytes });
    } finally {
      running.delete(part.name);
    }
  }

  function begin(part: PartSpec): void {
    attempt(part).catch((error: unknown) => {
      try { options.log?.(`app parts: ${part.name} attempt broke: ${error instanceof Error ? error.message : String(error)}`); } catch {}
    });
  }

  const find = (name: PartName) => options.manifest.parts.find((part) => part.name === name);
  return {
    start() {
      for (const part of options.manifest.parts) if (states.get(part.name)?.phase !== "ready") begin(part);
    },
    state: (name) => states.get(name) ?? null,
    ready(name) {
      const part = find(name);
      const state = states.get(name);
      if (!part || !state) return Promise.resolve(false);
      if (state.phase === "ready") return Promise.resolve(true);
      // a bot needs it now: a failed part is tried again at once rather than at its next retry
      if (!running.has(name)) begin(part);
      return new Promise((resolve) => { waiters.set(name, [...(waiters.get(name) ?? []), resolve]); });
    },
    retry(name) {
      const part = find(name);
      if (part && states.get(name)?.phase !== "ready") begin(part);
    },
    stop() {
      stopped = true;
      controller.abort();
      for (const timer of timers.values()) clearTimeout(timer);
      for (const [, list] of waiters) for (const resolve of list) resolve(false);
      waiters.clear();
    },
  };
}
