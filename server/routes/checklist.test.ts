import { mkdtempSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { counts, readChecklist } from "../batch-checklist.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createChecklistRoutes, PACE_MAX_MS, PACE_MIN_MS } from "./checklist.ts";
import { PASS } from "./table.ts";

type Answer = { status: number; body: { text?: string; error?: string } };
const said = (result: Answer | typeof PASS): string => (result === PASS ? "" : result.body.text ?? "");

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTempDir)); });

function harness() {
  const root = mkdtempSync(join(tmpdir(), "madani-checklist-route-"));
  roots.push(root);
  const slept: number[] = [];
  const paused: Array<[string, number]> = [];
  const route = createChecklistRoutes({
    taskDir: (botId, threadId) => join(root, botId, threadId),
    pause: (threadId, until) => paused.push([threadId, until]),
    sleep: async (ms) => { slept.push(ms); },
    random: () => 0.5,
    now: () => 1_000,
  });
  const call = async (body: unknown, path = "/api/internal/checklist") => {
    let answer: Answer | null = null;
    const result = await route({ method: "POST", path, res: {} as ServerResponse, botId: "bot1", threadId: "t1", readBody: async () => body,
      json: (_res, status, payload) => { answer = { status, body: payload as Answer["body"] }; } });
    return result === PASS ? PASS : answer!;
  };
  return { root, slept, paused, call, list: () => readChecklist(join(root, "bot1", "t1")) };
}

describe("the checklist tool's route", () => {
  it("passes other paths on and refuses ticks before a list exists", async () => {
    const h = harness();
    expect(await h.call({ action: "status" }, "/api/internal/other")).toBe(PASS);
    expect(await h.call({ action: "done", item: "@a" })).toMatchObject({ status: 400 });
  });

  it("saves the list, ticks with a paced pause between sends, and never repeats a ticked item", async () => {
    const h = harness();
    const started = await h.call({ action: "start", title: "DM signups", verb: "sent", items: ["@a", "@b", "@c"] });
    expect(started).toMatchObject({ status: 200 });
    expect(said(started)).toContain("0 of 3 sent");
    const ticked = await h.call({ action: "done", item: "@a" });
    expect(said(ticked)).toMatch(/^1 of 3 sent\. Next: @b; @c\.$/);
    expect(h.slept).toEqual([PACE_MIN_MS + Math.floor(0.5 * (PACE_MAX_MS - PACE_MIN_MS))]);
    const repeat = await h.call({ action: "done", item: "@A" });
    expect(said(repeat)).toContain("Already closed, so not repeated: @a");
    expect(h.slept).toHaveLength(1);
    const status = await h.call({ action: "status", item: "a" });
    expect(said(status)).toContain("already closed: never repeat it");
    // a bot that starts over after a cut-off turn keeps what it already sent
    await h.call({ action: "start", title: "DM signups", items: ["@a", "@b", "@c"] });
    expect(counts(h.list()!)).toMatchObject({ done: 1, open: 2 });
  });

  it("does not pause after the last item, and records a skip only with its reason", async () => {
    const h = harness();
    await h.call({ action: "start", title: "DMs", items: ["@a", "@b"] });
    expect(await h.call({ action: "skip", item: "@a" })).toMatchObject({ status: 400 });
    await h.call({ action: "skip", item: "@a", note: "DMs closed" });
    await h.call({ action: "done", item: "@b" });
    expect(h.slept).toEqual([]);
    expect(counts(h.list()!)).toEqual({ done: 1, skipped: 1, open: 0, total: 2 });
  });

  it("hands a rate-limit pause to the carry-on", async () => {
    const h = harness();
    await h.call({ action: "start", title: "DMs", items: ["@a"] });
    expect(await h.call({ action: "pause", minutes: 0 })).toMatchObject({ status: 400 });
    expect(await h.call({ action: "pause", minutes: 15 })).toMatchObject({ status: 200 });
    expect(h.paused).toEqual([["t1", 1_000 + 15 * 60_000]]);
  });
});
