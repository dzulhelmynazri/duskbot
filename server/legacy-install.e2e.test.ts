// A real server on an install made before the rename: its data folder under the old name, its settings in old env
// names. It starts clean in its own folder, leaves the old one as it was, and still reads old env names and answers old clients.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { LEGACY } from "../electron/legacy-names.mjs";
import { runControlMadani, verificationServerEnvironment } from "../scripts/control-madani.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-claude-cli.ts");
const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

/** `env` names the settings exactly as the process gets them: nothing is renamed on the way */
async function boot(env: NodeJS.ProcessEnv, port: number) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { headers: { origin: base, ...headers } });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  return { base, get, control: (...args: string[]) => runControlMadani([...args, "--url", base]) as Promise<any>, stop: () => waitForExit(child, { signal: "SIGTERM" }) };
}

/** the same variables under the names a build from before the rename read */
function oldNames(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) out[key.startsWith("MADANI_") ? `${LEGACY.envPrefixes[0]}${key.slice(5)}` : key] = value;
  return out;
}

it("starts clean beside an old install: its data folder is left as it was and its old env names still count", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-legacy-install-"));
  homes.push(home);
  const oldData = join(home, LEGACY.dataDirName);
  mkdirSync(join(oldData, "tmp"), { recursive: true });
  writeFileSync(join(oldData, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: FAKE_CLI } } } }));

  // the old install at work, the way the old build ran it: its own folder named outright
  const port = await freePortBlock([0, 1]);
  const before = await boot(oldNames(verificationServerEnvironment(process.env, oldData, port)), port);
  const made = (await before.control("new-bot", "--name", "Kept helper")).bot;
  const was = (await before.get("/api/bots?messages=0")).bots.map((bot: { id: string }) => bot.id).sort();
  await before.stop();

  // the new build on the same computer: no data folder setting, so the default, and every other setting still old
  const env = oldNames(verificationServerEnvironment(process.env, home, port));
  for (const prefix of LEGACY.envPrefixes) delete env[`${prefix}DATA_DIR`];
  env.TMPDIR = env.TEMP = env.TMP = join(home, "tmp");
  mkdirSync(join(home, "tmp"), { recursive: true });
  const after = await boot(env, port);
  const bots = (await after.get("/api/bots?messages=0")).bots as { id: string; name: string }[];
  expect(bots.some((bot) => was.includes(bot.id))).toBe(false);
  expect(bots.find((bot) => bot.id === made.id)).toBeUndefined();

  expect(lstatSync(join(home, ".madanibot")).isDirectory()).toBe(true);
  expect(lstatSync(oldData).isSymbolicLink()).toBe(false);
  expect(existsSync(join(oldData, "config.json"))).toBe(true);

  // a client from before the rename: the old discovery path and header names
  const described = await after.get(`${LEGACY.wellKnown}/environment`);
  expect(typeof described.environmentId).toBe("string");
  await after.stop();
}, 90_000);
