// Bringing everything in, end to end, on a real server: the exports four AI apps wrote when they were sent the copy prompt
// (server/testing/notes-exports, made by scripts/notes-exports.ts through real models), and the OpenClaw and Hermes Agent
// folders a Mac holds. The app's own import code runs as it does in the renderer, its requests sent to a fixture server
// whose HOME is a throwaway folder; then what the server holds is checked: bots with their instructions, About me, each
// bot's memory, routines and skills, and the first bot's summary.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";


// the fixture server and the agent-app folders come from the server side, loaded at run time so the app's type check
// never reaches into server code
interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
const serverSide = async <T,>(path: string): Promise<T> => await import(/* @vite-ignore */ new URL(path, import.meta.url).href) as T;
const launcher = () => serverSide<{ launchVerificationServer(env: NodeJS.ProcessEnv): Promise<VerificationServer> }>("../../scripts/control-madani.ts");
const planters = () => serverSide<{ plantHermes(home: string): string[]; plantOpenClawList(home: string): string[] }>("../../server/testing/agent-app-fixtures.ts");

const server = vi.hoisted(() => ({ url: "", owner: "", answers: [] as Array<{ path: string; status: number; body: Record<string, unknown> }> }));
// the renderer's request helper, pointed at the fixture: same paths, same bodies, errors thrown the same way
vi.mock("@/state/store", async (original) => {
  const real = await original<typeof import("@/state/store")>();
  const api = async (path: string, init: RequestInit & { timeoutMs?: number } = {}) => {
    const { timeoutMs: _timeout, ...rest } = init;
    const response = await fetch(`${server.url}${path}`, {
      ...rest, headers: { "content-type": "application/json", origin: server.url, "x-madani-desktop-owner": server.owner },
    });
    const body = await response.json().catch(() => ({}));
    server.answers.push({ path, status: response.status, body });
    if (!response.ok) throw new real.ApiError(String(body?.error ?? response.status), response.status, body);
    return body;
  };
  return { ...real, api };
});
vi.mock("@/lib/copy-text", () => ({ copyText: async () => "copied" }));

import { copyNotesPrompt, importNotes, notesOutcomeLine, takeNotesFromDownloads, type NotesContext } from "@/lib/assistant-notes";
import { lookForOtherBots, planBotMove } from "@/lib/bot-move";
import { bringChosen, bringRunNow, localFinds } from "@/lib/first-run-import";
import { setLocale } from "@/lib/i18n";

const EXPORTS = join(import.meta.dirname, "..", "..", "server", "testing", "notes-exports");
const exported = (name: string) => readFileSync(join(EXPORTS, name), "utf8");

interface ServerBot { id: string; name: string; threadId: string; installedPackage?: { id: string } }
interface ServerRoutine { id: string; botId: string; name: string; prompt: string; enabled: boolean; schedule: { type: string; expression?: string; timeZone?: string } }

