import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";

it("stops waiting on a question the person moved on from: their next message closes it, and the bot works on", async () => {
  const gates = mkdtempSync(join(tmpdir(), "madani-moved-on-question-"));
  const release = join(gates, "release");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: release });
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const cli = (...args: string[]) => runControlMadani(args, { env: { MADANI_URL: fixture.info.url } }) as Promise<any>;
  let socket: Socket | undefined;
  console.log(`moved-on question fixture: ${fixture.info.logPath}`);
  try {
    const bot = (await cli("new-bot", "--name", "Juno")).bot;
    const profile = async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id);
    const threadId = (await profile()).threadId as string;
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages as any[];
    const state = async () => { const one = await profile(); return { activity: one.activity, busy: Boolean(one.busy) }; };

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Set up my craft fair trip" })).status).toBeLessThan(300);
    await expect.poll(async () => (await state()).busy, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.madani?.args[1]; }
      catch { return undefined; }
    }, { timeout: 5_000 }).toEqual(expect.any(String));
    socket = connect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.madani.args[1]);
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      socket!.once("connect", resolve);
      socket!.once("error", reject);
    });
    const requestId = randomUUID();
    socket.write(JSON.stringify({
      t: "ask", kind: "question", id: requestId, tool: "AskUserQuestion",
      input: { questions: [{ question: "What folder on your computer should Juno use for trip files?", options: [{ label: "~/Trips" }, { label: "~/Documents/Trips" }] }] },
    }) + "\n");
    await expect.poll(async () => (await messages()).find((message) => message.card?.requestId === requestId), { timeout: 5_000 }).toBeTruthy();
    const question = (await messages()).find((message) => message.card?.requestId === requestId)!;
    expect(await state()).toEqual({ activity: "waiting-on-you", busy: true });

    writeFileSync(release, "");
    await expect.poll(async () => (await state()).busy, { timeout: 10_000 }).toBe(false);
    expect((await messages()).find((message) => message.id === question.id)?.card.answered).toBeUndefined();
    expect(await state()).toEqual({ activity: "waiting-on-you", busy: false });

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "ok" })).status).toBeLessThan(300);
    await expect.poll(async () => (await messages()).find((message) => message.id === question.id)?.card, { timeout: 5_000 })
      .toMatchObject({ answered: "unavailable", dismissed: true });
    await expect.poll(state, { timeout: 10_000 }).toEqual({ activity: "idle", busy: false });
    const late = await api("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "answer", message: "~/Trips" });
    expect(late.status).toBe(409);
  } finally {
    socket?.destroy();
    await fixture.close();
    rmSync(gates, { recursive: true, force: true });
  }
}, 60_000);
