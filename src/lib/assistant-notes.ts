// Notes from an AI this computer can't read (ChatGPT, Claude, Gemini, Grok): the prompt is copied in the first run and
// the person goes straight on. The block that AI writes back can be pasted or dropped into any chat whenever it is
// ready; meanwhile the first bot's chat shows one quiet "waiting" line, and one reminder comes 15 minutes later.
import { useSyncExternalStore } from "react";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api, type Action, type Bot, type ConfigStatus } from "@/state/store";
import {
  aboutMeWithNotes, isNotesPrompt, NOTES_MAX_CHARS, looksLikeNotes, notesMemoryFile, notesMemoryText, notesThreadsFile, notesThreadsText, NOTES_PROMPT, parseNotes, type AssistantNotes,
} from "../../shared/assistant-notes";
import { notesNoteFacts, postImportNote } from "./import-note";
import { arrivalFailed, noteArrival, setNotesWork, type NotesVia } from "./notes-arrival";
import { distillChunks, distillLines } from "../../shared/memory-distill";
import { GrokImportError } from "../../shared/grok-import";
import { copyText } from "./copy-text";
import type { SaveFacts } from "./grok-move";
import { saveTeamProfile } from "./own-profile";

export { isNotesPrompt, looksLikeNotes };

const KEY = "madani.notesWaiting";
export const REMIND_AFTER_MS = 15 * 60_000;

export interface NotesWaiting { since: number; reminded?: boolean }

const listeners = new Set<() => void>();
let cached: { raw: string | null; value: NotesWaiting | null } = { raw: null, value: null };

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function notesWaiting(): NotesWaiting | null {
  const raw = storage()?.getItem(KEY) ?? null;
  if (raw === cached.raw) return cached.value;
  let value: NotesWaiting | null = null;
  try {
    const parsed = raw ? JSON.parse(raw) as Partial<NotesWaiting> : null;
    if (parsed && typeof parsed.since === "number") value = { since: parsed.since, ...(parsed.reminded ? { reminded: true } : {}) };
  } catch {}
  cached = { raw, value };
  return value;
}

function setWaiting(next: NotesWaiting | null) {
  try {
    if (next) storage()?.setItem(KEY, JSON.stringify(next));
    else storage()?.removeItem(KEY);
  } catch {}
  for (const listener of listeners) listener();
}

export function stopWaiting() { if (notesWaiting()) setWaiting(null); }

export function useNotesWaiting(): NotesWaiting | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, notesWaiting, () => null);
}

/** Copies the prompt and starts waiting for its answer; a copy again keeps the first start, so the reminder stays put.
 * It also starts watching Downloads for the file the prompt asks for: only from now, so macOS asks about Downloads
 * when the person has just asked for that file, never before. */
export async function copyNotesPrompt(now = Date.now()): Promise<boolean> {
  const copied = (await copyText(NOTES_PROMPT)) === "copied";
  if (copied && !notesWaiting()) setWaiting({ since: now });
  if (copied) {
    const watch = notesWatch();
    const live = watch && now <= watch.until;
    setWatch({ since: live ? watch.since : now, until: now + WATCH_FOR_MS, taken: watch?.taken ?? [] });
  }
  return copied;
}

const WATCH_KEY = "madani.notesWatch";
/** How long after a copy Downloads is checked for the notes file, and how much longer after each one that came. */
export const WATCH_FOR_MS = 3 * 60 * 60_000;
export const WATCH_AFTER_FILE_MS = 30 * 60_000;
export const WATCH_EVERY_MS = 4_000;

/** `since`: the first copy; only files saved after it are read. `taken`: files already brought in, by name and time. */
export interface NotesWatch { since: number; until: number; taken: string[] }

export function notesWatch(): NotesWatch | null {
  try {
    const parsed = JSON.parse(storage()?.getItem(WATCH_KEY) ?? "null") as Partial<NotesWatch> | null;
    return parsed && typeof parsed.since === "number" && typeof parsed.until === "number"
      ? { since: parsed.since, until: parsed.until, taken: Array.isArray(parsed.taken) ? parsed.taken.filter((one): one is string => typeof one === "string") : [] }
      : null;
  } catch {
    return null;
  }
}

function setWatch(next: NotesWatch) {
  try { storage()?.setItem(WATCH_KEY, JSON.stringify(next)); } catch {}
}

/** The notes file another AI saved to Downloads since the prompt was copied, brought in once: each file (or the parts
 * of a split one, together) by its name and time. Null when nothing new is there, or the watch is over. */