describe("bringing in what other AIs and agent apps hold, on a real server", () => {
  let fixture: VerificationServer;
  const get = async <T,>(path: string): Promise<T> => {
    const response = await fetch(`${fixture.info.url}${path}`, { headers: { origin: fixture.info.url, "x-madani-desktop-owner": server.owner } });
    expect(response.status, path).toBe(200);
    return await response.json() as T;
  };
  const bots = async () => (await get<{ bots: ServerBot[] }>("/api/bots")).bots;
  const bot = async (name: string) => {
    const found = (await bots()).find((one) => one.name === name);
    expect(found, `a bot named ${name}`).toBeTruthy();
    return found!;
  };
  const memory = async (botId: string, path: string) => (await get<{ text?: string }>(`/api/bots/${botId}/memory/file?path=${encodeURIComponent(path)}`)).text ?? "";
  const aboutMe = async () => (await get<{ profile?: { aboutMe?: string } }>("/api/config")).profile?.aboutMe ?? "";
  const routines = async () => (await get<{ routines: ServerRoutine[] }>("/api/routines")).routines;
  const skills = async (botId: string) => (await get<{ skills: Array<{ name: string; enabled?: boolean }> }>(`/api/bots/${botId}/skills`)).skills;
  /** What a bot runs on: its record (instructions included), its soul, and every memory topic it has, as one text. */
  const persona = async (botId: string) => {
    const record = (await get<{ bots: Array<Record<string, unknown>> }>("/api/bots")).bots.find((one) => one.id === botId);
    const soul = await get<unknown>(`/api/bots/${botId}/soul`).catch(() => null);
    const overview = await get<unknown>(`/api/bots/${botId}/memory`);
    const paths = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
        if (key === "path" && typeof child === "string" && child.endsWith(".md")) paths.add(child);
        else walk(child);
      }
    };
    walk(overview);
    const topics = await Promise.all([...paths].map((path) => memory(botId, path)));
    return [JSON.stringify(record), JSON.stringify(soul), JSON.stringify(overview), ...topics].join("\n");
  };
  let first: ServerBot;
  const realFetch = globalThis.fetch;
  const context = async (): Promise<NotesContext> => ({ bots: await bots() as never, aboutMe: await aboutMe(), team: false, firstBotId: first.id, dispatch: () => {} });

  beforeAll(async () => {
    setLocale("en");
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    server.owner = randomBytes(32).toString("base64url");
    // as the desktop app runs it: every request carries the app's owner capability, the launcher's own included
    globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-madani-desktop-owner": server.owner } });
    fixture = await (await launcher()).launchVerificationServer({ ...process.env, MADANI_TEST_DESKTOP_OWNER_TOKEN: server.owner });
    server.url = fixture.info.url;
    first = (await bots())[0]!;
  }, 120_000);
  afterAll(async () => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
    await fixture?.close();
  });

  it("ChatGPT's answer, pasted: its custom GPTs become bots, the person's facts About me, saved memories, paused routines and a summary", async () => {
    const outcome = await importNotes(exported("chatgpt.md"), await context());
    expect(outcome.failed).toEqual([]);
    expect(outcome.lost).toEqual([]);
    expect(outcome.botNames).toEqual(["Critique Partner", "Japanese Tutor"]);
    expect(outcome.routines).toBe(2);

    const critique = await bot("Critique Partner");
    expect(await persona(critique.id)).toContain("three biggest hierarchy problems");
    expect(await persona(critique.id)).toContain("lumen-design-principles.pdf");
    const tutor = await bot("Japanese Tutor");
    expect(await persona(tutor.id)).toContain("five vocab words with furigana");
    expect(await persona(tutor.id), "what the tutor knew about her").toMatch(/\bwa\b.{0,12}\bga\b/);

    const about = await aboutMe();
    expect(about).toMatch(/- \d{4}-\d{2}-\d{2} · learned by ChatGPT · /);
    expect(about).toMatch(/Lumen Health/);
    expect(about).toMatch(/Daniel Reyes/);
    expect(about, "custom instructions, word for word").toContain("Never use the word 'delve'");
    expect(await memory(first.id, "memory/notes-from-chatgpt.md")).toMatch(/cat named Biscoito/);
    expect(await memory(first.id, "memory/open-threads-from-chatgpt.md")).toMatch(/Copenhagen/);

    const digest = (await routines()).find((one) => one.name === "Weekly design digest");
    expect(digest).toMatchObject({ botId: first.id, enabled: false, prompt: expect.stringContaining("three notable product design articles"), schedule: { type: "cron", expression: "0 9 * * 1", timeZone: "Europe/Lisbon" } });
    expect((await routines()).find((one) => one.name === "Japanese streak")?.schedule).toMatchObject({ expression: "0 20 * * *" });
    expect(notesOutcomeLine(outcome)).toMatch(/^Brought in from ChatGPT: .*2 bots.*2 paused routines/);
    // one summary in the first bot's chat, written by the server
    await vi.waitFor(() => expect(server.answers.some((one) => one.path === `/api/bots/${first.id}/import-note`)).toBe(true));
    const notes = server.answers.filter((one) => one.path === `/api/bots/${first.id}/import-note`);
    expect(notes.map((one) => one.status)).toEqual([201, 201]);
    expect(String((notes[0]!.body.message as { text?: string }).text), "it says it got them first").toBe("Got it. Setting up your bots, memories and routines now…");
    const note = notes.at(-1)!;
    expect(note.status).toBe(201);
    const said = String((note.body.message as { text?: string }).text);
    expect(said).toMatch(/ChatGPT/);
    expect(said).toMatch(/Critique Partner/);
    expect(said).toMatch(/routine/i);
  }, 120_000);

  it("Claude's answer: Projects become bots with their knowledge files named, and the person's skill lands on the first bot, off", async () => {
    const outcome = await importNotes(exported("claude.md"), await context());
    expect(outcome.failed).toEqual([]);
    expect(outcome.botNames).toEqual(["Config talk", "Tide design system"]);
    expect(outcome.skills).toBe(1);
    expect(await persona((await bot("Tide design system")).id)).toContain("tide-color-surface-raised");
    expect(await persona((await bot("Config talk")).id)).toContain("talk-outline-v3.md");
    const meeting = (await skills(first.id)).find((one) => one.name === "meeting-notes");
    expect(meeting, "the person's own skill").toBeTruthy();
    expect(meeting!.enabled).not.toBe(true);
    expect(await aboutMe()).toMatch(/Inês Costa/);
    expect(await aboutMe()).toMatch(/penicillin/);
  }, 120_000);

  it("Gemini's answer, pasted into another bot's chat: that bot says it got them and posts the summary; Gems become bots, its monthly action a paused routine of the first bot", async () => {
    const critique = await bot("Critique Partner");
    const since = server.answers.length;
    const outcome = await importNotes(exported("gemini.md"), { ...await context(), chatBotId: critique.id });
    const notes = server.answers.slice(since).filter((one) => one.path.endsWith("/import-note"));
    expect(notes.map((one) => [one.path, one.status]), "both notes in Critique Partner's chat, none in the first bot's").toEqual([
      [`/api/bots/${critique.id}/import-note`, 201], [`/api/bots/${critique.id}/import-note`, 201],
    ]);
    expect(String((notes[0]!.body.message as { text?: string }).text)).toBe("Got it. Setting up your bots, memories and routines now…");
    expect(String((notes[1]!.body.message as { text?: string }).text)).toMatch(/Gemini[\s\S]*Trip Planner/);
    expect(await memory(first.id, "memory/notes-from-gemini.md"), "what Gemini remembered is still the first bot's").toMatch(/\S/);
    expect(outcome.failed).toEqual([]);
    expect(outcome.botNames).toEqual(["Trip Planner", "Mug Copywriter"]);
    expect(await persona((await bot("Mug Copywriter")).id)).toMatch(/under 140 characters/);
    expect((await routines()).find((one) => one.name === "Monthly budget check")).toMatchObject({ botId: first.id, enabled: false, schedule: { expression: "0 19 1 * *" } });
    expect(await aboutMe()).toMatch(/Renault Zoe/);
  }, 120_000);

  it("a Grok bot's answer, saved to Downloads after the prompt was copied, comes in by itself as one bot with its own routines and skills", async () => {
    expect(await copyNotesPrompt()).toBe(true);
    const downloads = join(fixture.info.dataDir, "Downloads");
    mkdirSync(downloads, { recursive: true });
    const file = join(downloads, "madani-bot-notes.md");
    writeFileSync(file, exported("grok-bot.md"));
    const later = new Date(Date.now() + 1_000);
    utimesSync(file, later, later);
    const outcome = await takeNotesFromDownloads(await context(), Date.now() + 2_000);
    expect(outcome, "the file was read from Downloads").toBeTruthy();
    expect(outcome!.failed).toEqual([]);
    expect(outcome!.botNames).toEqual(["Kiln"]);
    const kiln = await bot("Kiln");
    expect(await persona(kiln.id)).toContain("Never promise a ship date sooner than 5 business days");
    // a model may file a shop fact under the bot or under the person: either way it came in
    expect(`${await persona(kiln.id)}\n${await persona(first.id)}`).toMatch(/Tidepool/);
    const own = (await routines()).filter((one) => one.botId === kiln.id);
    expect(own.map((one) => one.schedule.expression).sort()).toEqual(["0 10 * * 0", "0 9 1 1,4,7,10 *", "30 8 * * *"]);
    expect(own.every((one) => !one.enabled), "a routine that moves in waits to be switched on").toBe(true);
    expect((await routines()).filter((one) => one.botId === first.id && /orders|kiln|Casa Ribeira/i.test(one.name)), "the bot's own routines are not also the first bot's").toEqual([]);
    expect((await skills(kiln.id)).map((one) => one.name).sort()).toEqual(expect.arrayContaining(["order-triage", "price-check"]));
    expect(await aboutMe(), "the bot's instructions are not the person's preferences").not.toContain("You run Okafor Clay's shop admin");
    expect(await takeNotesFromDownloads(await context(), Date.now() + 3_000), "the same file is brought in once").toBeNull();
  }, 120_000);

  it("the same export pasted again makes nothing twice", async () => {
    const before = { bots: (await bots()).length, routines: (await routines()).length };
    const outcome = await importNotes(exported("chatgpt.md"), await context());
    expect(outcome.bots).toBe(0);
    expect((await bots()).length).toBe(before.bots);
    expect((await routines()).length).toBe(before.routines);
  }, 120_000);

  it("OpenClaw and Hermes Agent folders on this computer are found and brought in on one press, with no prompt", async () => {
    const { plantHermes, plantOpenClawList } = await planters();
    plantOpenClawList(fixture.info.dataDir);
    plantHermes(fixture.info.dataDir);
    const look = await lookForOtherBots(10_000, { downloads: false });
    expect(look.bots.apps.map((app) => app.app).sort()).toEqual(["Hermes Agent", "OpenClaw"]);
    const plan = planBotMove(look, { bots: await bots() as never, servers: new Set(), timeZone: "Europe/Lisbon" });
    const finds = localFinds(plan, null);
    expect(finds.map((find) => find.app).sort()).toEqual(["Hermes Agent", "OpenClaw"]);
    const before = new Set((await bots()).map((one) => one.id));
    await bringChosen(finds, { dispatch: () => {}, firstBotId: first.id, aboutMe: await aboutMe(), team: false });
    const run = bringRunNow();
    expect(run).toMatchObject({ kind: "done", failed: false });
    const added = (await bots()).filter((one) => !before.has(one.id)).map((one) => one.name).sort();
    expect(added).toEqual(expect.arrayContaining(["Molty", "Scout", "Hermes", "Coder"]));
    expect(await persona((await bot("Hermes")).id)).toContain("honest about what you don't know");
    expect(await aboutMe(), "what Hermes knew about the person").toMatch(/Works nights; never message before noon/);
    const molty = await bot("Molty");
    expect((await routines()).filter((one) => one.botId === molty.id).map((one) => one.name)).toEqual(expect.arrayContaining(["Molty: Morning brief"]));
  }, 120_000);
});
