// The fake Claude CLI in `slow` mode holds every reply until the gate file exists, so "all three are answering" is a
// state the test holds open and reads off the wire.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";
import type { WireGroup } from "../shared/wire.ts";

type Message = { id: string; at: number; role: string; kind: string; text?: string; from?: { botId: string } };
const POLL = { timeout: 30_000, interval: 50 };

async function harness(env: Record<string, string>) {
  const fixture = await launchVerificationServer({ ...process.env, ...env });
  const { url } = fixture.info;
  const control = (...args: string[]) => runControlMadani([...args, "--url", url]) as Promise<any>;
  // the browser app sends with its origin; a bare loopback call is stamped as a program's ("api") and never fans out
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
  const fleet = async () => await api("GET", "/api/bots?messages=0") as { bots: Array<{ id: string; busy?: boolean }>; groups: WireGroup[] };
  const room = async (id: string) => (await fleet()).groups.find((group) => group.id === id)!;
  const speaking = async (id: string) => ((await room(id)).speakers ?? []).map((speaker) => speaker.botId).sort();
  const busy = async () => (await fleet()).bots.filter((bot) => bot.busy).map((bot) => bot.id).sort();
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as Message[];
  const replies = async (threadId: string) => (await messages(threadId)).filter((message) => message.role === "bot" && message.kind === "text");
  // `slow` says hello at once and holds its "reply to: …" behind the gate
  const finals = async (threadId: string) => (await replies(threadId)).filter((message) => message.text?.startsWith("reply to:"));
  const send = (roomId: string, text: string) => api("POST", `/api/groups/${roomId}/messages`, { text });
  const team = async (names: string[], approvalMode?: "ask") => {
    const bots = [];
    for (const name of names) bots.push((await control("new-bot", "--name", name)).bot as { id: string; name: string });
    if (approvalMode) for (const bot of bots) await api("PATCH", `/api/bots/${bot.id}`, { approvalMode });
    // a room set to everyone, with setup skipped
    const created = (await api("POST", "/api/groups", { name: "Launch room", memberIds: bots.map((bot) => bot.id), defaultResponder: { kind: "everyone" } })).group as WireGroup;
    await api("PATCH", `/api/groups/${created.id}/setup`, { action: "skip" });
    return { bots, roomId: created.id, threadId: created.threadId };
  };
  return { fixture, api, room, speaking, busy, messages, replies, finals, send, team };
}

