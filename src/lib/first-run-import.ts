// The first run's "bring what you already use": what this Mac holds from other AI apps as one short list, app by app,
// all chosen; one press brings the chosen in while the run goes on, and a single quiet line says how it went.
import { useSyncExternalStore } from "react";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api, type Action, type ConfigStatus } from "@/state/store";
import type { ActivitySource, MemoryTopics, SetupDetection, SetupSource } from "../../shared/setup-import";
import { movable, planCounts, runBotMove, type AppMove, type BotMovePlan } from "./bot-move";
import { GROK_FROM } from "../../shared/grok-import";
import { aboutMeSaver } from "./assistant-notes";
import { postImportNote } from "./import-note";
import { BRING_NOTICE, dismissNotice } from "./notices";
import { setupImportApi, type SetupImportClient } from "./setup-import";

export interface LocalFind {
  /** "bots:<app key>" for another agent app's bots; "setup:<source>" for an AI tool's skills, tools and memory. */
  id: string;
  app: string;
  /** What it holds in plain words: "18 notes about you, 12 skills and 2 bots". */
  summary: string;
  amount: SourceAmount;
  bots?: AppMove;
  source?: SetupSource;
  /** What an AI tool's own setup holds; `memory`: its notes not brought in yet. */
  setup?: { skills: number; tools: number; memory: number };
  /** When the app was last used (ms), from its files' change times; null when unknown. */
  lastUsed: number | null;
  /** How worth bringing it is: how much it holds, weighed by how recently it was used. */
  score: number;
  /** Used lately and holding enough to matter: shown up front; the rest wait behind Show more. */
  strong: boolean;
  /** Distinct days with conversations in the last 30; null when this app's use can't be told. */
  activeDays: number | null;
  /** What its memory is about, for an AI tool's own memory. */
  topics?: MemoryTopics;
}

/** Real, repeated use: conversations on at least this many of the last 30 days. */
export const MIN_ACTIVE_DAYS = 5;
/** Enough about the person to be worth bringing. */
export const MIN_KNOWN = 3;

/** The one app this person genuinely uses that knows them: used on MIN_ACTIVE_DAYS of the last 30 and holding notes
 * about them; the most used first, then the one that knows more. Null when none does: the chat AI prompt leads then. */
export function memorySource(finds: readonly LocalFind[]): LocalFind | null {
  const known = (find: LocalFind) => find.amount.notes + find.amount.memories;
  return finds.filter((find) => (find.activeDays ?? 0) >= MIN_ACTIVE_DAYS && known(find) >= MIN_KNOWN)
    .sort((a, b) => (b.activeDays ?? 0) - (a.activeDays ?? 0) || known(b) - known(a))[0] ?? null;
}

const list = (parts: string[]) => new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(parts);
const count = (n: number, one: LocaleKey, many: LocaleKey) => (n === 1 ? t(one) : t(many, { count: n }));
const SOURCE_ORDER: SetupSource[] = ["claudeCode", "claudeDesktop", "codex", "cursor", "gemini", "windsurf", "vscode", "openhands"];

const DAY_MS = 86_400_000;
/** Used within this long counts as in use. */
export const RECENT_DAYS = 30;
/** Below this much (a couple of skills, one config), a source is not worth leading with. */
export const MIN_AMOUNT = 8;

export interface SourceAmount { notes: number; skills: number; tools: number; bots: number; memories: number; routines: number }

/** What it knows, in a person's words: "It's learned your preferences, how you like to work and 4 of your projects." */
export function knowsLine(find: LocalFind): string {
  const topics = find.topics;
  const parts = topics ? [
    ...(topics.preferences ? [t("bring.topicPreferences")] : []),
    ...(topics.aboutYou ? [t("bring.topicAboutYou")] : []),
    ...(topics.workStyle ? [t("bring.topicWorkStyle")] : []),
    ...(topics.projects ? [count(topics.projects, "bring.topicProjectsOne", "bring.topicProjects")] : []),
  ] : [];
  return parts.length ? t("bring.learned", { topics: list(parts) }) : count(find.amount.notes + find.amount.memories, "bring.remembersOne", "bring.remembers");
}

