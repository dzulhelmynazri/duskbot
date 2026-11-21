import type { LocaleKey } from "@/locales";
import type { Message } from "@/state/store";
import type { LiveStatus } from "@/state/turn-status";
import { t, tOptional } from "./i18n";
import { phraseCycle, turnNowPhrases, type LiveActivityPhrases } from "./live-activity";
import { tokenApp } from "../../shared/app-tokens";

// The working line's words, all in one place. A pool says its `words` wherever the active language has them, else its
// `legacy` words, which every language has.
const NORMAL: LocaleKey[] = [
  "chat.friendly.word.thinking", "chat.friendly.word.working", "chat.friendly.word.onIt", "chat.friendly.word.gettingItDone",
  "chat.friendly.word.figuringItOut", "chat.friendly.word.almostThere",
];

const FUN: LocaleKey[] = [
  "chat.friendly.fun.pondering", "chat.friendly.fun.mulling", "chat.friendly.fun.noodling", "chat.friendly.fun.percolating",
  "chat.friendly.fun.simmering", "chat.friendly.fun.marinating", "chat.friendly.fun.brewing", "chat.friendly.fun.cooking",
  "chat.friendly.fun.tinkering", "chat.friendly.fun.crafting", "chat.friendly.fun.conjuring", "chat.friendly.fun.hatching",
  "chat.friendly.fun.whippingUp", "chat.friendly.fun.wrangling", "chat.friendly.fun.rummaging", "chat.friendly.fun.whirring",
  "chat.friendly.fun.cogitating", "chat.friendly.fun.synthesizing", "chat.friendly.fun.triangulating", "chat.friendly.fun.calibrating",
  "chat.friendly.fun.combobulating", "chat.friendly.fun.discombobulating", "chat.friendly.fun.shenaniganing",
  "chat.friendly.fun.bamboozling", "chat.friendly.fun.doodling", "chat.friendly.fun.stargazing", "chat.friendly.fun.sleuthing",
  "chat.friendly.fun.scheming",
];

type Pool = { words: LocaleKey[]; legacy: LocaleKey[] };

const DIGGING: LocaleKey[] = ["chat.friendly.digging"];
const CLICKING: LocaleKey[] = ["chat.friendly.clicking"];
const CODE: LocaleKey[] = ["chat.friendly.code"];

export const WORD_POOLS = {
  thinking: { words: NORMAL, legacy: ["chat.friendly.thinking", "chat.friendly.mulling", "chat.friendly.puttingTogether"] },
  generic: { words: NORMAL, legacy: ["chat.friendly.working", "chat.friendly.chipping", "chat.friendly.gettingDone", "chat.friendly.progress", "chat.friendly.handling"] },
  typing: { words: ["chat.friendly.word.writing", "chat.friendly.word.wrappingUp"], legacy: ["chat.typing"] },
  web: { words: ["chat.friendly.word.searching"], legacy: DIGGING },
  page: { words: ["chat.friendly.word.reading"], legacy: DIGGING },
  openPage: { words: ["chat.friendly.word.openingAPage"], legacy: CLICKING },
  browsing: { words: ["chat.friendly.word.browsing"], legacy: CLICKING },
  clicking: { words: ["chat.friendly.word.clicking"], legacy: CLICKING },
  form: { words: ["chat.friendly.word.fillingAForm"], legacy: CLICKING },
  typingInto: { words: ["chat.friendly.word.typing"], legacy: CLICKING },
  screen: { words: ["chat.friendly.word.lookingAtTheScreen"], legacy: CLICKING },
  computer: { words: ["chat.friendly.word.usingTheComputer"], legacy: CLICKING },
  files: { words: ["chat.friendly.word.checkingFiles"], legacy: DIGGING },
  editing: { words: ["chat.friendly.word.editingFiles"], legacy: CODE },
  saving: { words: ["chat.friendly.word.saving"], legacy: CODE },
  code: { words: ["chat.friendly.word.writingCode"], legacy: CODE },
  commands: { words: ["chat.friendly.word.runningACommand"], legacy: ["chat.friendly.commands"] },
  memory: { words: ["chat.friendly.word.remembering"], legacy: DIGGING },
  team: { words: ["chat.friendly.word.askingATeammate"], legacy: ["chat.friendly.team"] },
  publish: { words: [], legacy: ["chat.activity.publishPage"] },
} satisfies Record<string, Pool>;

