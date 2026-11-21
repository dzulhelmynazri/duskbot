import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), "madani-engine-guard-e2e-"));
// a stand-in for an installed engine: outside every temporary folder, in an engine package's path; it only leaves a mark
const installed = join(SERVER_DIR, "..", "node_modules", ".cache", `madani-engine-guard-${process.pid}`, "@anthropic-ai", "claude-code");
const marker = join(home, "the-engine-ran");
afterAll(async () => { rmSync(join(installed, "..", ".."), { recursive: true, force: true }); await removeTempDir(home); });

it("a test fixture that would launch a real engine CLI stops at its first attempt, before any runs", async () => {
  const dataDir = join(home, ".madanibot");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(installed, { recursive: true });
  // the read-only probes (version, help, sign-in status) may run; anything else leaves the mark
  writeFileSync(join(installed, "cli.js"), `#!/usr/bin/env node\nconst [first] = process.argv.slice(2);\nif (["--version", "--help", "auth"].includes(first)) { console.log("2.1.200 (Claude Code)"); process.exit(0); }\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: join(installed, "cli.js") } },
  } }));
  const port = await freePortBlock([0, 1]);
  const offline = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
  const roomyDisk = pathToFileURL(join(SERVER_DIR, "testing", "roomy-disk.mjs")).href;
  const child = spawn(process.execPath, ["--import", roomyDisk, "--import", offline, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: home, MADANI_DATA_DIR: dataDir, MADANI_PORT: String(port), MADANI_WEBHOOK_PORT: String(port + 1), MADANI_NO_TEST_BOTS: "1" },
  });
  let said = "";
  child.stderr.on("data", (chunk) => { said += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  try {
    const base = `http://127.0.0.1:${port}`;
    const ask = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { "x-madani-cli": "1", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((res) => res.json(), () => null);
    const started = await Promise.race([exited.then(() => false), (async () => {
      for (let tries = 0; tries < 200; tries++) { if (await fetch(`${base}/api/health`).then((res) => res.ok, () => false)) return true; await new Promise((resolve) => setTimeout(resolve, 100)); }
      return false;
    })()]);
    if (started) {
      const made = await ask("POST", "/api/bots", { name: "Probe", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) as { bot?: { id: string } } | null;
      if (made?.bot) await ask("POST", `/api/bots/${made.bot.id}/messages`, { text: "hello", sendId: "engine-guard-0001" });
    }
    const outcome = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 30_000))]);
    expect(outcome, said.slice(-2000)).toBe(78);
    expect(said).toMatch(/engine guard: this test fixture tried to launch the real \S+ CLI/);
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (child.exitCode === null) await waitForExit(child, { signal: "SIGTERM" });
  }
}, 60_000);
