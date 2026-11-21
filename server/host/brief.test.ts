import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NeedsYouItem } from "../../shared/today.ts";
import type { CalendarEvent, EmailHeader } from "../connected-reads.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineRun } from "../routines.ts";
import { Store, type Message } from "../store.ts";
import { AWAY_MS, BRIEF_FILE, createBrief } from "./brief.ts";
import { briefMessage, plain } from "./brief-message.ts";
import { ENGLISH_BRIEF } from "./brief-words.ts";

const MINUTE = 60_000;
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const guest: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ada: EmailHeader = { id: "m1", threadId: "t1", at: 0, from: "Ada <ada@x.test>", subject: "Q3 numbers", preview: "Can you send them?" };
const standup: CalendarEvent = {
  id: "uid-1", title: "Standup", start: 0, end: 0, allDay: false, status: "confirmed", selfDeclined: false, joinUrl: "https://meet.google.com/abc",
  attendees: [{ email: "me@x.test", self: true, organizer: true }, { email: "ada@x.test", name: "Ada", self: false, organizer: false }],
};

function setup(options: { hosted?: boolean; needsYou?: NeedsYouItem[]; language?: string; ideas?: string[] } = {}) {
  let watching = true;
  const dir = mkdtempSync(join(tmpdir(), "madani-brief-"));
  dirs.push(dir);
  let now = Date.parse("2026-10-22T08:00:00Z");
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const chief = store.createBot({ name: "Chief" });
  store.setChiefOfStaff(chief.id);
  const notified: string[] = [];
  const failed: Array<[string, string]> = [];
  const kept: string[] = [];
  const items = new Map<string, { mail: EmailHeader[]; prep: Array<{ key: string; event: CalendarEvent }> }>();
  const runs: RoutineRun[] = [];
  let busy = false;
  const make = () => createBrief({
    store, dataDir: dir, now: () => now, hosted: options.hosted ?? false, watching: () => watching, mainThread: () => store.bot(chief.id)!.threadId, threadBusy: () => busy,
    notify: (_bot, _thread, detail) => notified.push(detail), runs: () => runs, needsYou: () => options.needsYou ?? [], engineName: () => "Claude",
    hostTimeZone: () => "UTC", language: () => options.language, session: () => null, address: () => "me@x.test",
    failRun: (id, why) => failed.push([id, why]), keep: (key) => kept.push(key), items: (key) => items.get(key) ?? null,
    ideas: (botId) => (botId === chief.id && options.ideas ? { ideas: options.ideas, conversations: 3 } : { ideas: [], conversations: 0 }),
  });
  let brief = make();
  const thread = () => store.bot(chief.id)!.threadId;
  const rows = (): Message[] => store.messagesFor(thread());
  const card = () => rows().findLast((message) => message.serverCard && message.kind === "text");
  const shown = () => card()?.text ?? "";
  const watchRun = (key: string, reply: string): RoutineRun => {
    const runThread = store.createTask(chief.id, "Keep an eye on my day", false)!.threadId;
    store.appendMessage(runThread, { role: "bot", kind: "text", text: reply, turnId: "turn-1" });
    return { id: `run-${key}`, routineId: "watch", routineName: "Keep an eye on my day", target: "bot", botId: chief.id, runOn: "maus", scheduledFor: now, status: "completed",
      manual: false, threadId: runThread, checkKey: key, deliver: "brief", access: "read-and-draft", createdAt: now };
  };
  return {
    get brief() { return brief; }, store, chief, notified, failed, kept, items, runs, rows, card, shown, watchRun, thread, dir,
    advance: (ms: number) => { now += ms; }, now: () => now, busy: (value: boolean) => { busy = value; }, restart: () => { brief = make(); },
    watch: (on: boolean) => { watching = on; },
  };
}

