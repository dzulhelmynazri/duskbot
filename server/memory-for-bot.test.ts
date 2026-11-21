import { describe, expect, it } from "vitest";

import { memoryTarget } from "./memory-for-bot.ts";

type Bot = { id: string; name: string; hidden?: boolean; peers?: string[]; memoryEnabled?: boolean };
const madani: Bot = { id: "madani", name: "Madani" };
const scout: Bot = { id: "scout", name: "Scout" };
const quiet: Bot = { id: "quiet", name: "Quiet", memoryEnabled: false };
const gone: Bot = { id: "gone", name: "Gone", hidden: true };
const bots = [madani, scout, quiet, gone];
const ask = (raw: string, over: Partial<Parameters<typeof memoryTarget<Bot>>[0]> = {}) =>
  memoryTarget<Bot>({ bots, sender: madani, raw, action: "append", ownersAsk: true, team: false, ...over });

describe("a note for another bot's notebook", () => {
  it("finds the teammate by id or by its name", () => {
    expect(ask("scout")).toEqual({ ok: true, target: scout });
    expect(ask("@scout")).toEqual({ ok: true, target: scout });
    expect(ask("madani")).toEqual({ ok: true, target: madani });
  });

  it("is only an append, only from the person's own ask, and never on a team", () => {
    expect(ask("scout", { action: "forget" })).toMatchObject({ ok: false, status: 400 });
    expect(ask("scout", { ownersAsk: false })).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("person's own request") });
    expect(ask("scout", { team: true })).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("that bot's own chat") });
  });

  it("refuses a bot it may not reach, a hidden one, one with memory off, and a name nobody has", () => {
    expect(ask("scout", { sender: { ...madani, peers: [] } })).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("nothing was saved") });
    expect(ask("gone")).toMatchObject({ ok: false });
    expect(ask("quiet")).toMatchObject({ ok: false, status: 403, error: "Quiet has memory turned off, so nothing was saved. Tell the person." });
    expect(ask("Nobody")).toMatchObject({ ok: false, status: 404 });
  });
});