export type PoolName = keyof typeof WORD_POOLS;

/** A pool's words in the active language, its first word first. */
export function poolWords(name: PoolName): string[] {
  const pool: Pool = WORD_POOLS[name];
  const words = pool.words.flatMap((key) => tOptional(key) ?? []);
  return [...new Set(words.length > 0 ? words : pool.legacy.map((key) => t(key)))];
}

/** The playful words a long stretch of plain work sprinkles in; none in a language that has not got them yet. */
export function funWords(): string[] {
  return FUN.flatMap((key) => tOptional(key) ?? []);
}

/** The line's plainest word for thinking or for working, in the active language. */
export function plainWord(kind: "thinking" | "working"): string {
  return tOptional(kind === "thinking" ? "chat.friendly.word.thinking" : "chat.friendly.word.working") ?? poolWords(kind === "thinking" ? "thinking" : "generic")[0]!;
}

/** Fun words stay out of the first 15 s of a turn, then come in about 1 pick in 4, rising to 1 in 2 by a minute. */
export const FUN_AFTER_MS = 15_000;
export const FUN_FULL_MS = 60_000;

export function funChance(elapsedMs: number): number {
  if (elapsedMs < FUN_AFTER_MS) return 0;
  return 0.25 + 0.25 * Math.min(1, (elapsedMs - FUN_AFTER_MS) / (FUN_FULL_MS - FUN_AFTER_MS));
}

function unit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/** The generic line's word at `step`, `elapsedMs` into the turn: "Thinking" first, then the plain words, with the fun
 * ones mixed in as the turn runs long. Each pool is its own shuffle bag, and no word follows itself. */
export function workingWord(normal: readonly string[], fun: readonly string[], seed: string, step: number, elapsedMs: number, previous?: string | null): string {
  if (step <= 0 || normal.length === 0) return normal[0] ?? "";
  const playful = fun.length > 0 && unit(`${seed}|fun|${step}`) < funChance(elapsedMs);
  const pool = playful ? fun : normal;
  const bag = `${seed}|${playful ? "fun" : "normal"}`;
  const word = phraseCycle(pool, bag, step);
  return word === previous ? phraseCycle(pool, bag, step + 1) : word;
}

// a command, search or page is said by its kind, never by the command or address itself
const STEP_POOLS: Record<string, PoolName> = { command: "commands", web: "web", fetch: "page" };

const BY_PHASE: Array<[readonly string[], PoolName]> = [
  [["chat.activity.reply"], "typing"],
  [["chat.activity.searchWeb"], "web"],
  [["chat.activity.readPage"], "page"],
  [["chat.activity.readFile", "chat.activity.searching"], "files"],
  [["chat.activity.writeFile"], "saving"],
  [["chat.activity.editFile"], "editing"],
  [["chat.activity.runCommand"], "commands"],
  [["chat.activity.screen"], "screen"],
  [["chat.activity.computer"], "computer"],
  [["chat.activity.openPage"], "openPage"],
  [["chat.activity.handoff", "chat.activity.askTeammate", "chat.activity.postRoom", "chat.activity.messagePerson", "chat.activity.rooms", "chat.activity.whosAround"], "team"],
  [["chat.activity.publishPage"], "publish"],
];

