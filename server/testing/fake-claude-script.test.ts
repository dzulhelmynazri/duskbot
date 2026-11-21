import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./cleanup.ts";

type Frame = { type: string; message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown }> } };

it("plays a FAKE_CLAUDE_SCRIPT turn in order: separate messages, answered calls and a pause", async () => {
  const home = mkdtempSync(join(tmpdir(), "madani-claude-script-"));
  const script = [
    { text: "On it, comparing keyboards now." },
    { tool: { name: "mcp__agents__set_status", input: { status: "comparing keyboard reviews" } } },
    { tool: { name: "WebSearch", input: { query: "budget mechanical keyboards" }, output: "3 results" } },
    { text: "I'll send three picks once I've checked the prices." },
    { waitMs: 300 },
    { text: "My pick is the first one.\n---\nNothing was bought." },
  ];
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url)), "--output-format", "stream-json"], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_EXIT_AFTER_TURN: "1", FAKE_CLAUDE_SCRIPT: JSON.stringify(script) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise<number | null>((resolve) => child!.once("close", (code) => resolve(code)));
    const startedAt = Date.now();
    child.stdin!.end(JSON.stringify({ type: "user", message: { role: "user", content: "best budget keyboards?" } }) + "\n");
    await closed;
    expect(child.exitCode, stderr).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    const frames: Frame[] = out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const played = frames.flatMap((frame) => (frame.type === "assistant" || frame.type === "user" ? frame.message?.content ?? [] : [])
      .map((block) => block.type === "text" ? `text:${block.text}` : block.type === "tool_use" ? `call:${block.name}` : `result:${String(block.content)}`));
    expect(played).toEqual([
      "text:On it, comparing keyboards now.",
      "call:mcp__agents__set_status", "result:ok",
      "call:WebSearch", "result:3 results",
      "text:I'll send three picks once I've checked the prices.",
      "text:My pick is the first one.\n---\nNothing was bought.",
    ]);
    expect(frames.at(-1)?.type).toBe("result");
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
});
