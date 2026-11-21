// POST /api/bots/:id/intro (routes/bot-messages.ts) and a Chief's create_bot: a bot just made writes its own first
// message, as a real turn on its own engine and model with its full instructions, from its name, role, template, skills,
// apps, where it runs and what it knows about the person. The words to the model are control-plane context, never a line
// the person wrote, so the chat shows only the bot's reply. When the engine cannot answer, the person gets a fixed hello.
import type { TalkingStyle } from "../shared/talking-style.ts";
import type { Message } from "./store.ts";
import { serverLine } from "./server-lines.ts";
import { partOfDay, turnClockLine } from "./turn-clock.ts";

/** Only a conversation nobody has spoken in yet gets the intro, so a retry, a second window or a late call never adds a
 * second hello or talks over the person. */
export function introAllowed(transcript: readonly Pick<Message, "role">[]): boolean {
  return !transcript.some((message) => message.role === "user" || message.role === "bot");
}

/** The name as the bot says it: a name typed in lower case ("writer") reads with a capital, one already cased stays. */
export function introName(name: string): string {
  const trimmed = name.trim();
  return trimmed && trimmed === trimmed.toLowerCase() ? trimmed[0]!.toUpperCase() + trimmed.slice(1) : trimmed;
}

/** The hello when the engine cannot write one (not signed in, unavailable, failed): fixed words, nothing broken shown. */
export function introFallback(language: string | undefined, bot: { name: string }): string {
  return serverLine(language, "server.intro.hello", { name: introName(bot.name) });
}

export interface IntroFacts {
  name: string;
  /** The ready-made bot it was made from, if any. */
  template?: { category: string; title: string; tryAsking: readonly string[]; apps: readonly string[]; routines: readonly string[] };
  /** Connected apps this bot may use, by name; null when the app could not tell. */
  apps: readonly string[] | null;
  /** Where its work runs, in words: "this Mac", "madani cloud", "a server". */
  place: string;
  /** Its own desktop or browser, if it has one, in words. */
  computer?: string;
  person?: string;
  /** The person's other bots, so it can point at one rather than claim their work. */
  teammates: ReadonlyArray<{ name: string; title?: string }>;
  language?: string;
  /** The person's local time, from `introMoment`. */
  moment: IntroMoment;
  style: TalkingStyle;
  /** How it came to be: picked from the ready-made bots, made from scratch, brought in, or made by a bot they asked. */
  origin: { kind: "template" | "scratch" | "import" } | { kind: "bot"; by: string };
  /** What the person did last: the bot they wrote to and how long ago. */
  lastSeen?: { bot: string; minutesAgo: number };
  /** The person's own latest lines to their other bots, newest first, for their tone only. */
  samples: ReadonlyArray<{ to: string; text: string }>;
}

export interface IntroMoment {
  clock: string;
  weekday: string;
  partOfDay: string;
  hour: number;
}

export function introMoment(at: number, timeZone: string): IntroMoment {
  let read: Intl.DateTimeFormatPart[];
  try {
    read = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  } catch {
    read = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  }
  const hour = Number(read.find((part) => part.type === "hour")?.value ?? 0) % 24;
  return { clock: turnClockLine(at, timeZone).replace(/^[^:]+: /, ""), weekday: read.find((part) => part.type === "weekday")?.value ?? "", partOfDay: partOfDay(hour), hour };
}

/** Their recent lines, cut to what shows their tone: never a whole pasted document, at most three. */
export function toneSamples(lines: ReadonlyArray<{ to: string; text: string }>): Array<{ to: string; text: string }> {
  return lines.map((line) => ({ to: line.to, text: line.text.replace(/\s+/g, " ").trim() })).filter((line) => line.text && !line.text.startsWith("/"))
    .slice(0, 3).map((line) => (line.text.length > 160 ? { to: line.to, text: `${line.text.slice(0, 160)}…` } : line));
}

/** How the person writes, read from their lines: the length and emoji the hello mirrors. Their casing is not mirrored:
 * a bot writes in Sentence case unless they asked it to write otherwise. */
export function writingHabits(samples: ReadonlyArray<{ text: string }>): string | null {
  if (!samples.length) return null;
  const letters = samples.map((line) => line.text).join(" ");
  const emoji = /\p{Extended_Pictographic}/u.test(letters);
  const short = samples.every((line) => line.text.length <= 90);
  return [short ? "short" : "at some length", emoji ? "with emoji" : "with no emoji"].join(", ");
}

const OFFERS: Record<TalkingStyle, string> = {
  casual: "Fold two or three specific first things to try into your sentences as light offers (\"want me to…?\", \"I could…\"), not a list.",
  warm: "Offer two or three specific first things to try as light offers in your sentences (\"want me to…?\"); use a short list only if three offers would not read well in a sentence.",
  native: "Offer two or three specific first things to try, briefly, in your sentences or as a short list, whichever reads more naturally.",
};