describe("the brief", () => {
  it("is an ordinary message in the chat: a short list of what needs the person, each naming the bot, linked to its chat", async () => {
    const needsYou: NeedsYouItem[] = [];
    const s = setup({ needsYou });
    const juno = s.store.createBot({ name: "Juno" });
    needsYou.push({ kind: "question", id: "q1", at: 0, botId: juno.id, threadId: juno.threadId, text: "Should I book the 9:40 flight to Lisbon?" });
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false, open: { botId: s.chief.id, threadId: s.thread() } });
    const message = s.card()!;
    expect(message).toMatchObject({ role: "bot", kind: "text", serverCard: true });
    expect(message.widget).toBeUndefined();
    expect(message.text).toBe([
      ENGLISH_BRIEF.intro,
      `Quick heads-up, one thing needs you:\n- [Juno asked you](<madanibot://thread/${juno.threadId}?bot=${juno.id}>): Should I book the 9:40 flight to Lisbon?`,
    ].join("\n\n"));
    expect(message.text).not.toMatch(/Your brief|Thursday|October/);
    expect(s.notified).toEqual(["Your brief: 1 needs you"]);
  });

  it("keeps untrusted words as words: no link, image, emphasis, math, heading or autolink", () => {
    expect(plain("[click](https://evil.test) ![x](https://t.test/p.png) **now** $x$ \\(y\\) <b> www.evil.test mailto:me@x.test a_b ~c~ &amp;"))
      .toBe("&#91;click&#93;(https:\u2060//evil.test) !&#91;x&#93;(https:\u2060//t.test/p.png) &#42;&#42;now&#42;&#42; &#36;x&#36; &#92;(y&#92;) &lt;b&gt; www\u2060.evil.test mailto:\u2060me@\u2060x.test a&#95;b &#126;c&#126; &amp;amp;");
    expect(plain("# Big")).toBe("&#35; Big");
    expect(plain("12. twelve")).toBe("12&#46; twelve");
    expect(plain("- item")).toBe("&#45; item");
    expect(plain("> quote")).toBe("&gt; quote");
    expect(plain("Ada asked: can we meet at 9:40?")).toBe("Ada asked: can we meet at 9:40?");
    const { text } = briefMessage({ now: 0, timeZone: "UTC", intro: false, needs: [], meetings: [{ title: "**Standup** [x](https://evil.test)", start: 0 }], routines: [],
      emails: [{ messageId: "m1", threadId: "t1", from: "[Ada](https://evil.test) <ada@x.test>", subject: "![p](https://t.test/p.png)", needsReply: true }] });
    expect(text).toContain("- [&#91;Ada&#93;(https:\u2060//evil.test) is waiting on your reply](<https://mail.google.com/mail/#all/t1>): !&#91;p&#93;(https:\u2060//t.test/p.png)");
    expect(text).toContain("On your calendar today: &#42;&#42;Standup&#42;&#42; &#91;x&#93;(https:\u2060//evil.test) at 12:00 AM.");
  });

  it.each(["completed", "failed"] as const)("includes a routine %s just after local midnight", async (status) => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "sign-in", at: 0, instanceId: "claude", botIds: [] }] });
    s.advance(21_643);
    const run = (name: string, finishedAt: number): RoutineRun => ({
      id: name, routineId: name, routineName: name, target: "bot", botId: s.chief.id, runOn: "maus",
      scheduledFor: finishedAt, status, manual: false, createdAt: finishedAt, finishedAt,
    });
    s.runs.push(run("Before midnight", Date.parse("2026-10-22T03:59:59.999Z")), run("After midnight", Date.parse("2026-10-22T04:00:00.001Z")));
    await s.brief.active("desktop", "America/New_York", "en");
    expect(s.shown()).toContain("After midnight");
    expect(s.shown()).not.toContain("Before midnight");
  });

  it("keeps what is only worth a look to a few lines, counts the rest, and still says how many new ones wait", () => {
    const emails = Array.from({ length: 8 }, (_, at) => ({ messageId: `m${at}`, threadId: `t${at}`, from: `Sender ${at} <s${at}@x.test>`, subject: `Subject ${at}`, needsReply: false }));
    const { text } = briefMessage({ now: Date.parse("2026-10-22T08:00:00Z"), timeZone: "UTC", intro: false, needs: [], meetings: null, emails, waiting: 3, routines: [] });
    expect(text).toContain("Also worth a look:\n- [Sender 0](<https://mail.google.com/mail/#all/t0>): Subject 0\n");
    expect(text).toContain("- and 4 more");
    expect(text).not.toContain("Subject 4");
    expect(text.endsWith(ENGLISH_BRIEF.waitingCount(3))).toBe(true);
  });

  it("offers the night's ideas as plain text on the first open of the day, without a notification", async () => {
    const s = setup({ ideas: ["Make the Friday report a routine", "<b>Save</b> the draft checklist as a skill"] });
    expect((await s.brief.active("desktop", "UTC")).open).toEqual({ botId: s.chief.id, threadId: s.thread() });
    expect(s.shown()).toContain("- An idea from your chats: Make the Friday report a routine");
    expect(s.shown()).toContain("- An idea from your chats: &lt;b&gt;Save&lt;/b&gt; the draft checklist as a skill");
    expect(s.notified).toEqual([]);
  });

  it("lists ideas after routines, counts them in the summary, and says one quiet line when there is nothing", () => {
    const facts = { now: Date.parse("2026-10-22T08:00:00Z"), timeZone: "UTC", intro: false, needs: [], meetings: null, emails: [], routines: [] };
    const none = briefMessage(facts);
    expect(none.text).toBe(ENGLISH_BRIEF.nothingNeedsYou);
    const many = briefMessage({ ...facts, routines: [{ text: "Tidy my inbox", note: "Done." }], ideas: Array.from({ length: 7 }, (_, i) => ({ text: `Idea ${i}`, note: "" })) });
    expect(many.text.indexOf("Tidy my inbox")).toBeLessThan(many.text.indexOf("Idea 0"));
    expect(many.text).toContain("- and 4 more");
    expect(many.summary).toContain("7 ideas");
  });

  it("is not there while it has nothing for the person, so an open never takes the screen for an empty message", async () => {
    const needsYou: NeedsYouItem[] = [];
    const s = setup({ needsYou });
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false });
    expect(s.card()).toBeUndefined();
    // Something needs the person later that day: a ping while they use the app neither posts the brief nor opens it.
    needsYou.push({ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] });
    s.advance(5 * MINUTE);
    expect(await s.brief.active("desktop")).toEqual({ returned: false });
    expect(s.card()).toBeUndefined();
    // A check's news posts it, still without taking the screen.
    await s.brief.report({ routine: {} as never, at: s.now(), trouble: [{ app: "gmail", signedOut: false }] });
    expect(s.shown()).toContain("Couldn't read Gmail");
    expect(s.shown()).toContain(ENGLISH_BRIEF.intro);
    s.advance(5 * MINUTE);
    expect(await s.brief.active("desktop")).toEqual({ returned: false });
  });

  it("shows on the first open of a day, saying what it does, and once more only after three hours away", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false, open: { botId: s.chief.id, threadId: s.thread() } });
    expect(s.shown()).toContain(ENGLISH_BRIEF.intro);
    expect(s.shown()).toContain("Claude is signed out");
    const first = s.card()!;
    s.advance(30 * MINUTE);
    expect(await s.brief.active("desktop")).toEqual({ returned: false });
    s.advance(AWAY_MS);
    expect(await s.brief.active("desktop")).toMatchObject({ returned: true, open: { threadId: s.thread() } });
    expect(s.card()).toEqual(first);
    await s.brief.report({ routine: {} as never, at: s.now(), trouble: [{ app: "gmail", signedOut: false }] });
    expect(s.card()!.id).toBe(first.id);
    expect(s.shown()).toContain(ENGLISH_BRIEF.intro);
    expect(s.shown()).toContain("Quick heads-up, 2 things need you:");
    expect(s.rows().filter((message) => message.serverCard)).toHaveLength(1);
  });

  it("keeps its home chat when the person starts a newer one, and posts a new message the next day without the intro", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    await s.brief.active("desktop", "UTC");
    const home = s.thread();
    const first = s.card()!.id;
    s.store.createTask(s.chief.id, "A newer chat", true);
    s.advance(24 * 60 * MINUTE);
    await s.brief.active("desktop");
    const today = s.store.messagesFor(home).findLast((message) => message.serverCard)!;
    expect(today.id).not.toBe(first);
    expect(today).toMatchObject({ role: "bot", kind: "text" });
    expect(today.text).toBe("Quick heads-up, one thing needs you:\n- Claude is signed out: Sign in again in Settings, Model providers.");
  });

  it("speaks the language set in Settings", async () => {
    const s = setup({ language: "pt-BR", needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    await s.brief.active("desktop", "UTC");
    s.notified.length = 0;
    s.items.set("chk-1", { mail: [ada], prep: [] });
    await s.brief.consume(s.watchRun("chk-1", '{"important": [{"id": "m1", "why": "Ada precisa dos números.", "needsReply": true}], "prep": []}'), "turn-1");
    const shown = s.shown();
    expect(shown).toContain("Um aviso rápido, 2 coisas precisam de você:");
    expect(shown).toContain("- [Ada está esperando sua resposta](<https://mail.google.com/mail/#all/t1>): Q3 numbers · Ada precisa dos números.");
    expect(shown).toContain("Sessão encerrada em Claude");
    expect(shown).not.toMatch(/heads-up|waiting on your reply|Sign in again/);
    expect(s.notified).toEqual(["Seu resumo: 2 precisam de você"]);
  });

  it("follows the language the person's app shows over the server's, and switches today's message in place", async () => {
    const s = setup({ language: "pt-br", needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    await s.brief.active("desktop", "UTC", "es");
    const first = s.card()!.id;
    expect(s.shown()).toContain("Un aviso rápido, hay una cosa que te necesita:");
    s.advance(2 * MINUTE);
    expect(await s.brief.active("desktop", "UTC", "de")).toEqual({ returned: false });
    expect(s.shown()).toContain("Kurz zur Info, eine Sache wartet auf dich:");
    expect(s.rows().filter((message) => message.serverCard).map((message) => message.id)).toEqual([first]);
    s.restart();
    await s.brief.refresh();
    expect(s.shown()).toContain("Kurz zur Info, eine Sache wartet auf dich:");
  });

  it("does not tell the person again about the same rows when only the language changed", async () => {
    const options = { language: "es", needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] as NeedsYouItem[] };
    const s = setup(options);
    await s.brief.active("desktop", "UTC");
    expect(s.notified).toEqual(["Tu resumen: 1 te necesita"]);
    options.language = "de";
    await s.brief.refresh();
    expect(s.shown()).toContain("Kurz zur Info, eine Sache wartet auf dich:");
    expect(s.notified).toHaveLength(1);
  });

  it("a routine run that published a page links the page itself, beside the link to its chat", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    const PAGE = "https://abcdefghijklmnopqrstuvwxyz.page.madani.bot/";
    const run = (id: string, name: string, card?: "live" | "unpublished"): RoutineRun => {
      const threadId = s.store.createTask(s.chief.id, name, false)!.threadId, startedAt = Date.now();
      if (card) s.store.appendMessage(threadId, { role: "bot", kind: "text", text: `Published “Sales”: ${PAGE}`, publishedPage: { state: card, title: "Sales", pageId: "abcdefghijklmnopqrstuvwxyz", url: PAGE } });
      s.store.appendMessage(threadId, { role: "bot", kind: "text", text: "Updated the dashboard." });
      return { id, routineId: id, routineName: name, target: "bot", botId: s.chief.id, runOn: "maus", scheduledFor: s.now(), status: "completed", manual: false,
        threadId, createdAt: startedAt, startedAt, finishedAt: Date.now(), output: "Updated the dashboard." };
    };
    s.runs.push(run("dash", "Refresh the sales dashboard", "live"), run("gone", "Old dashboard", "unpublished"), run("plain", "Tidy my inbox"));
    await s.brief.active("desktop", "UTC");
    const dash = s.store.bot(s.chief.id)!.tasks!.find((task) => task.title === "Refresh the sales dashboard")!.threadId;
    expect(s.shown()).toContain(`- [Refresh the sales dashboard](<madanibot://thread/${dash}?bot=${s.chief.id}>): Updated the dashboard. · [Open page](<${PAGE}>)`);
    expect(s.shown().match(/\[Open page\]/g)).toHaveLength(1);
    expect(s.shown().match(/\(<madanibot:\/\/thread\//g)).toHaveLength(3);
  });

  it("a watch run's answer becomes lines and a prep card, and tells the person once", async () => {
    const s = setup();
    await s.brief.active("desktop", "UTC");
    s.notified.length = 0;
    s.items.set("chk-1", { mail: [ada], prep: [{ key: "uid-1", event: { ...standup, start: s.now() + 60 * MINUTE, end: s.now() + 90 * MINUTE } }] });
    await s.brief.consume(s.watchRun("chk-1", '{"important": [{"id": "m1", "why": "Ada needs the numbers by Friday.", "needsReply": true}], "prep": [{"id": "uid-1", "brief": "Ada runs it."}]}'), "turn-1");
    expect(s.kept).toEqual(["chk-1"]);
    expect(s.shown()).toBe([
      ENGLISH_BRIEF.intro,
      "Quick heads-up, one thing needs you:\n- [Ada is waiting on your reply](<https://mail.google.com/mail/#all/t1>): Q3 numbers · Ada needs the numbers by Friday.",
    ].join("\n\n"));
    const prep = s.rows().find((message) => message.widget?.root.title === "Prep: Standup")!;
    expect(prep.serverCard).toBe(true);
    expect(s.notified).toEqual(["Prep ready: Standup, Today, 9:00 AM to 9:30 AM", "Your brief: 1 needs you"]);
    await s.brief.refresh();
    expect(s.notified).toHaveLength(2);
  });

  it("an answer that is not the JSON asked for fails the run and posts nothing", async () => {
    const s = setup();
    await s.brief.active("desktop", "UTC");
    const before = s.rows().length;
    s.items.set("chk-1", { mail: [ada], prep: [] });
    await s.brief.consume(s.watchRun("chk-1", "Sure! Ada wants the Q3 numbers."), "turn-1");
    expect(s.failed).toEqual([["run-chk-1", expect.stringContaining("could not be read")]]);
    expect(s.kept).toEqual([]);
    expect(s.rows().length).toBe(before);
  });

  it("Dismiss on today's card from before the brief was a message is still the owner's and starts no turn", async () => {
    const s = setup();
    await s.brief.active("desktop", "UTC");
    s.items.set("chk-1", { mail: [ada], prep: [] });
    await s.brief.consume(s.watchRun("chk-1", '{"important": [{"id": "m1", "why": "Needs a reply.", "needsReply": false}]}'), "turn-1");
    const message = s.card()!;
    const dismiss = { type: "dismiss_row", payload: { messageId: "m1" } };
    expect(s.brief.serverPress(s.chief, s.thread(), message.id, dismiss, owner), "the message itself has nothing to press").toBeNull();
    // A card the brief posted before it became a message, today's.
    const legacy = s.store.appendMessage(s.thread(), { role: "bot", kind: "widget", serverCard: true, text: "Your brief", widget: { v: 1, root: { type: "Card", id: "root", title: "Your brief", children: [] } as never } });
    const file = join(s.dir, BRIEF_FILE);
    const state = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...state, card: { ...state.card, messageId: legacy.id } }));
    s.restart();
    expect(s.brief.serverPress(s.chief, s.thread(), legacy.id, dismiss, guest)).toBe("refused");
    expect(s.brief.serverPress({ id: "someone-else" }, s.thread(), legacy.id, dismiss, owner)).toBeNull();
    expect(s.brief.serverPress(s.chief, s.thread(), legacy.id, { type: "draft_reply", payload: { messageId: "m1" } }, owner)).toBeNull();
    expect(s.brief.serverPress(s.chief, s.thread(), legacy.id, dismiss, owner)).toBe("handled");
    // Nothing is left for the person, so coming back neither posts nor opens a brief.
    s.advance(AWAY_MS);
    expect(await s.brief.active("desktop")).toEqual({ returned: true });
    expect(s.card()!.id).toBe(message.id);
    expect(JSON.parse(readFileSync(file, "utf8")).dismissed.map((one: { messageId: string }) => one.messageId)).toEqual(["m1"]);
  });

  it("a Draft a reply press carries the email as records, by its id only", async () => {
    const s = setup();
    await s.brief.active("desktop", "UTC");
    s.items.set("chk-1", { mail: [ada], prep: [] });
    await s.brief.consume(s.watchRun("chk-1", '{"important": [{"id": "m1", "why": "Needs a reply.", "needsReply": true}]}'), "turn-1");
    const records = s.brief.pressRecords(s.chief, { type: "draft_reply", payload: { messageId: "m1" } })!;
    expect(records).toContain("[Records from Gmail.");
    expect(records).toContain("from Ada <ada@x.test>");
    expect(records).toContain("Do not send it.");
    expect(s.brief.pressRecords(s.chief, { type: "draft_reply", payload: { messageId: "forged" } })).toBeNull();
  });

  it("posts the 10-minute reminder with no AI, says when a read failed, and lists what only the person can fix", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    await s.brief.active("desktop", "UTC");
    await s.brief.report({ routine: {} as never, at: s.now(), meetings: [{ ...standup, start: s.now() + 9 * MINUTE, end: s.now() + 40 * MINUTE }], clashes: [],
      remind: [{ ...standup, start: s.now() + 9 * MINUTE, end: s.now() + 40 * MINUTE }], trouble: [{ app: "gmail", signedOut: true }] });
    expect(s.rows().some((message) => message.serverCard && message.widget?.root.title === "Standup with Ada in 9 minutes")).toBe(true);
    expect(s.shown()).toContain("Couldn't read Gmail");
    expect(s.shown()).toContain("Reconnect Gmail in Connected apps.");
    expect(s.shown()).toContain("Claude is signed out");
    expect(s.shown()).toContain("On your calendar today: Standup at 8:09 AM.");
  });

  it("waits for a busy chat instead of writing into a turn", async () => {
    const s = setup();
    await s.brief.active("desktop", "UTC");
    s.busy(true);
    await s.brief.report({ routine: {} as never, at: s.now(), trouble: [{ app: "gmail", signedOut: false }] });
    expect(s.shown()).not.toContain("Couldn't read Gmail");
    s.busy(false);
    s.brief.tick();
    await vi.waitFor(() => expect(s.shown()).toContain("Couldn't read Gmail"));
  });

  it("is not there while its routine is paused or deleted: that is its off switch", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    s.watch(false);
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false });
    await s.brief.report({ routine: {} as never, at: s.now(), trouble: [{ app: "gmail", signedOut: true }] });
    expect(s.card()).toBeUndefined();
    s.watch(true);
    s.advance(AWAY_MS);
    expect(await s.brief.active("desktop")).toMatchObject({ returned: true, open: { threadId: s.thread() } });
  });

  it("is never there on a hosted team workspace or a Team Cloud", async () => {
    const s = setup({ hosted: true });
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false });
    expect(s.card()).toBeUndefined();
  });
});
