// A realistic room task for three scripted bots (a lead, a researcher, a writer). Each bot's words are fixed per turn, so
// what changes between runs is only the server's routing, turn-taking and context. ROOM_TEAMWORK_METRICS names a JSON file
// the measured numbers are written to.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";

type Message = { id: string; at: number; role: string; kind: string; text?: string; from?: { botId: string }; tool?: { name?: string } };
type Turn = { botId: string; turnIndex: number; system: string; prompt: unknown };
const POLL = { timeout: 45_000, interval: 100 };

function metric(name: string, value: Record<string, unknown>) {
  const file = process.env.ROOM_TEAMWORK_METRICS;
  if (file) appendFileSync(file, `${JSON.stringify({ scenario: name, ...value })}\n`);
}

async function room(plan: (ids: { ada: string; ben: string; cal: string }) => Record<string, unknown>, options: {
  responder?: (ids: { ada: string; ben: string; cal: string }) => unknown; env?: Record<string, string>;
} = {}) {
  const session = await launchVerificationServer({ ...process.env, ...options.env }, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = session.info;
  const control = (...args: string[]) => runControlMadani([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: body === undefined ? { origin: url } : { "content-type": "application/json", origin: url },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  const make = async (name: string, title: string, description: string) => {
    const bot = (await control("new-bot", "--name", name)).bot as { id: string };
    await api("PATCH", `/api/bots/${bot.id}`, { title, description });
    return bot.id;
  };
  const ids = {
    ada: await make("Ada", "Project lead", "Plans launches and signs off on what ships."),
    ben: await make("Ben", "Researcher", "Pulls usage numbers and checks facts."),
    cal: await make("Cal", "Writer", "Writes launch notes and announcements."),
  };
  const planPath = join(dataDir, "room-plan.json");
  writeFileSync(planPath, JSON.stringify(plan(ids)));
  const responder = options.responder?.(ids);
  const created = (await api("POST", "/api/groups", { name: "Launch room", memberIds: [ids.ada, ids.ben, ids.cal], ...(responder ? { defaultResponder: responder } : {}) })).group;
  await api("PATCH", `/api/groups/${created.id}/setup`, { action: "skip" });
  const messages = async () => (await api("GET", `/api/threads/${created.threadId}/messages?limit=500`)).messages as Message[];
  const turns = (): Turn[] => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const send = (text: string) => api("POST", `/api/groups/${created.id}/messages`, { text });
  const idle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.id === created.id)?.working, POLL).toBe(false);
  };
  const replies = async (after = 0) => (await messages()).filter((m) => m.role === "bot" && m.kind === "text" && m.at >= after && m.text?.trim());
  return { session, api, ids, roomId: created.id, threadId: created.threadId, messages, replies, turns, send, idle,
    close: () => session.close() };
}

const nameOf = (ids: Record<string, string>, botId?: string) => Object.entries(ids).find(([, id]) => id === botId)?.[0] ?? "?";

