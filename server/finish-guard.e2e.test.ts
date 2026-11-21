// The fake engine ends a turn on "Let me check..." after a search: the server carries the turn on by itself with a
// note only the bot reads, and the person sees the result without typing "continue". Scripted, so this proves what the
// server does with such an ending, not what a model chooses to say.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";
import { continueNote } from "./host/finish-guard.ts";

it("carries on a turn that announced a step it never took, once, and the person gets the result", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "madani-finish-guard-"));
  const prompts = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Found three listings. Let me check their current prices.", "The cheapest is the Redragon K552 at 2,289."]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "replies.state"),
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: "WebSearch", input: { query: "best-selling budget keyboards" } }]),
    FAKE_CLAUDE_PROMPTS: prompts,
  });
  const cli = (...args: string[]) => runControlMadani([...args, "--url", fixture.info.url]) as Promise<any>;
  const texts = async (threadId: string) => {
    const response = await fetch(`${fixture.info.url}/api/threads/${encodeURIComponent(threadId)}/messages?limit=100`);
    return (((await response.json()) as { messages: unknown }).messages as Array<{ role: string; kind: string; text?: string; tool?: { name: string } }>);
  };
  try {
    const { bot } = await cli("new-bot", "--name", "Finisher");
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Compare the three best-selling budget keyboards.");
    await expect.poll(async () => (await texts(bot.activeTaskId)).some((row) => row.text === "The cheapest is the Redragon K552 at 2,289."), { timeout: 30_000 }).toBe(true);
    const rows = await texts(bot.activeTaskId);
    expect(rows.filter((row) => row.kind === "activity" && row.tool?.name === "recovery: Continuing: finishing the job")).toHaveLength(1);
    expect(readFileSync(prompts, "utf8")).toContain(JSON.stringify(continueNote({ kind: "next" })).slice(1, -1));
    // the result is not an announcement, so nothing carries on a second time
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await texts(bot.activeTaskId)).filter((row) => row.kind === "activity" && row.tool?.name?.startsWith("recovery: "))).toHaveLength(1);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
