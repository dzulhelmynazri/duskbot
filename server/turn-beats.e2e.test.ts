// Real server, the repository's fake Claude: the harness's quick ack and derived status label end to end.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

const ACK = "On it, checking this week's Delhi to Goa fares.";

it("acks real work once its first tool runs, labels the status line from the call, and tells the engine next turn", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "madani-turn-beats-"));
  const release = join(scratch, "release");
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_BEAT: ACK,
    FAKE_CLAUDE_RELEASE: release,
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: "WebSearch", input: { query: "Delhi Goa flights this week" }, hold: true }]),
    FAKE_CLAUDE_REPLIES: JSON.stringify(["The cheapest fare is ₹3,900 on Friday.", "You're welcome."]),
  });
  const { url } = fixture.info;
  const control = (args: string[]) => runControlMadani([...args, "--url", url]) as Promise<any>;
  const messages = async (threadId: string) => {
    const response = await fetch(`${url}/api/threads/${threadId}/messages?limit=100`, { headers: { origin: url } });
    return ((await response.json()) as any).messages as any[];
  };
  const stream = await openSse(`${url}/api/events`, { origin: url });
  try {
    const { bot } = await control(["new-bot", "--name", "Juno"]);
    const threadId = bot.activeTaskId;
    expect((await control(["send", "--bot", bot.id, "--task", threadId, "--text", "Research this week's cheapest Delhi to Goa fares"])).success).toBe(true);

    const ack = await vi.waitFor(async () => {
      const row = (await messages(threadId)).find((message) => message.role === "bot" && message.kind === "text" && message.text === ACK);
      if (!row) throw new Error("waiting for the ack");
      return row;
    }, { timeout: 20_000, interval: 200 });
    const asked = (await messages(threadId)).find((message) => message.role === "user");
    expect(ack).toMatchObject({ turnId: expect.any(String), requestMessageId: asked.id });
    const labels = stream.frames.filter((frame) => frame.kind === "runtime" && frame.event?.type === "turn.progress" && frame.event.label)
      .map((frame) => frame.event.label);
    expect(labels.join(" | ")).toMatch(/Searching for Delhi Goa flights/);

    writeFileSync(release, "go");
    expect((await control(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "30"])).status).toBe("settled");
    const first = await messages(threadId);
    expect(first.filter((message) => message.text === ACK)).toHaveLength(1);
    expect(first.filter((message) => message.role === "bot" && message.kind === "text").map((message) => message.text)).toContain("The cheapest fare is ₹3,900 on Friday.");

    const thanks = await control(["send", "--bot", bot.id, "--task", threadId, "--text", "thanks"]);
    expect(thanks.success, JSON.stringify(thanks)).toBe(true);
    expect((await control(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "30"])).status).toBe("settled");
    expect(existsSync(fixture.fixtureDumpPath)).toBe(true);
    const prompt = JSON.stringify(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt);
    expect(prompt).toContain("these short updates were sent to them in your name");
    expect(prompt).toContain(ACK);
    expect((await messages(threadId)).filter((message) => message.text === ACK)).toHaveLength(1);
  } finally {
    stream.close();
    await fixture.close();
    removeTempDir(scratch);
  }
}, 120_000);
