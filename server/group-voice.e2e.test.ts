// Against the real server and the fake Claude CLI: the talking style and the voice rules reach a 1:1 turn, a routine run,
// a room turn, a room's leader and members answering at once, and what a bot wrote lands with the safety net applied.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";
import { VOICE_RULES } from "./group-voice.ts";

const EM = String.fromCharCode(0x2014);
const POLL = { timeout: 30_000, interval: 50 };
const casualGuide = readFileSync(new URL("./prompts/talking-style/casual.md", import.meta.url), "utf8").trim();

it("puts the person's talking style and the voice rules in every turn type, and cleans what bots write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-group-voice-"));
  const markers = join(dir, "markers.json");
  writeFileSync(markers, JSON.stringify({
    // the room transcript carries earlier lines too: the later marker is listed first
    "prefix-check": `Basil: Dinner plan is ready ${EM} want it @you?`,
    "status-check": `Nothing new ${EM} still waiting on @you’s pick.`,
  }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MARKER_REPLIES: markers });
  const { url } = fixture.info;
  const control = (...args: string[]) => runControlMadani([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: body === undefined ? { origin: url } : { "content-type": "application/json", origin: url },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  // SAFETY: the fake CLI writes exactly this shape; a missing or partial file reads as no dump yet
  const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { systemPrompt?: string; prompt?: unknown }; } catch { return undefined; } };
  const promptOf = () => JSON.stringify(dump()?.prompt ?? "");
  const roomReplies = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[])
    .filter((message) => message.role === "bot" && message.kind === "text").map((message) => ({ by: message.from?.name as string, text: message.text as string }));
  const expectVoice = (system: string) => {
    expect(system).toContain(casualGuide);
    expect(system).toContain(VOICE_RULES);
    expect(system).not.toMatch(/write @you\b/);
  };
  try {
    await api("PUT", "/api/config", { talkingStyle: "casual", profile: { name: "Sam" } });
    const basil = (await control("new-bot", "--name", "Basil")).bot as { id: string };
    const nova = (await control("new-bot", "--name", "Nova")).bot as { id: string };

    // 1:1
    await control("send", "--bot", basil.id, "--text", "What's for dinner?");
    await control("wait", "--bot", basil.id, "--timeout", "30");
    expectVoice(dump()?.systemPrompt ?? "");

    // a routine run
    const routine = (await api("POST", "/api/routines", { name: "Dinner check-in", prompt: "Dinner check-in: reply with one line.", botId: basil.id,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } })).routine;
    const { run } = await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: any) => item.id === run.id)?.status, POLL).toBe("completed");
    expect(promptOf()).toContain("Dinner check-in");
    expectVoice(dump()?.systemPrompt ?? "");

    // a room where everyone answers at once
    const room = (await api("POST", "/api/groups", { name: "Standup", memberIds: [basil.id, nova.id], defaultResponder: { kind: "everyone" } })).group as { id: string; threadId: string };
    await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
    await api("POST", `/api/groups/${room.id}/messages`, { text: "status-check, everyone" });
    await expect.poll(async () => (await roomReplies(room.threadId)).length, POLL).toBe(2);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).groups.find((group: any) => group.id === room.id)?.working, POLL).toBe(false);
    const roomSystem = dump()?.systemPrompt ?? "";
    expectVoice(roomSystem);
    expect(roomSystem).toContain('Talk to Sam as "you"');
    expect(roomSystem).toContain("tag them once as @Sam");
    expect(promptOf()).toMatch(/(Basil|Nova) is answering this same message at the same time/);
    expect(promptOf()).toContain("no name prefix, no em dashes");
    for (const reply of await roomReplies(room.threadId)) expect(reply.text).toBe("Nothing new, still waiting on your pick.");

    // one member, its own name as a prefix
    await api("POST", `/api/groups/${room.id}/messages`, { text: "@Basil prefix-check" });
    await expect.poll(async () => (await roomReplies(room.threadId)).length, POLL).toBe(3);
    expect((await roomReplies(room.threadId)).at(-1)).toEqual({ by: "Basil", text: "Dinner plan is ready, want it?" });
    expect(promptOf()).not.toContain("same time");

    // a room with a leader: one combined answer to a check-in
    const led = (await api("POST", "/api/groups", { name: "Kitchen", memberIds: [nova.id, basil.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: nova.id, leader: true } } })).group as { id: string; threadId: string };
    await api("POST", `/api/groups/${led.id}/messages`, { text: "How's everyone doing?" });
    await expect.poll(async () => (await roomReplies(led.threadId)).length, POLL).toBeGreaterThan(0);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).groups.find((group: any) => group.id === led.id)?.working, POLL).toBe(false);
    const leaderSystem = dump()?.systemPrompt ?? "";
    expectVoice(leaderSystem);
    expect(leaderSystem).toContain("When Sam asks the whole group something");
  } finally {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