// what a browser or computer tool does, by a word of its name ("browser_click", "fill_form"), before the general labels
const named = (...words: string[]) => new RegExp(`(?:^|[_\\W])(?:${words.join("|")})(?:$|[_\\W])`, "i");
const BY_TOOL: Array<[RegExp, PoolName]> = [
  [named("remember", "recall", "memory", "memories"), "memory"],
  [named("fill", "form", "select_option"), "form"],
  [named("type", "keypress", "press_key"), "typingInto"],
  [named("click", "hover", "drag"), "clicking"],
  [named("navigate", "open_url", "goto"), "openPage"],
  [named("screenshot", "screen_capture"), "screen"],
  [named("scroll", "browse", "browser"), "browsing"],
];

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|sql|vue|svelte|css|scss|html?)$/i;

/** Servers of the app's own tools: their work reads as what it does, never as "Working in …". */
const OWN_SERVERS = new Set(["madani", "agents", "ogb", "omb", "madanibot", "computer", "browser", "harness"]);

/** The outside service a tool call works in, by its MCP server or a connected-app tool's name, as a person names it. */
export function toolService(name: string | undefined): string | null {
  const server = /^mcp__([^_]+(?:-[^_]+)*)__(.+)$/.exec(name ?? "");
  if (!server) return null;
  const [, id, tool] = server;
  if (OWN_SERVERS.has(id!.toLowerCase())) return null;
  const raw = id!.toLowerCase() === "composio" ? /^([A-Za-z]+)_/.exec(tool!)?.[1] : id;
  if (!raw) return null;
  return tokenApp(raw.toLowerCase())?.label ?? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/** The typing pool's phase is the line's own "Writing" phase, which comes and goes at once. */
export const TYPING_PHASE = "friendly:chat.typing";

/** A pool with no lead phrase: its words start anywhere in the turn. Every other pool says what the step is first. */
export function startsAnywhere(phase: string): boolean {
  return phase === "friendly:generic" || phase === "friendly:thinking";
}

function phrases(name: PoolName): LiveActivityPhrases {
  const said: LiveActivityPhrases = { phase: name === "typing" ? TYPING_PHASE : `friendly:${name}`, phrases: poolWords(name) };
  return name === "generic" || name === "thinking" ? { ...said, fun: funWords() } : said;
}

function toolPool(name: string | undefined): PoolName | null {
  const tool = (name ?? "").replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");
  return tool ? BY_TOOL.find(([pattern]) => pattern.test(tool))?.[1] ?? null : null;
}

/** Simple mode's rotating line for what the bot is doing now: plain words in place of file names, sizes and timers,
 * chosen by the kind of step (a tool's spoken narration is read by its name, as every other step is). */
export function friendlyNowPhrases(status: LiveStatus | null, message?: Message): LiveActivityPhrases {
  const plain = message?.kind === "activity" && message.tool?.spoken ? { ...message, tool: { ...message.tool, spoken: undefined } } : message;
  const now = turnNowPhrases(status, plain);
  if (now?.phase.startsWith("notice:")) return now;
  if (now?.phase.startsWith("step:")) {
    const name = STEP_POOLS[now.phase.split(":")[1] ?? ""];
    return name ? phrases(name) : now;
  }
  const tool = (status && "tool" in status ? status.tool : undefined) ?? (message?.kind === "activity" && message.tool?.ok === undefined ? message.tool?.name : undefined);
  const byTool = toolPool(tool);
  if (byTool) return phrases(byTool);
  const service = toolService(tool);
  if (service) return { phase: `friendly:service:${service}`, phrases: [t("chat.friendly.service", { service })] };
  if (!now) return phrases("generic");
  if (now.phase === "chat.activity.thinking") return phrases("thinking");
  if (now.phase.startsWith("live:read:")) return phrases("files");
  if (now.phase.startsWith("live:")) {
    const file = status && "file" in status ? status.file ?? status.target : undefined;
    if (status?.activity === "edit") return phrases("editing");
    return phrases(file && CODE_FILE.test(file) ? "code" : "saving");
  }
  const match = BY_PHASE.find(([phases]) => phases.includes(now.phase));
  return phrases(match ? match[1] : "generic");
}