/** One number for how much a source holds: a bot or a routine is worth more than a skill, a note far less. */
export function amountOf(amount: Partial<SourceAmount>): number {
  return (amount.bots ?? 0) * 3 + (amount.routines ?? 0) + (amount.skills ?? 0) + (amount.tools ?? 0) * 0.5
    + Math.min(amount.notes ?? 0, 500) / 5 + Math.min(amount.memories ?? 0, 300) / 3;
}

/** Its score and whether it is up front: used in the last month and holding enough. */
export function sourceScore(amount: Partial<SourceAmount>, lastUsed: number | null, now = Date.now()): { score: number; strong: boolean } {
  const units = amountOf(amount);
  const days = lastUsed === null ? Infinity : Math.max(0, (now - lastUsed) / DAY_MS);
  const recency = days <= 7 ? 1 : days <= RECENT_DAYS ? 0.6 : 0.15;
  return { score: units * recency, strong: days <= RECENT_DAYS && units >= MIN_AMOUNT };
}

/** What a source holds in plain words, most personal first; `most` keeps a line short (the rest is left unsaid). */
export function amountLine(amount: Partial<SourceAmount>, most = Infinity): string {
  const known = (amount.notes ?? 0) + (amount.memories ?? 0);
  return list(([
    ...(known ? [count(known, "bring.aboutYouOne", "bring.aboutYou")] : []),
    ...(amount.bots ? [count(amount.bots, "botMove.botsOne", "botMove.bots")] : []),
    ...(amount.skills ? [count(amount.skills, "botMove.skillsOne", "botMove.skills")] : []),
    ...(amount.routines ? [count(amount.routines, "bring.routinesOne", "bring.routines")] : []),
    ...(amount.tools ? [count(amount.tools, "bring.toolsOne", "bring.tools")] : []),
  ] as string[]).slice(0, most));
}

/** The activity a bot app's files are dated by: its home folder's own app. */
function botActivity(app: AppMove): ActivitySource | null {
  const top = app.where.replace(/^~[\\/]/, "").split(/[\\/]/)[0]?.toLowerCase() ?? "";
  if (/^\.(?:openclaw|clawdbot|moltbot)$/.test(top)) return "openclaw";
  if (top === ".hermes") return "hermes";
  if (top === ".claude") return "claudeCode";
  if (top === ".gemini") return "gemini";
  if (/^\.(?:openmausbot|opengrokbot|madanibot)$/.test(top)) return "openmausbot";
  return null;
}

/** What this computer holds, one find per app, best first: how much it holds weighed by how lately it was used. A tool
 * whose agents came in as bots (Claude Code's, Gemini CLI's) is one find with both. Grok bot's exports already saved in
 * Downloads are a find only with `grokExports` (Settings, which may read Downloads); otherwise they are left to its
 * prompt. */
