// Security invariant: a server whose data folder is a temporary one (every test fixture's) never launches a real engine
// CLI. One would sign in with the person's own account (the Claude CLI reads its macOS Keychain sign-in whatever HOME
// says) and spend its usage. The first attempt ends the process, so a misconfigured fixture fails at once. Only the
// read-only probes a fixture's engine list makes (its version, help or sign-in status) still run.
// MADANI_ALLOW_REAL_ENGINES=1 is for the live checks that mean to use one.
import childProcess from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve, sep } from "node:path";

export const REAL_ENGINES = new Set(["claude", "codex", "cursor-agent", "gemini", "qwen", "hermes", "copilot", "opencode", "grok", "cline", "droid", "kimi", "agy"]);
const PACKAGES = /@anthropic-ai[\\/](?:claude-code|claude-agent-sdk)|@openai[\\/]codex|@google[\\/]gemini-cli|@github[\\/]copilot|@qwen-code[\\/]|opencode-ai[\\/]/;

const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const within = (path: string, roots: readonly string[]) => roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));

/** the temporary folders a fixture lives in: this process's, and the system's whatever TMPDIR it was given (macOS keeps
 * each user's under /var/folders) */
export function temporaryRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const named = [tmpdir(), env.TMPDIR, env.TEMP, env.TMP].filter((one): one is string => Boolean(one));
  return [...new Set([...named, "/tmp", "/var/tmp", "/var/folders"].map(real))];
}

/** the real engine a command would launch, or null: an engine's executable outside `fixtures`, or a script of an
 * engine's package (the Agent SDK's bundled CLI included) outside them */
export function realEngine(command: unknown, args: readonly unknown[], fixtures: readonly string[], path = process.env.PATH ?? ""): string | null {
  const text = String(command ?? "");
  const words = [text.trim().split(/\s+/)[0] ?? "", ...args.map(String)];
  if (probe(words.slice(1)) || probe(text.trim().split(/\s+/).slice(1))) return null;
  for (const [index, word] of words.entries()) {
    const name = basename(word).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
    const engine = index === 0 && REAL_ENGINES.has(name) ? name : PACKAGES.exec(word)?.[0] ?? null;
    if (!engine) continue;
    // one that is not there cannot run (a runner with no engines installed fails it as before)
    const target = word.includes(sep) ? word : onPath(word, path);
    if (target && existsSync(target) && !within(real(target), fixtures)) return engine;
  }
  return null;
}

/** a read-only question to an engine's CLI: what version, what flags, signed in or not */
function probe(args: readonly string[]): boolean {
  const rest = args.filter((one) => !one.endsWith(".js") && !one.endsWith(".mjs"));
  if (rest.length === 1 && ["--version", "-v", "version", "--help", "-h"].includes(rest[0]!)) return true;
  return rest.length >= 2 && ["auth", "login"].includes(rest[0]!) && rest[1] === "status";
}

/** where a bare command name resolves on `path`, as the spawn would find it */
function onPath(name: string, path: string): string | null {
  for (const folder of path.split(delimiter).filter(Boolean)) {
    const candidate = join(folder, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** whether this server runs as a test fixture: its data folder is a temporary one */
export function fixtureServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const dataDir = env.MADANI_DATA_DIR;
  return Boolean(dataDir) && env.MADANI_ALLOW_REAL_ENGINES !== "1" && within(real(dataDir!), temporaryRoots(env));
}

export function guardRealEngines(fixtures: readonly string[], refuse: (engine: string, command: string) => never): void {
  const methods = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"] as const;
  const target = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of methods) {
    const original = target[method]!;
    target[method] = function (this: unknown, command: unknown, ...rest: unknown[]) {
      const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as { env?: NodeJS.ProcessEnv } | undefined;
      const engine = realEngine(command, Array.isArray(rest[0]) ? rest[0] : [], fixtures, options?.env?.PATH ?? process.env.PATH ?? "");
      if (engine) refuse(engine, [command, ...(Array.isArray(rest[0]) ? rest[0] : [])].map(String).join(" ").slice(0, 200));
      return Reflect.apply(original, this, [command, ...rest]);
    };
  }
  syncBuiltinESMExports();
}

if (fixtureServer()) {
  guardRealEngines([...temporaryRoots(), real(new URL("./testing", import.meta.url).pathname)], (engine, command) => {
    process.stderr.write(`engine guard: this test fixture tried to launch the real ${engine} CLI (${command}); give it a fixture engine\n`);
    process.exit(78);
  });
}
