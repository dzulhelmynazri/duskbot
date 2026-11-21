import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = workerPort(19400, 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const homes: string[] = [];

async function boot(home: string): Promise<ChildProcess> {
  let stderr = "";
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MADANI_PORT: String(PORT), MADANI_VPS_DOCKER: "ssh" };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return child; } catch { /* not listening yet */ }
    if (child.exitCode !== null || Date.now() > deadline) {
      await waitForExit(child, { signal: "SIGTERM" });
      throw new Error(`server never came up. stderr:\n${stderr.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function freshHome(config: object): { home: string; configFile: string } {
  const home = mkdtempSync(join(tmpdir(), "madani-vps-mode-"));
  homes.push(home);
  mkdirSync(join(home, ".madanibot"), { recursive: true });
  const configFile = join(home, ".madanibot", "config.json");
  writeFileSync(configFile, JSON.stringify(config));
  return { home, configFile };
}

const savedVps = (configFile: string) => JSON.parse(readFileSync(configFile, "utf8")).vps;

afterAll(async () => { for (const home of homes) await removeTempDir(home); });

describe.skipIf(process.platform === "win32")("the VPS computer mode on the first start of this version", () => {
  it("gives a fresh install with a VPS the shared default", async () => {
    const { home, configFile } = freshHome({ vps: { sshAlias: "fresh-vps" } });
    const child = await boot(home);
    try { expect(savedVps(configFile)).toEqual({ sshAlias: "fresh-vps", mode: "shared" }); }
    finally { await waitForExit(child, { signal: "SIGTERM" }); }
  }, 40_000);

  it("keeps an upgraded VPS whose bots had their own computers per-bot, and never overrides that choice", async () => {
    const { home, configFile } = freshHome({});
    let child = await boot(home);
    try {
      const created = await fetch(`${BASE}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(created.status).toBe(201);
      expect(savedVps(configFile)).toEqual({ mode: "shared" });
    } finally { await waitForExit(child, { signal: "SIGTERM" }); }

    // a config written by a version without shared mode
    const legacy = JSON.parse(readFileSync(configFile, "utf8"));
    legacy.vps = { sshAlias: "existing-vps", idleTimeoutMinutes: 30 };
    writeFileSync(configFile, JSON.stringify(legacy));
    child = await boot(home);
    try {
      expect(savedVps(configFile)).toEqual({ sshAlias: "existing-vps", idleTimeoutMinutes: 30, mode: "per-bot" });
      const changed = await fetch(`${BASE}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ vps: { mode: "shared" } }) });
      expect(changed.status).toBe(200);
    } finally { await waitForExit(child, { signal: "SIGTERM" }); }
    child = await boot(home);
    try { expect(savedVps(configFile).mode).toBe("shared"); }
    finally { await waitForExit(child, { signal: "SIGTERM" }); }
  }, 90_000);
});