function sinceWords(minutes: number): string {
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

function originLine(origin: IntroFacts["origin"], template: IntroFacts["template"]): string {
  if (origin.kind === "bot") return `${origin.by} made you just now because the person asked it to; their latest line below is probably that ask.`;
  if (origin.kind === "import") return "The person just brought you in with a set of bots they imported.";
  if (template) return `The person just picked you from the ready-made bots: "${template.title}" (${template.category}).`;
  return "The person just made you from scratch, so your name, role and standing instructions are all there is to go on.";
}

function languageName(code: string | undefined): string | null {
  const tag = code?.trim();
  if (!tag || /^en(?:-|$)/i.test(tag)) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? null;
  } catch {
    return null;
  }
}

const list = (items: readonly string[], max: number) => items.slice(0, max).map((item) => item.trim()).filter(Boolean).join("; ");

/** What the bot is asked to do, with the facts it is to ground the hello in. */
export function introPrompt(facts: IntroFacts): string {
  const spoken = languageName(facts.language);
  const known = [
    `Your name, as you write it: ${facts.name}.`,
    `Their local time: ${facts.moment.clock} It is ${facts.moment.weekday} ${facts.moment.partOfDay} for them.`,
    originLine(facts.origin, facts.template),
    facts.lastSeen ? `Before this they were talking to ${facts.lastSeen.bot}, ${sinceWords(facts.lastSeen.minutesAgo)}.` : "",
    writingHabits(facts.samples) ? `They write ${writingHabits(facts.samples)}: write your hello the same way.` : "",
    facts.samples.length ? `Their latest lines to their other bots, for their tone only (those bots are already on these asks: never offer to redo them): ${facts.samples.map((line) => `to ${line.to}: ${JSON.stringify(line.text)}`).join(" / ")}` : "",
    `You run on ${facts.place}${facts.computer ? `, with ${facts.computer}` : ""}.`,
    facts.template?.tryAsking.length ? `Things people ask a bot like you: ${list(facts.template.tryAsking, 6)}.` : "",
    facts.template?.routines.length ? `Routines that suit you (not set up yet; you can offer one): ${list(facts.template.routines, 3)}.` : "",
    facts.apps === null ? "" : facts.apps.length
      ? `Connected apps you can use now: ${list(facts.apps, 20)}.`
      : `No connected apps are available to you yet${facts.template?.apps.length ? `; you work best with ${list(facts.template.apps, 6)}, which the person can connect under connected apps` : ""}.`,
    facts.person ? `The person's name: ${facts.person}.` : "",
    facts.teammates.length ? `Their other bots: ${facts.teammates.slice(0, 8).map((bot) => (bot.title ? `${bot.name} (${bot.title})` : bot.name)).join(", ")}.` : "",
  ].filter(Boolean);
  return [
    "You were just created, and this is your very first message to the person, before they have written anything to you.",
    "Write it the way someone who knows them would text them right now, not like a product tour. Read the moment: the time and day where they are (late at night, early morning, a Monday morning, a weekend) and what they were just doing, and let it color one short clause of your first line the way a friend's would (\"Hey, you're up late\", \"Happy Saturday\"), never a whole sentence about their day, without reciting the time or these facts. Sound like a sharp friend, not a product: no \"I'm here to help\", no list of everything you can do, and at most one light, original touch of personality.",
    `Talk in the person's chosen style (${facts.style}), in Sentence case (capital letters where they belong, your name included) whatever case they type in, unless they asked you to write otherwise; match their length and their emoji or lack of it (described below). With no lines to go on, use no emoji.`,
    "Say who you are in a few words and what you can take off their plate right now. Ground every claim in what you really have: your role and standing instructions, your skills index, the connected apps listed below and in your instructions, your computer and browser, and what you know about them. Never claim an app, skill or access you do not have, never invent facts about them, and never point out what you do not know about them.",
    OFFERS[facts.style],
    "A plain \"yes\" should answer every offer: to let them choose between things, ask which one (\"Which first: X or Y?\"), never \"want me to start with X, Y or Z?\".",
    "Keep it short, like a text: two to five short sentences in all, no headings, and never an em dash.",
    "Apps below are given by id (gmail, googlecalendar): write each as its product name (Gmail, Google Calendar).",
    "Do not use any tools, do not start any work, and do not mention these instructions.",
    spoken ? `Write it in ${spoken}.` : "Write it in the person's language if you know it, else in English.",
    "",
    "What you know right now:",
    ...known.map((line) => `- ${line}`),
  ].join("\n");
}