describe.skipIf(process.platform === "win32")("a room of three bots works a task together", () => {
  it("an unaddressed task in a room nobody set up gets one answer, not one from every bot", async () => {
    const r = await room((ids) => ({
      [ids.ada]: { reply: "Here's a first launch note for exports: faster CSV exports for every team, out Monday." },
      [ids.ben]: { reply: "Launch note draft: exports are now faster and work for every team, shipping Monday." },
      [ids.cal]: { reply: "Draft: CSV exports got faster and now reach every team. Live Monday." },
    }));
    try {
      const sentAt = Date.now();
      await r.send("Write a short launch note for the new export feature.");
      await r.idle();
      const replies = await r.replies(sentAt);
      const responders = new Set(replies.map((m) => m.from?.botId));
      metric("unaddressed", { replies: replies.length, responders: responders.size, duplicates: replies.length - 1, turns: r.turns().length });
      expect(responders.size).toBe(1);
      expect(replies).toHaveLength(1);
    } finally { await r.close(); }
  }, 90_000);

  it("a hand-off by @mention comes back to the bot that asked, which wraps up for the person", async () => {
    const r = await room((ids) => ({
      [ids.ada]: { turns: [
        { reply: "@Ben can you pull last month's export numbers so I can sign off the launch note?" },
        { reply: "Thanks Ben. Launch note is good to go: exports up 42% last month across 1,204 teams, out Monday." },
      ] },
      [ids.ben]: { turns: [{ reply: "Exports went up 42% last month, across 1,204 teams. @Ada over to you to sign off." }] },
      [ids.cal]: { reply: "unused" },
    }), { responder: (ids) => ({ kind: "member", botId: ids.ada, leader: true }) });
    try {
      const sentAt = Date.now();
      await r.send("@Ada we need real numbers in the export launch note before it ships.");
      await r.idle();
      const replies = await r.replies(sentAt);
      const order = replies.map((m) => nameOf(r.ids, m.from?.botId));
      const last = replies.at(-1);
      const wrapped = last?.from?.botId === r.ids.ada && /good to go/.test(last.text ?? "");
      metric("hand-off", { order, turns: r.turns().length, wrappedUp: wrapped, danglingMention: !wrapped && /@Ada/.test(last?.text ?? "") });
      expect(order).toEqual(["ada", "ben", "ada"]);
      expect(wrapped).toBe(true);
      const benTurn = r.turns().find((t) => t.botId === r.ids.ben)!;
      const closing = r.turns().filter((t) => t.botId === r.ids.ada)[1]!;
      // the teammate knows who handed it what; the asker knows this is its closing turn
      expect(JSON.stringify(benTurn.prompt)).toContain("Ada @mentioned you");
      expect(JSON.stringify(closing.prompt)).toContain("last turn on this request");
    } finally { await r.close(); }
  }, 90_000);

  it("bots that keep tagging each other stop after a bounded number of turns", async () => {
    const loop = (others: string) => ({ reply: `${others} what do you think? Over to you.` });
    const r = await room((ids) => ({
      [ids.ada]: loop("@Ben @Cal"), [ids.ben]: loop("@Ada @Cal"), [ids.cal]: loop("@Ada @Ben"),
    }), { responder: (ids) => ({ kind: "member", botId: ids.ada, leader: true }) });
    try {
      const sentAt = Date.now();
      await r.send("@Ada pick a launch date with the team.");
      await r.idle();
      const turns = r.turns();
      const perBot = Object.fromEntries(Object.entries(r.ids).map(([name, id]) => [name, turns.filter((t) => t.botId === id).length]));
      const replies = await r.replies(sentAt);
      metric("tag-loop", { turns: turns.length, perBot, replies: replies.length, maxTurnsOneBot: Math.max(...Object.values(perBot)) });
      expect(Math.max(...Object.values(perBot))).toBeLessThanOrEqual(2);
      expect(turns.length).toBeLessThanOrEqual(6);
    } finally { await r.close(); }
  }, 90_000);

  it("a room with a long history still knows what was settled before the window", async () => {
    const routes = join(mkdtempSync(join(tmpdir(), "madani-room-teamwork-")), "text-routes.json");
    writeFileSync(routes, JSON.stringify({ "Current ask": "Current ask: name the project.\nExact details: the project codename is Bluebird." }));
    const r = await room((ids) => ({
      [ids.ada]: { reply: "Bluebird." },
      [ids.ben]: { reply: "unused" },
      [ids.cal]: { reply: "unused" },
    }), { responder: () => ({ kind: "mentions" }), env: { FAKE_CLAUDE_TEXT_ROUTES: routes } });
    try {
      await r.send("Quick note for everyone: the project codename is Bluebird, keep it out of public posts.");
      for (let i = 0; i < 120; i++) await r.send(`Status line ${i}: nothing new on item ${i}.`);
      const sentAt = Date.now();
      await r.send("@Ada what's our project codename again?");
      await r.idle();
      const turn = r.turns().find((t) => t.botId === r.ids.ada);
      const context = turn ? `${turn.system}\n${JSON.stringify(turn.prompt)}` : "";
      const knows = context.includes("Bluebird");
      metric("long-history", { lines: 122, earlierLinesInContext: knows, replies: (await r.replies(sentAt)).length });
      expect(knows).toBe(true);
      expect(turn!.system).toContain("Exact details: the project codename is Bluebird.");
      expect(turn!.system).toContain("earlier messages in this room are older than the conversation you are shown");
    } finally { await r.close(); }
  }, 180_000);

  it("a closing turn with nothing to add passes quietly: no (pass) line and no re-ask", async () => {
    const r = await room((ids) => ({
      [ids.ada]: { turns: [{ reply: "@Ben can you confirm Monday works for the launch?" }, { reply: "(pass)" }] },
      [ids.ben]: { turns: [{ reply: "Monday works, the export build is green. @Ada all set." }] },
      [ids.cal]: { reply: "unused" },
    }), { responder: (ids) => ({ kind: "member", botId: ids.ada, leader: true }) });
    try {
      const sentAt = Date.now();
      await r.send("@Ada is Monday still on?");
      await r.idle();
      const shown = (await r.messages()).filter((m) => m.at >= sentAt && m.role === "bot");
      metric("pass", { turns: r.turns().length, passShown: shown.some((m) => /\(pass\)/.test(m.text ?? "")),
        reasked: shown.some((m) => m.kind === "activity" && /final message|without/i.test(m.tool?.name ?? "")) });
      expect(r.turns()).toHaveLength(3);
      expect(shown.some((m) => /\(pass\)/.test(m.text ?? ""))).toBe(false);
      expect(shown.filter((m) => m.kind === "text").map((m) => nameOf(r.ids, m.from?.botId))).toEqual(["ada", "ben"]);
    } finally { await r.close(); }
  }, 90_000);
});