export async function takeNotesFromDownloads(context: NotesContext, now = Date.now()): Promise<NotesOutcome | null> {
  const watch = notesWatch();
  if (!watch || now > watch.until) return null;
  const answer = await api<{ files?: Array<{ name: string; modifiedAt: number; text: string }> }>(
    `/api/setup-import/notes?since=${Math.floor(watch.since)}`, { timeoutMs: 10_000 },
  ).catch(() => null);
  const fresh = (answer?.files ?? []).filter((file) => !watch.taken.includes(`${file.name}:${file.modifiedAt}`));
  if (!fresh.length) return null;
  const latest = notesWatch() ?? watch;
  setWatch({ ...latest, until: Math.max(latest.until, now + WATCH_AFTER_FILE_MS), taken: [...latest.taken, ...fresh.map((file) => `${file.name}:${file.modifiedAt}`)].slice(-50) });
  const notes = fresh.filter((file) => looksLikeNotes(file.text) && !isNotesPrompt(file.text));
  if (!notes.length) return null;
  noteArrival("downloads", context.firstBotId);
  try {
    return await importNotes(notes.map((file) => file.text).join("\n\n"), context, { via: "downloads" });
  } catch (cause) {
    arrivalFailed(notesErrorLine(cause));
    return null;
  }
}

/** One reminder, REMIND_AFTER_MS after the prompt was copied, only while still waiting and only once. Missed while the
 * app was closed, it is not shown late: the waiting line in the chat says it. Returns the cancel. */
export function scheduleNotesReminder(show: () => void, now = Date.now()): () => void {
  const waiting = notesWaiting();
  if (!waiting || waiting.reminded) return () => {};
  const left = waiting.since + REMIND_AFTER_MS - now;
  if (left < -60_000) {
    setWaiting({ ...waiting, reminded: true });
    return () => {};
  }
  const timer = setTimeout(() => {
    const still = notesWaiting();
    if (!still || still.reminded) return;
    setWaiting({ ...still, reminded: true });
    show();
  }, Math.max(0, left));
  return () => clearTimeout(timer);
}

/** One move's facts for About me, across all its bots, and what pasted notes may add at once. */
export const ABOUT_ME_MOVE_CAP = 40;
export const NOTES_ABOUT_CAP = 80;
export const NOTES_MEMORY_CAP = 200;

// a learned line is compared by its fact, not its date and source
const aboutLines = (text: string) => text.split("\n").map((line) => line.replace(/^\s*-\s*\d{4}-\d{2}-\d{2} · learned by [^·\n]* · /, "").replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).filter(Boolean);

export interface NotesContext {
  bots: readonly Bot[];
  aboutMe: string;
  team: boolean;
  /** The first bot, whose memory keeps what the other AI remembered. */
  firstBotId: string | null;
  /** The bot whose chat the notes were pasted or dropped into: it says it got them, works through them on its working
   * row and posts the summary. None (Downloads, a screen of its own): the first bot does. */
  chatBotId?: string | null;
  dispatch: (action: Action) => void;
}

/** `failed`: bots that couldn't be made; `lost`: parts that couldn't be saved. */
export interface NotesOutcome {
  from: string; facts: number; memories: number; bots: number; failed: string[]; lost?: Array<"about" | "memory">; partial: boolean;
  /** Open threads and recurring tasks kept in the first bot's memory. */
  threads?: number;
  botNames?: string[];
  /** Bots an earlier part made that this part added to. */
  joined?: number;
  routines?: number;
  /** The person's own skills, added to the first bot. */
  skills?: number;
}

async function writeAboutMe(text: string, context: Pick<NotesContext, "team" | "dispatch">): Promise<string> {
  const profile = context.team
    ? await saveTeamProfile({ aboutMe: text })
    : (await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ profile: { aboutMe: text } }), timeoutMs: 10_000 })).profile;
  const saved = profile?.aboutMe ?? text;
  context.dispatch({ type: "profileSaved", profile: { aboutMe: saved } });
  return saved;
}

/** About me as one place for facts about the person, whichever app or bot they came from: each fact once, under a
 * heading for the app. Keeps the text it saved, so several apps in a row add to each other rather than overwrite. */
