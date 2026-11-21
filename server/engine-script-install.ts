// Security: the installer URL comes only from a driver's own install descriptor, never a request. It must be https, the
// script is fetched by this process (size-capped), saved to a private temp file and run with a fixed argv as this
// process's user, without sudo or a terminal, with stdin closed so a prompt ends the run instead of hanging it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { EngineInstall } from "./contracts.ts";
import { stripWorkspaceCredentialEnv } from "./config.ts";
import { augmentedPath, findCliCandidates, resetPathCache } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";

export interface ScriptInstaller {
  url: string;
  shell: "bash" | "sh" | "powershell";
}

const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 60_000;

const POSIX = /^curl(?:\s+-[A-Za-z]+)*\s+'?(https:\/\/[^\s'|]+)'?(?:\s+-[A-Za-z]+)*\s*\|\s*(bash|sh)$/;
const WINDOWS = /^(?:irm\s+'?(https:\/\/[^\s'|)]+)'?\s*\|\s*iex|iex\s*\(\s*irm\s+'?(https:\/\/[^\s'|)]+)'?\s*\))$/i;

/** The vendor's one-line installer for this platform (`curl … | bash`, `irm … | iex`) as a URL and the shell it runs in. */
export function scriptInstallerOf(install: EngineInstall | undefined, platform: NodeJS.Platform = process.platform): ScriptInstaller | null {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return null;
  const line = (install?.installer?.[platform] ?? install?.command?.[platform])?.trim();
  if (!line) return null;
  if (platform === "win32") {
    const match = WINDOWS.exec(line);
    const url = match?.[1] ?? match?.[2];
    return url ? { url, shell: "powershell" } : null;
  }
  const match = POSIX.exec(line);
  return match ? { url: match[1]!, shell: match[2] as "bash" | "sh" } : null;
}

export interface ScriptInstallOptions {
  /** The CLI the install must leave on PATH. */
  cli?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** For tests: the program that runs the saved script. */
  shellCommand?: (installer: ScriptInstaller, file: string) => { command: string; args: string[] };
}

const running = new Map<string, Promise<void>>();

/** Runs one vendor installer; concurrent installs of the same one share a run. */
export function installScriptEngine(installer: ScriptInstaller, options: ScriptInstallOptions = {}): Promise<void> {
  const existing = running.get(installer.url);
  if (existing) return existing;
  const run = installOnce(installer, options).finally(() => running.delete(installer.url));
  running.set(installer.url, run);
  return run;
}

function defaultShell(installer: ScriptInstaller, file: string): { command: string; args: string[] } {
  if (installer.shell === "powershell") return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file] };
  return { command: installer.shell, args: [file] };
}

async function fetchScript(url: string, fetchImpl: typeof fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new Error("The installer could not be downloaded. Check this computer's internet connection, then try again.");
  }
  if (!response.ok || !response.url.startsWith("https://")) {
    throw new Error("The installer could not be downloaded. Try again in a moment.");
  }
  const body = await response.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_SCRIPT_BYTES) throw new Error("The installer that came back was not usable. Try again in a moment.");
  return new TextDecoder().decode(body);
}

async function installOnce(installer: ScriptInstaller, options: ScriptInstallOptions): Promise<void> {
  const script = await fetchScript(installer.url, options.fetchImpl ?? fetch);
  const dir = mkdtempSync(join(tmpdir(), "madani-install-"));
  const file = join(dir, installer.shell === "powershell" ? "install.ps1" : "install.sh");
  try {
    writeFileSync(file, script, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      PATH: augmentedPath(),
      NO_COLOR: "1",
      CI: "1",
      NONINTERACTIVE: "1",
    };
    stripWorkspaceCredentialEnv(env as Record<string, string | undefined>);
    const { command, args } = (options.shellCommand ?? defaultShell)(installer, file);
    const result = await runScript(command, args, env, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(`The installer stopped before it finished.${tail(result.output)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  resetPathCache();
  if (options.cli && findCliCandidates(options.cli).length === 0) {
    throw new Error(`The installer finished, but \`${options.cli}\` was not found afterwards.`);
  }
}

function tail(output: string): string {
  const clean = stripVTControlCharacters(output).trim();
  if (!clean) return "";
  return `\n${clean.split(/\r?\n/).filter((line) => line.trim()).slice(-6).join("\n").slice(-600)}`;
}

function runScript(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(command, args, { env, cwd: homedir(), stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      rejectRun(new Error("The installer could not start on this computer."));
      return;
    }
    child.stdin.end();
    let output = "";
    const receive = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killCliTree(child).then(() => rejectRun(new Error("The install took too long and was stopped. Try again.")));
    }, timeoutMs);
    timer.unref();
    child.once("error", () => {
      if (timedOut) return;
      clearTimeout(timer);
      rejectRun(new Error("The installer could not start on this computer."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      resolveRun({ code, output });
    });
  });
}