describe.skipIf(process.platform === "win32")("a room message goes to everyone at once", () => {
  it("runs every member side by side, lands each reply on its own, targets @mentions, and stops them all", async () => {
    const gateDir = mkdtempSync(join(tmpdir(), "madani-everyone-at-once-"));
    const gate = join(gateDir, "finish.gate");
    const h = await harness({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
    try {
      const { bots, roomId, threadId } = await h.team(["Xena", "Yuri", "Zane"]);
      const ids = bots.map((bot) => bot.id).sort();
      expect((await h.room(roomId)).defaultResponder).toEqual({ kind: "everyone" });

      const sentAt = Date.now();
      await h.send(roomId, "Plan the launch");
      await expect.poll(async () => [...((await h.room(roomId)).busyBotIds ?? [])].sort(), POLL).toEqual(ids).catch(async (error) => {
        throw new Error(`${JSON.stringify((await h.messages(threadId)).map((m: any) => [m.role, m.kind, m.from?.botId?.slice(0, 4), m.text?.slice(0, 60), m.tool?.name]))}\n${error}`);
      });
      expect(await h.busy()).toEqual(ids);
      const started = ((await h.room(roomId)).speakers ?? []).map((speaker) => speaker.since ?? 0);
      expect(started.every((since) => since >= sentAt)).toBe(true);
      expect(await h.finals(threadId)).toEqual([]);

      writeFileSync(gate, "finish");
      await expect.poll(async () => (await h.finals(threadId)).map((reply) => reply.from?.botId).sort(), POLL).toEqual(ids);
      const landed = await h.finals(threadId);
      // every turn had started before the first reply landed: the three overlapped
      expect(Math.max(...started)).toBeLessThan(Math.min(...landed.map((reply) => reply.at)));
      await expect.poll(async () => (await h.room(roomId)).working, POLL).toBe(false);
      expect(await h.speaking(roomId)).toEqual([]);

      rmSync(gate);
      const [xena, yuri, zane] = bots;
      await h.send(roomId, "@Xena and @Yuri, just you two");
      const pair = [xena!.id, yuri!.id].sort();
      await expect.poll(() => h.speaking(roomId), POLL).toEqual(pair);
      expect(await h.busy()).toEqual(pair);
      expect(await h.busy()).not.toContain(zane!.id);

      await h.api("POST", `/api/groups/${roomId}/interrupt`, { threadId });
      await expect.poll(async () => (await h.room(roomId)).working, POLL).toBe(false);
      expect(await h.speaking(roomId)).toEqual([]);
      expect(await h.busy()).toEqual([]);

      await h.send(roomId, "Everyone, one more thing");
      await expect.poll(() => h.speaking(roomId), POLL).toEqual(ids);
      await h.api("POST", `/api/groups/${roomId}/interrupt`, { threadId });
      await expect.poll(async () => (await h.room(roomId)).working, POLL).toBe(false);
      expect(await h.busy()).toEqual([]);
      writeFileSync(gate, "finish");
      // a stopped round never posts its replies afterwards
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await h.finals(threadId)).length).toBe(3);
    } finally {
      if (!existsSync(gate)) writeFileSync(gate, "finish");
      await h.fixture.close();
      rmSync(gateDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("answers each member's own card while both are still answering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-everyone-cards-"));
    const gate = join(dir, "finish.gate"), log = join(dir, "control.log");
    const h = await harness({
      FAKE_CLAUDE_MODE: "hang",
      FAKE_CLAUDE_FINISH_GATE: gate,
      FAKE_CLAUDE_CONTROL_LOG: log,
      FAKE_CLAUDE_ELICIT: JSON.stringify({ mcp_server_name: "github", message: "Allow access?", mode: "form", requested_schema: { type: "object", properties: {} } }),
    });
    try {
      const { bots, roomId, threadId } = await h.team(["Xena", "Yuri"], "ask");
      const ids = bots.map((bot) => bot.id).sort();
      const cards = async () => (await h.messages(threadId)).filter((message: any) => message.card?.requestId) as any[];
      await h.send(roomId, "Check the repos");
      await expect.poll(async () => (await cards()).map((card) => card.from?.botId).sort(), POLL).toEqual(ids).catch(async (error) => {
        throw new Error(`${JSON.stringify((await h.messages(threadId)).map((m: any) => [m.role, m.kind, m.from?.botId?.slice(0, 4), m.text?.slice(0, 60), m.tool?.name, m.card ? Object.keys(m.card) : null]))}\n${error}`);
      });
      expect(await h.speaking(roomId)).toEqual(ids);
      for (const _ of ids) {
        const open = (await cards()).find((card) => !card.card.answered)!;
        const answered = await h.api("POST", `/api/threads/${threadId}/respond`, { requestId: open.card.requestId, behavior: "allow" });
        expect(answered.ok).toBe(true);
      }
      await expect.poll(async () => (await cards()).every((card) => card.card.answered), POLL).toBe(true);
      expect(await h.speaking(roomId)).toEqual(ids);
      writeFileSync(gate, "finish");
      await expect.poll(async () => (await h.room(roomId)).working, POLL).toBe(false);
    } finally {
      if (!existsSync(gate)) writeFileSync(gate, "finish");
      await h.fixture.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("a member's @mention brings in only that teammate, never the whole room", async () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-everyone-chain-"));
    const markers = join(dir, "markers.json");
    writeFileSync(markers, JSON.stringify({ "pass-it-on": "Over to @Zane for this one." }));
    const h = await harness({ FAKE_CLAUDE_MARKER_REPLIES: markers });
    try {
      const { bots, roomId, threadId } = await h.team(["Xena", "Yuri", "Zane", "Will"]);
      const [xena, yuri, zane, will] = bots;
      // Xena and Yuri answer at once; both bring in Zane, who answers once; Will is never asked
      await h.send(roomId, "@Xena and @Yuri: pass-it-on");
      await expect.poll(async () => (await h.replies(threadId)).map((reply) => reply.from?.botId).sort(), POLL)
        .toEqual([xena!.id, yuri!.id, zane!.id].sort());
      await expect.poll(async () => (await h.room(roomId)).working, POLL).toBe(false);
      const replies = await h.replies(threadId);
      expect(replies.at(-1)?.from?.botId).toBe(zane!.id);
      expect(replies.some((reply) => reply.from?.botId === will!.id)).toBe(false);
    } finally {
      await h.fixture.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
  it("runs \"@X …, then @Y …\" in order: Y starts only once X's reply has landed, so it can build on it", async () => {
    const gateDir = mkdtempSync(join(tmpdir(), "madani-room-chain-"));
    const gate = join(gateDir, "finish.gate");
    const h = await harness({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
    try {
      const { bots, roomId, threadId } = await h.team(["Forge", "Brief"]);
      const [forge, brief] = bots;
      await h.send(roomId, "@Forge write release notes for v2, then @Brief turn Forge's notes into a 3 line standup");
      await expect.poll(() => h.speaking(roomId), POLL).toEqual([forge!.id]);
      expect(await h.busy()).toEqual([forge!.id]);
      writeFileSync(gate, "finish");
      // the fake echoes the message it got, so Brief's echo @mentions Forge, who may answer once more after it
      await expect.poll(async () => (await h.finals(threadId)).map((reply) => reply.from?.botId).slice(0, 2), POLL).toEqual([forge!.id, brief!.id]);
      const [first, second] = await h.finals(threadId);
      expect(first!.at).toBeLessThan(second!.at);
    } finally {
      if (!existsSync(gate)) writeFileSync(gate, "finish");
      await h.fixture.close();
      rmSync(gateDir, { recursive: true, force: true });
    }
  }, 120_000);
});