export function localFinds(plan: BotMovePlan | null, detection: SetupDetection | null, options: { grokExports?: boolean; now?: number } = {}): LocalFind[] {
  const now = options.now ?? Date.now();
  const activity = detection?.activity ?? {};
  const usage = detection?.usage ?? {};
  const found: Array<{ find: Omit<LocalFind, "summary" | "amount" | "score" | "strong">; amount: SourceAmount }> = [];
  for (const app of plan?.apps ?? []) {
    if (!app.preview.plans.length || (app.from.key === GROK_FROM.key && !options.grokExports)) continue;
    const counts = planCounts(app);
    const source = botActivity(app);
    // a Grok bot export was saved on purpose, just now or lately
    const lastUsed = app.from.key === GROK_FROM.key ? now : source ? activity[source] ?? null : null;
    found.push({ find: { id: `bots:${app.from.key}`, app: app.app, bots: app, lastUsed, activeDays: source ? usage[source] ?? 0 : null },
      amount: { notes: 0, skills: counts.skills, tools: 0, bots: counts.bots, memories: counts.memories + (counts.facts ?? 0), routines: counts.routines } });
  }
  for (const source of SOURCE_ORDER) {
    const skills = detection?.skills.filter((one) => one.source === source).length ?? 0;
    const tools = detection?.tools.filter((one) => one.source === source).length ?? 0;
    const memory = detection?.memory?.find((one) => one.source === source)?.notes ?? 0;
    if (!skills && !tools && !memory) continue;
    const name = t(`onboarding.import.source.${source}` as LocaleKey);
    const setup = { skills, tools, memory };
    const topics = detection?.memory?.find((one) => one.source === source)?.topics;
    const same = found.find((one) => one.find.bots && !one.find.source && one.find.app === name);
    if (same) {
      Object.assign(same.find, { source, setup, lastUsed: Math.max(same.find.lastUsed ?? 0, activity[source] ?? 0) || null, activeDays: usage[source] ?? 0, ...(topics ? { topics } : {}) });
      Object.assign(same.amount, { notes: memory, skills: same.amount.skills + skills, tools });
    } else {
      found.push({ find: { id: `setup:${source}`, app: name, source, setup, lastUsed: activity[source] ?? null, activeDays: usage[source] ?? 0, ...(topics ? { topics } : {}) }, amount: { notes: memory, skills, tools, bots: 0, memories: 0, routines: 0 } });
    }
  }
  return found
    .map(({ find, amount }) => ({ ...find, amount, summary: amountLine(amount), ...sourceScore(amount, find.lastUsed, now) }))
    .sort((a, b) => Number(b.strong) - Number(a.strong) || b.score - a.score);
}

let focus: string | null = null;
/** The source the bring card named: Settings' import page leads with it, so the page answers the card. */
export function focusBringFind(id: string | null) { focus = id; }
export function bringFocus(): string | null { return focus; }

/** `ids`: the finds being brought in now; `brought`: every find brought in so far, each its own Import pressed once. */
export type BringRun =
  | { kind: "idle" }
  | { kind: "working"; ids: string[]; brought: string[] }
  | { kind: "done"; line: string; failed: boolean; brought: string[]; known?: number };

let run: BringRun = { kind: "idle" };
/** What has come in so far, by find id. */
const NONE: readonly string[] = [];
export const broughtIds = (now: BringRun): readonly string[] => (now.kind === "idle" ? NONE : now.brought);
const listeners = new Set<() => void>();
function set(next: BringRun) {
  run = next;
  for (const listener of listeners) listener();
}

export function useBringRun(): BringRun {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => run, () => run);
}

export const bringRunNow = (): BringRun => run;
export function resetBringRunForTests() { run = { kind: "idle" }; }
/** A finished run is forgotten (Settings opening afresh); one still going is kept. */
export function forgetBringRun() { if (run.kind === "done") set({ kind: "idle" }); }

/** Someone who brought their tools in is not offered the import again on a later launch: what an import leaves behind
 * (notes past its limit) still shows on Settings' import page. The latest hints are read first, so none saved meanwhile is lost. */
async function markBrought(dispatch: (action: Action) => void): Promise<void> {
  try {
    const current = await api<ConfigStatus>("/api/config");
    const patch = dismissNotice(current?.onboarding, BRING_NOTICE);
    if (!patch) return;
    dispatch({ type: "configStatus", config: await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify(patch) }) });
  } catch {}
}

/** Brings the chosen finds in: the tools' things in one request, then each app's bots. Never throws; the line says what
 * came in. Runs once at a time; the funnel goes on meanwhile. */