export function aboutMeSaver(context: Pick<NotesContext, "aboutMe" | "team" | "dispatch">): SaveFacts {
  let current = context.aboutMe;
  let room = ABOUT_ME_MOVE_CAP;
  let queue: Promise<unknown> = Promise.resolve();
  return (facts, from) => {
    const next = queue.then(async () => {
      // each fact once, near-repeats of what About me says already left out, and only so many from one move
      const kept = distillLines(facts, { cap: Math.max(0, room), seen: aboutLines(current) }).keep;
      room -= kept.length;
      const about = aboutMeWithNotes(current, { from: { name: from, key: "" }, aboutMe: kept, instructions: "" });
      if (about) current = await writeAboutMe(about.text, context);
      return true;
    });
    queue = next.catch(() => {});
    return next;
  };
}

async function saveAboutMe(notes: AssistantNotes, context: NotesContext): Promise<{ added: number; text: string }> {
  const about = aboutMeWithNotes(context.aboutMe, notes);
  if (!about) return { added: 0, text: context.aboutMe };
  return { added: about.added, text: await writeAboutMe(about.text, context) };
}

/** One memory topic of a bot, merged with what is there: `build` gets the text before and answers the text after, or
 * null when nothing is new. */
async function mergeTopic(botId: string, path: string, build: (before: string) => string | null): Promise<boolean> {
  const file = `/api/bots/${encodeURIComponent(botId)}/memory/file`;
  const before = await api<{ text?: string }>(`${file}?path=${encodeURIComponent(path)}`).then((doc) => doc.text ?? "", () => "");
  const text = build(before);
  if (!text || text === before) return false;
  await api(file, { method: "PUT", body: JSON.stringify({ path, text }) });
  return true;
}

async function saveMemories(notes: AssistantNotes, botId: string | null): Promise<number> {
  if (!botId || !notes.memories.length) return 0;
  return await mergeTopic(botId, notesMemoryFile(notes), (before) => notesMemoryText(notes, before)) ? notes.memories.length : 0;
}

/** The person's own routines (not one of the bots'), as real routines of the first bot: paused, as any routine that
 * moves in is, until they switch it on. One already there with the same name and words is not made again. Those with no
 * readable clock are left for the open threads note. */
async function saveRoutines(notes: AssistantNotes, botId: string | null): Promise<{ made: number; kept: AssistantNotes["recurring"] }> {
  if (!botId || !notes.recurring.length) return { made: 0, kept: notes.recurring };
  const { notesRoutineSchedule } = await import("../../shared/grok-import");
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const there = await api<{ routines?: Array<{ botId?: string; name?: string; prompt?: string }> }>("/api/routines").then((answer) => answer.routines ?? [], () => []);
  const same = (a = "", b = "") => a.trim().toLowerCase() === b.trim().toLowerCase();
  let made = 0;
  const kept: AssistantNotes["recurring"] = [];
  for (const task of notes.recurring) {
    const schedule = notesRoutineSchedule(task, timeZone);
    if (!schedule) { kept.push(task); continue; }
    const name = (task.name || task.instruction.split(/\s+/).slice(0, 6).join(" ")).slice(0, 80);
    if (there.some((one) => one.botId === botId && same(one.name, name) && same(one.prompt, task.instruction))) { made += 1; continue; }
    try {
      await api("/api/routines", { method: "POST", body: JSON.stringify({ botId, name, prompt: task.instruction, schedule, enabled: false }) });
      made += 1;
    } catch { kept.push(task); }
  }
  return { made, kept };
}

