// The daily brief as an ordinary chat message from the proactive bot: a line or two, then a short list of what needs the
// person, in the language set for them, with no AI. Senders, subjects, invites, questions, errors and ideas are untrusted,
// so every visible piece is escaped and can never become a link, image, heading or math. The only links are the server's
// own: a chat in this app, a Gmail thread by id, a published page.
import { clockTime, gmailUrl, httpsLink, type OpenTarget } from "./brief-cards.ts";
import { briefWords, type BriefWords } from "./brief-words.ts";
import { oneLine } from "./text-clip.ts";

export interface BriefEmail { messageId: string; threadId: string; from: string; subject: string; why?: string; needsReply: boolean }
/** `page`: the live page a routine's run published, linked beside the run's chat. */
export interface BriefRow { text: string; note: string; open?: OpenTarget; page?: string }
/** A row that needs the person. `key` names what it is about in no particular language, so a new language is not news. */
export type NeedRow = BriefRow & { key: string };
export interface BriefMeeting { title: string; start: number; joinUrl?: string }
export interface BriefFacts {
  now: number;
  timeZone?: string;
  /** The language set in Settings; absent, the brief is in English. */
  language?: string;
  intro: boolean;
  /** Things only the person can fix: failed routines, clashes, a read that failed, a signed-out AI, a question waiting. */
  needs: NeedRow[];
  /** null: no calendar is read, so the day's line is left out. */
  meetings: BriefMeeting[] | null;
  emails: BriefEmail[];
  /** New emails that wait for the next sort, or true when there were more than one check reads. */
  waiting?: number | true;
  routines: BriefRow[];
  /** From the nightly dream: suggestions, never news, so they are left out of what notifies. */
  ideas?: BriefRow[];
}

export interface BuiltMessage {
  text: string;
  summary: string;
}

/** What needs the person, listed one per line before "and N more". */
export const BRIEF_ROWS = 6;
/** Meetings named in the day's line, and the other rows under "Also worth a look". */
const DAY_MEETINGS = 4;
const ALSO_ROWS = 4;
const TEXT = { line: 120, note: 160, sender: 40, title: 60, link: 600 } as const;
const SUMMARY_MAX = 140;

const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const entity = (char: string): string => ENTITY[char] ?? `&#${char.codePointAt(0)};`;
/** Invisible, and no break: GFM finds web and mail addresses in the text itself, so this is what keeps one plain. */
const JOINER = "\u2060";

/** Security invariant: untrusted text stays the words it is. Every mark Markdown, GFM or math could read becomes a
 * character reference, which Markdown shows as that character and never as structure, and so does whatever could open
 * a block at the start of a line. A backslash would not do: the chat reads one before [ or ( as math. A web or mail
 * address is split by an invisible joiner, so it is never a link. Clip before this, never after. */
