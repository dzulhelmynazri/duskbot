// The fake engine works a six-step plan one step per turn and ends each turn with steps still open: the server carries
// it on by itself while each turn closes a step, naming the open steps, so the person gets the whole job from one message.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";

const STEPS = ["Find flights", "Compare hotels", "Check visa rules", "Price local transport", "Draft the itinerary", "Total the budget"];
const plan = (done: number) => ({ name: "TodoWrite", input: { todos: STEPS.map((content, i) => ({ content, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })) } });

it("carries a multi-step plan through to the end while each turn closes a step", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "madani-plan-carry-on-"));
  const prompts = join(scratch, "prompts.jsonl");
  const replies = STEPS.map((step, i) => (i === STEPS.length - 1 ? "Your Lisbon trip plan is ready: 1,840 euros in total." : `${step}: done.`));
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_REPLIES: JSON.stringify(replies),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "replies.state"),
    FAKE_CLAUDE_TOOL_CALLS_BY_TURN: JSON.stringify(STEPS.map((_, i) => [plan(i + 1)])),
    FAKE_CLAUDE_PROMPTS: prompts,
  });
  const cli = (...args: string[]) => runControlMadani([...args, "--url", fixture.info.url]) as Promise<any>;
  const rows = async (threadId: string) => {
    const response = await fetch(`${fixture.info.url}/api/threads/${encodeURIComponent(threadId)}/messages?limit=200`);
    return ((await response.json()) as { messages: Array<{ role: string; kind: string; text?: string; tool?: { name: string } }> }).messages;
  };
  try {
    const { bot } = await cli("new-bot", "--name", "Planner");
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Plan a five-day Lisbon trip for two in May.");
    await expect.poll(async () => (await rows(bot.activeTaskId)).some((row) => row.text === replies.at(-1)), { timeout: 60_000 }).toBe(true);
    const all = await rows(bot.activeTaskId);
    expect(all.filter((row) => row.role === "user" && row.kind === "text")).toHaveLength(1);
    expect(all.filter((row) => row.tool?.name.startsWith("recovery: "))).toHaveLength(STEPS.length - 1);
    // the note names what is still open
    expect(readFileSync(prompts, "utf8")).toContain("Still open: 1. Compare hotels; 2. Check visa rules");
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
