// Quiet routines and the weekly allowance against the isolated fixture and the fake engine (docs/verification): a probe
// check that wakes no model when nothing changed, one run when the page did, a failed read that surfaces, the strip;
// and the allowance: none by default, its quiet 80% and 100% app notices, skipped runs, a refused new task, Saver mode,
// and no money in any chat.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlMadani, type VerificationServer } from "../scripts/control-madani.ts";

let session: VerificationServer | null = null;
let pages: Server | null = null;
afterEach(async () => {
  if (session) { console.info(JSON.stringify(session.info)); await session.close(); }
  pages?.close();
  session = null;
  pages = null;
});

async function launch(env: Record<string, string> = {}) {
  session = await launchVerificationServer({ ...env });
  const url = session.info.url;
  const control = (args: string[]) => runControlMadani([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const usageRows = () => {
    const file = join(session!.info.dataDir, "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const runsOf = async (routineId: string) => ((await api("GET", "/api/routines")).body.runs as any[]).filter((run) => run.routineId === routineId);
  const routineOf = async (routineId: string) => ((await api("GET", "/api/routines")).body.routines as any[]).find((one) => one.id === routineId);
  /** Starts it now and waits for that run to finish. */
  const runNow = async (routineId: string) => {
    const started = await api("POST", `/api/routines/${routineId}/run`);
    expect(started.status).toBe(201);
    let run: any;
    await expect.poll(async () => { run = (await runsOf(routineId)).find((one) => one.id === started.body.run.id); return run?.status; }, { timeout: 30_000 })
      .toMatch(/^(completed|failed|missed|cancelled)$/);
    return run;
  };
  return { control, api, usageRows, runsOf, routineOf, runNow, dataDir: session.info.dataDir };
}

describe("a quiet routine", () => {
  it("reads the page in plain code, wakes the model only for a change, surfaces a failed read and keeps the strip", async () => {
    let page = { status: 200, body: "<html><body><h1>Release notes</h1><p>Version 1.0</p></body></html>" };
    pages = createServer((_req, res) => { res.writeHead(page.status, { "content-type": "text/html" }); res.end(page.body); });
    await new Promise<void>((resolve) => pages!.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
    const f = await launch({ MADANI_PROBE_LOOPBACK_ORIGIN: origin });
    const bot = (await f.control(["new-bot", "--name", "Watcher"])).bot;
    const created = await f.api("POST", "/api/routines", {
      name: "Release notes", prompt: "Tell me what is new in the release notes.", botId: bot.id,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60 * 60_000 }, probe: { kind: "page", url: `${origin}/notes` },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const routine = created.body.routine;
    expect(routine).toMatchObject({ checks: ["probe"], probe: { kind: "page" } });
    // a frequent routine made without a window runs in the person's waking hours (none learned yet: 7 AM to 11 PM)
    expect(routine.schedule.window).toEqual({ start: "07:00", end: "23:00" });

    expect(await f.runNow(routine.id)).toMatchObject({ status: "completed", report: { state: "quiet" } });
    expect(await f.runNow(routine.id)).toMatchObject({ status: "completed", report: { state: "quiet" } });
    expect(f.usageRows()).toHaveLength(0);

    page = { ...page, body: page.body.replace("Version 1.0", "Version 1.1 adds dark mode") };
    const changed = await f.runNow(routine.id);
    expect(changed.status).toBe("completed");
    expect(f.usageRows()).toHaveLength(1);
    const dump = JSON.parse(readFileSync(session!.fixtureDumpPath, "utf8"));
    expect(JSON.stringify(dump)).toContain("changed since the last check");
    expect(JSON.stringify(dump)).toContain("Version 1.1 adds dark mode");

    page = { status: 500, body: "down" };
    const broken = await f.runNow(routine.id);
    expect(broken).toMatchObject({ status: "failed" });
    expect(broken.error).toMatch(/^Couldn't check 127\.0\.0\.1: The page answered 500\./);
    expect(f.usageRows()).toHaveLength(1);

    const after = await f.routineOf(routine.id);
    expect(after.strip.map((entry: any) => entry.outcome)).toEqual(["quiet", "quiet", "ok", "failed"]);
  }, 180_000);
});

describe("the weekly allowance", () => {
  it("is off until the person sets it; then one quiet app notice at 80% and 100%, held work, Saver mode, and no money in any chat", async () => {
    const f = await launch();
    const bot = (await f.control(["new-bot", "--name", "Research"])).bot;
    const daily = await f.api("POST", "/api/routines", { name: "Morning digest", prompt: "Write my digest.", botId: bot.id, schedule: { type: "daily", time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    expect(daily.status).toBe(201);
    // a daily routine in waking hours, made with no timing, runs around its time
    expect(daily.body.routine.timing).toBe("around");
    const turn = async (text: string) => {
      await f.control(["send", "--bot", bot.id, "--text", text]);
      expect(JSON.stringify(await f.control(["wait", "--bot", bot.id, "--timeout", "30"]))).toContain("settled");
    };
    // none by default, and nothing in this fresh install's data folder until the person sets one
    await turn("question 1");
    expect((await f.api("GET", "/api/usage/allowance")).body).toMatchObject({ weeklyUsd: null, limitUsd: null, level: "off" });
    expect(existsSync(join(f.dataDir, "allowance.json"))).toBe(false);
    expect((await f.api("PUT", "/api/usage/allowance", { usd: 0.05 })).body).toMatchObject({ weeklyUsd: 0.05, level: "ok", autoTopUp: { on: false } });

    for (let n = 2; n <= 3; n++) await turn(`question ${n}`);
    expect((await f.api("GET", "/api/usage/allowance/notice")).body).toEqual({ notice: null });
    await turn("question 4");
    expect((await f.api("GET", "/api/usage/allowance/notice")).body).toEqual({ notice: "near" });
    expect((await f.api("GET", "/api/usage/allowance")).body).toMatchObject({ level: "near", spentUsd: 0.04, top: [{ kind: "bot", name: "Research", usd: 0.04 }] });
    await f.api("POST", "/api/usage/allowance/notice/seen", {});
    expect((await f.api("GET", "/api/usage/allowance/notice")).body).toEqual({ notice: null });

    await turn("question 5");
    expect((await f.api("GET", "/api/usage/allowance/notice")).body).toEqual({ notice: "over" });
    expect((await f.api("GET", "/api/usage/allowance")).body).toMatchObject({ level: "over", spentUsd: 0.05, saver: false, skipped: [{ name: "Morning digest" }] });

    // a new task waits, with the reset time and no amounts; nothing is spent
    const refused = await f.api("POST", `/api/bots/${bot.id}/messages`, { text: "question 6" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/^Weekly limit reached, so new tasks wait until Monday/);
    expect(refused.body.error).not.toMatch(/\$/);
    expect(f.usageRows()).toHaveLength(5);

    // a routine run is skipped: no card, no alert, only "skipped" on its strip
    const held = await f.runNow(daily.body.routine.id);
    expect(held).toMatchObject({ status: "missed" });
    expect(held.error).toMatch(/^Skipped: weekly limit reached\./);
    await expect.poll(async () => (await f.routineOf(daily.body.routine.id)).strip.map((entry: any) => entry.outcome), { timeout: 10_000 }).toEqual(["skipped"]);
    expect((await f.runsOf(daily.body.routine.id))[0].seenAt).toBeTypeOf("number");

    // Saver mode is the person's choice; then chat works again, on the quick model
    expect((await f.api("POST", "/api/usage/allowance/saver", { on: true })).body).toMatchObject({ saver: true });
    await turn("question 7");
    expect(f.usageRows()[5]).toMatchObject({ model: expect.stringMatching(/haiku/), trigger: { kind: "owner" } });
    expect((await f.api("GET", "/api/usage/allowance")).body).toMatchObject({ level: "over", spentUsd: 0.05, overrunUsd: 0 });

    // no money and no allowance talk anywhere in the bot's chats
    const messages = (await f.control(["messages", "--bot", bot.id, "--limit", "100"])).messages as any[];
    const said = JSON.stringify(messages.map((message) => [message.kind, message.text, message.tool?.name, message.routineRun]));
    expect(said).not.toMatch(/[$€£₹¥]\s?\d|allowance|weekly limit|Morning digest/i);

    // adding to the week at the price shown lifts the hold
    expect((await f.api("POST", "/api/usage/allowance/top-up", { usd: 0.05 })).body).toMatchObject({ limitUsd: 0.1, level: "ok", extraUsd: 0.05 });
  }, 240_000);
});