export function plain(value: string): string {
  return value
    .replace(/[\\`*_[\]<>$~&|]/g, entity)
    .replace(/:(?=\/\/)/g, `:${JOINER}`)
    .replace(/\b(mailto|xmpp):/gi, `$1:${JOINER}`)
    .replace(/\b(www)\./gi, `$1${JOINER}.`)
    .replace(/@/g, `@${JOINER}`)
    .replace(/^(\s*)([#+=-]|\d+[.)])/, (_match, space: string, mark: string) => `${space}${mark.slice(0, -1)}${entity(mark.slice(-1))}`);
}

const threadUrl = (target: OpenTarget): string => `madanibot://thread/${encodeURIComponent(target.threadId)}?bot=${encodeURIComponent(target.botId)}`;
/** `label` is already escaped; a url is always the server's own. */
const link = (label: string, url: string | undefined): string => (url ? `[${label}](<${url}>)` : label);
const gmailLink = (email: BriefEmail): string | undefined => (email.threadId.length <= TEXT.link ? gmailUrl(email.threadId) : undefined);

function senderName(rawFrom: string): string {
  const from = rawFrom.slice(0, 300);
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(from);
  return match ? match[1]!.trim() || match[2]!.trim() : from.trim();
}
const sender = (email: BriefEmail, w: BriefWords): string => oneLine(senderName(email.from), TEXT.sender) || w.noSender;
const subjectOf = (email: BriefEmail, w: BriefWords): string => oneLine(email.subject, TEXT.line) || w.noSubject;

/** One list line: the escaped lead, linked when it opens something, then its note. */
function item(lead: string, note: string, w: BriefWords, url?: string): string {
  const head = link(plain(oneLine(lead, TEXT.line)), url);
  const rest = oneLine(note, TEXT.note);
  return `- ${rest ? w.line(head, plain(rest)) : head}`;
}

const needItem = (row: BriefRow, w: BriefWords): string => item(row.text, row.note, w, row.open ? threadUrl(row.open) : undefined);
function replyItem(email: BriefEmail, w: BriefWords): string {
  const why = email.why ? oneLine(email.why, TEXT.note) : "";
  return item(w.waitingOn(sender(email, w)), why ? `${subjectOf(email, w)} · ${why}` : subjectOf(email, w), w, gmailLink(email));
}
function emailItem(email: BriefEmail, w: BriefWords): string {
  const why = email.why ? oneLine(email.why, TEXT.note) : "";
  return item(sender(email, w), why ? `${subjectOf(email, w)} · ${why}` : subjectOf(email, w), w, gmailLink(email));
}
function routineItem(row: BriefRow, w: BriefWords): string {
  const page = httpsLink(row.page);
  const line = item(row.text, row.note, w, row.open ? threadUrl(row.open) : undefined);
  return page ? `${line} · ${link(plain(w.openPage), page)}` : line;
}
const ideaItem = (row: BriefRow, w: BriefWords): string => `- ${plain(w.idea(oneLine(row.text, TEXT.note)))}`;

function capped(lines: string[], max: number, w: BriefWords): string[] {
  const shown = lines.slice(0, max);
  return lines.length > shown.length ? [...shown, `- ${plain(w.more(lines.length - shown.length))}`] : shown;
}

function dayLine(meetings: BriefMeeting[], facts: BriefFacts, w: BriefWords): string | undefined {
  if (!meetings.length) return undefined;
  const named = meetings.slice(0, DAY_MEETINGS).map((meeting) => w.meetingAt(clockTime(meeting.start, facts.timeZone, facts.language), oneLine(meeting.title, TEXT.title)));
  return plain(w.today(meetings.length > named.length ? [...named, w.more(meetings.length - named.length)] : named));
}

export function briefMessage(facts: BriefFacts): BuiltMessage {
  const w = briefWords(facts.language);
  const replies = facts.emails.filter((email) => email.needsReply);
  const important = facts.emails.filter((email) => !email.needsReply);
  const needs = [...replies.map((email) => replyItem(email, w)), ...facts.needs.map((row) => needItem(row, w))];
  const meetings = [...(facts.meetings ?? [])].sort((a, b) => a.start - b.start);
  const also = [...important.map((email) => emailItem(email, w)), ...facts.routines.map((row) => routineItem(row, w)), ...(facts.ideas ?? []).map((row) => ideaItem(row, w))];
  const waiting = facts.waiting === true ? w.waitingMany : facts.waiting ? w.waitingCount(facts.waiting) : undefined;
  const day = dayLine(meetings, facts, w);
  const blocks = [
    facts.intro ? plain(w.intro) : undefined,
    needs.length ? [plain(w.needsLead(needs.length)), ...capped(needs, BRIEF_ROWS, w)].join("\n") : plain(w.nothingNeedsYou),
    day,
    also.length ? [plain(w.alsoLead), ...capped(also, ALSO_ROWS, w)].join("\n") : undefined,
    waiting ? plain(waiting) : undefined,
  ].filter((block): block is string => Boolean(block));
  const parts = [
    needs.length && w.summary.needs(needs.length),
    meetings.length && w.summary.meetings(meetings.length),
    important.length && w.summary.emails(important.length),
    facts.routines.length && w.summary.routines(facts.routines.length),
    facts.ideas?.length && w.summary.ideas(facts.ideas.length),
  ].filter(Boolean);
  return { text: blocks.join("\n\n"), summary: oneLine(`${w.title}: ${parts.length ? parts.join(", ") : w.summary.nothing}`, SUMMARY_MAX) };
}