/** The person's own skills, on the first bot, switched off until they read them, like any skill that moves in. */
async function saveSkills(notes: AssistantNotes, botId: string | null): Promise<number> {
  if (!botId || !notes.skills.length) return 0;
  const { notesSkillTemplate } = await import("../../shared/grok-import");
  const there = await api<{ skills?: Array<{ name: string }> }>(`/api/bots/${encodeURIComponent(botId)}/skills`).then((answer) => answer.skills ?? [], () => []);
  const taken = new Set(there.map((skill) => skill.name));
  let added = 0;
  for (const skill of notes.skills) {
    // the same skill brought in before is there under its own name: not added twice
    const base = notesSkillTemplate(skill, new Set())?.name;
    const entry = base && !taken.has(base) ? notesSkillTemplate(skill, taken) : null;
    if (!entry) continue;
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/skill-template`, { method: "POST", body: JSON.stringify({
        name: entry.name, description: entry.description, text: entry.instructions, source: `notes from ${notes.from.name}`, enabled: false,
      }) });
      added += 1;
    } catch {}
  }
  return added;
}

async function saveThreads(notes: AssistantNotes, botId: string | null): Promise<number> {
  const count = notes.openThreads.length + notes.recurring.length;
  if (!botId || !(count || notes.apps.length)) return 0;
  return await mergeTopic(botId, notesThreadsFile(notes), (before) => notesThreadsText(notes, before)) ? count : 0;
}

/** A later part naming a bot an earlier part already made: what it remembers joins that bot rather than making another. */
async function joinMovedBots(notes: AssistantNotes, bots: readonly Bot[], movedNames: readonly string[]): Promise<number> {
  if (!movedNames.length) return 0;
  const { grokMovePlan } = await import("../../shared/grok-import");
  let joined = 0;
  for (const bot of notes.bots.filter((one) => movedNames.includes(one.name))) {
    try {
      const plan = grokMovePlan(bot, { from: notes.from });
      const here = bots.find((one) => one.installedPackage?.id === plan.packageId);
      if (!here) continue;
      const memories = { from: notes.from, memories: [...bot.memories] };
      const files = Object.entries(bot.memoryFiles ?? {});
      let changed = await mergeTopic(here.id, notesMemoryFile(notes), (before) => notesMemoryText(memories, before));
      for (const [path, text] of files) changed = await mergeTopic(here.id, path, (before) => (before.trim() ? null : text)) || changed;
      if (changed) joined += 1;
    } catch {}
  }
  return joined;
}

/** Everything in the notes, each part on its own: About me, the first bot's memory, then a bot for each of the other
 * AI's own assistants. A part that fails leaves the others in; the waiting stops once anything came in. */
export async function importNotes(text: string, context: NotesContext, options: { via?: NotesVia } = {}): Promise<NotesOutcome> {
  const parsed = parseNotes(text);
  // read: the first bot says it got them in its chat, and its working row shows each step until the summary
  const worker = context.chatBotId || context.firstBotId;
  const step = (label: string) => { if (worker) setNotesWork(worker, label); };
  step(t("composer.notes.row.reading", { from: parsed.from.name }));
  if (worker) await postImportNote(worker, { from: [parsed.from.name], start: true });
  try {
    return await bringNotesIn(parsed, context, options, step, worker);
  } finally {
    if (worker) setNotesWork(worker, null);
  }
}

async function bringNotesIn(parsed: AssistantNotes, context: NotesContext, options: { via?: NotesVia }, step: (label: string) => void, worker: string | null): Promise<NotesOutcome> {
  // the rules pass: noise and near-repeats out; another AI's own notes are already chosen, so the caps are wider
  const seen = aboutLines(context.aboutMe);
  const memories = distillLines(parsed.memories, { cap: NOTES_MEMORY_CAP, seen: [...seen] });
  const notes = { ...parsed, aboutMe: distillLines(parsed.aboutMe, { cap: NOTES_ABOUT_CAP, seen }).keep, memories: memories.keep };
  const outcome: NotesOutcome = { from: notes.from.name, facts: 0, memories: 0, threads: 0, bots: 0, botNames: [], joined: 0, routines: 0, failed: [], lost: [], partial: notes.partial };
  let aboutMe = context.aboutMe;
  step(t("composer.notes.row.memory"));
  try {
    const saved = await saveAboutMe(notes, context);
    outcome.facts = saved.added;
    aboutMe = saved.text;
  } catch { outcome.lost!.push("about"); }
  try { outcome.memories = await saveMemories(notes, context.firstBotId); } catch { outcome.lost!.push("memory"); }
  // passages and the overflow: the first bot's engine condenses them, now or once it has one
  const later = distillChunks(memories.later.length ? [`What ${notes.from.name} remembered:\n${memories.later.map((line) => `- ${line}`).join("\n")}`] : []);
  if (later.length && context.firstBotId) {
    await api(`/api/bots/${encodeURIComponent(context.firstBotId)}/memory/import-distill`, { method: "POST", body: JSON.stringify({ from: notes.from.name, chunks: later.slice(0, 10) }) }).catch(() => {});
  }
  let general = notes.recurring;
  if (notes.recurring.length || notes.skills.length) step(t("composer.notes.row.routines"));
  try {
    const routines = await saveRoutines(notes, context.firstBotId);
    outcome.routines = routines.made;
    general = routines.kept;
  } catch {}
  try { outcome.skills = await saveSkills(notes, context.firstBotId); } catch {}
  try { outcome.threads = await saveThreads({ ...notes, recurring: general }, context.firstBotId); } catch { outcome.lost!.push("memory"); }
  if (notes.bots.length) {
    const [{ runBotMove }, { previewGrokMove }] = await Promise.all([import("./bot-move"), import("./grok-move")]);
    const servers = await api<{ servers?: Array<{ name: string }> }>("/api/mcp/servers").then((answer) => answer.servers ?? [], () => []);
    const preview = previewGrokMove(notes.bots, {
      bots: context.bots, servers: new Set(servers.map((server) => server.name)), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, from: notes.from,
    });
    const saveFacts = aboutMeSaver({ ...context, aboutMe });
    const reports = await runBotMove({ apps: [{ app: notes.from.name, where: "", from: notes.from, preview, channels: [], unreadable: [] }], grokWaiting: [] }, context.dispatch, (_done, name) => step(t("composer.notes.row.bot", { name })), saveFacts);
    const moved = reports.flatMap((one) => one.report.bots);
    outcome.bots = moved.length;
    outcome.botNames = moved.map((bot) => bot.name);
    outcome.routines = (outcome.routines ?? 0) + moved.reduce((sum, bot) => sum + bot.routines, 0);
    outcome.failed.push(...reports.flatMap((one) => one.report.failed));
    outcome.joined = await joinMovedBots(notes, context.bots, preview.moved);
  }
  const came = outcome.facts || outcome.memories || outcome.threads || outcome.bots || outcome.joined || outcome.routines || outcome.skills;
  if (came || !(outcome.failed.length || outcome.lost!.length)) stopWaiting();
  if (came && worker) await postImportNote(worker, { ...notesNoteFacts(outcome), ...(options.via === "downloads" ? { via: "downloads" as const } : {}) });
  return outcome;
}

const list = (parts: string[]) => new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(parts);
const count = (n: number, one: LocaleKey, many: LocaleKey) => (n === 1 ? t(one) : t(many, { count: n }));

/** One sentence for what came in, and what didn't. */
export function notesOutcomeLine(outcome: NotesOutcome): string {
  const parts = [
    ...(outcome.facts ? [count(outcome.facts, "composer.notes.factsOne", "composer.notes.facts")] : []),
    ...(outcome.memories ? [count(outcome.memories, "composer.notes.memoriesOne", "composer.notes.memories")] : []),
    ...(outcome.threads ? [count(outcome.threads, "composer.notes.threadsOne", "composer.notes.threads")] : []),
    ...(outcome.bots ? [count(outcome.bots, "composer.notes.botsOne", "composer.notes.bots")] : []),
    ...(outcome.joined ? [count(outcome.joined, "composer.notes.joinedOne", "composer.notes.joined")] : []),
    ...(outcome.routines ? [count(outcome.routines, "bring.routinesOne", "bring.routines")] : []),
    ...(outcome.skills ? [count(outcome.skills, "onboarding.import.addedSkillsOne", "onboarding.import.addedSkills")] : []),
  ];
  const lines = [parts.length ? t("composer.notes.added", { from: outcome.from, list: list(parts) }) : t("composer.notes.nothingNew", { from: outcome.from })];
  if (outcome.lost?.includes("about")) lines.push(t("composer.notes.lostAbout"));
  if (outcome.lost?.includes("memory")) lines.push(t("composer.notes.lostMemory"));
  if (outcome.failed.length) lines.push(t("composer.notes.failed", { names: list(outcome.failed) }));
  if (outcome.partial) lines.push(t("composer.notes.partial"));
  return lines.join(" ");
}

export function notesErrorLine(cause: unknown): string {
  if (cause instanceof GrokImportError) return t(`composer.notes.error.${cause.code}` as LocaleKey, { keys: cause.keys.join(", ") });
  return t("composer.notes.error.failed");
}

/** Every `.json`, `.md` or `.txt` file among dropped or picked files that holds notes, read whole and joined, so the
 * parts of a split answer come in together; null for none. */
export async function notesInFiles(files: readonly Pick<File, "name" | "size" | "text">[]): Promise<{ text: string; names: string[] } | null> {
  const found: Array<{ name: string; text: string }> = [];
  let size = 0;
  for (const file of files) {
    if (!/\.(?:json|md|markdown|txt)$/i.test(file.name) || file.size > NOTES_MAX_CHARS || size + file.size > NOTES_MAX_CHARS) continue;
    try {
      const text = await file.text();
      if (looksLikeNotes(text) && !isNotesPrompt(text)) {
        found.push({ name: file.name, text });
        size += file.size;
      }
    } catch {}
  }
  return found.length ? { text: found.map((one) => one.text).join("\n\n"), names: found.map((one) => one.name) } : null;
}