export async function bringChosen(finds: readonly LocalFind[], context: {
  dispatch: (action: Action) => void; firstBotId: string | null; client?: SetupImportClient;
  /** About me as it is now, and whether it is the team's profile: facts the bots knew about the person go there. */
  aboutMe?: string; team?: boolean;
  /** The tools' memory and instructions come too, as notes in the first bot's memory (always, unless false). */
  memory?: boolean;
}): Promise<void> {
  if (run.kind === "working" || !finds.length) return;
  const before = broughtIds(run);
  const ids = finds.map((find) => find.id);
  set({ kind: "working", ids, brought: [...before] });
  const client = context.client ?? setupImportApi;
  const sources = finds.flatMap((find) => (find.source ? [find.source] : []));
  const apps = finds.flatMap((find) => (find.bots ? [find.bots] : []));
  let skills = 0, tools = 0, notes = 0, bots = 0, failed = false;
  const botNames: string[] = [];
  let facts = 0, memories = 0, routines = 0, reconnect = 0;
  const kept: string[] = [];
  if (sources.length) {
    try {
      const memory = context.memory !== false && context.firstBotId !== null && finds.some((find) => (find.setup?.memory ?? 0) > 0);
      const result = await client.apply({ skills: true, tools: true, sources, ...(memory ? { memory: true, memoryBot: context.firstBotId! } : {}) });
      skills = result.skills?.added.length ?? 0;
      tools = result.tools?.added.length ?? 0;
      notes = result.memory?.added ?? 0;
      if (notes) kept.push(...(result.memory?.sources ?? []).map((source) => t(`onboarding.import.source.${source}` as LocaleKey)));
      failed ||= Boolean(result.skills?.skipped.some((one) => one.reason === "failed") || result.tools?.skipped.some((one) => one.reason === "failed") || result.memory?.failed);
    } catch {
      failed = true;
    }
  }
  if (apps.length) {
    try {
      const plan: BotMovePlan = { apps, grokWaiting: [] };
      if (movable(plan)) {
        const saveFacts = aboutMeSaver({ aboutMe: context.aboutMe ?? "", team: Boolean(context.team), dispatch: context.dispatch });
        const reports = await runBotMove(plan, context.dispatch, undefined, context.aboutMe === undefined ? undefined : saveFacts);
        const moved = reports.flatMap((one) => one.report.bots);
        bots = moved.length;
        botNames.push(...moved.map((bot) => bot.name));
        facts = moved.reduce((sum, bot) => sum + (bot.facts ?? 0), 0);
        memories = moved.reduce((sum, bot) => sum + bot.memories + bot.notes, 0);
        routines = moved.reduce((sum, bot) => sum + bot.routines, 0);
        reconnect = moved.reduce((sum, bot) => sum + bot.apps, 0);
        failed ||= reports.some((one) => one.report.failed.length > 0);
      }
    } catch {
      failed = true;
    }
  }
  // what the bots now know about the person leads; the rest follows in one line
  const known = notes + facts + memories;
  const also = [
    ...(bots ? [count(bots, "botMove.botsOne", "botMove.bots")] : []),
    ...(skills ? [count(skills, "botMove.skillsOne", "botMove.skills")] : []),
    ...(routines ? [count(routines, "bring.routinesOne", "bring.routines")] : []),
    ...(tools ? [count(tools, "bring.toolsOne", "bring.tools")] : []),
  ];
  const said = known
    ? [count(known, "bring.knowNowOne", "bring.knowNow"), ...(also.length ? [t("bring.alsoCame", { list: list(also) })] : [])]
    : also.length ? [t("bring.done", { list: list(also) })] : failed ? [] : [t("bring.allHere")];
  const line = [...said, failed ? t("bring.failed") : ""].filter(Boolean).join(" ");
  // a find that failed stays one to import again
  set({ kind: "done", line, failed, brought: failed ? [...before] : [...new Set([...before, ...ids])], known });
  if (known || bots || skills || tools || routines) void markBrought(context.dispatch);
  if (context.firstBotId && (bots || skills || tools || notes)) {
    const from = [...new Set(finds.filter((find) => find.bots || find.source).map((find) => find.app))];
    void postImportNote(context.firstBotId, { from, bots: botNames, facts, memories: memories + notes, skills, tools, routines, instructions: kept, reconnect, failed });
  }
}
