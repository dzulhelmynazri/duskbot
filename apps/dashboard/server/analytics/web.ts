// The owner's analytics, computed from the raw event log: visits from the site tracker, people from identify links,
// and the product's own records. Pure functions; the admin routes hand them events and records.
import { EVENTS } from "./events.ts";
import type { EventContext } from "./context.ts";
import type { StoredEvent } from "./sink.ts";

export const HOUR = 3_600_000, DAY = 86_400_000;
export const ONLINE_MS = 5 * 60_000;
export const SURFACES = ["site", "account", "desktop", "phone"] as const;
export type Surface = (typeof SURFACES)[number];
/** the events that count an account as active that day */
export const ACTIVE_EVENTS: readonly string[] = Object.entries(EVENTS).filter(([, spec]) => "active" in spec).map(([name]) => name);
const ACTIVE = new Set(ACTIVE_EVENTS);

export interface Visit {
  session: string; visitor: string; surface: Surface; start: number; end: number; host: string | null; keyword: string | null;
  pages: Array<{ path: string; at: number; pv: string | null }>;
  goals: Array<{ goal: string; at: number; to: string | null }>;
  /** the deepest scroll and visible time of each page view */
  leaves: Map<string, { path: string; scroll: number; ms: number }>;
  entry: string; exit: string; engagedMs: number; bounced: boolean;
  source: string; channel: string; referrer: string | null; campaign: string | null; ref: string | null;
  country: string | null; region: string | null; city: string | null; lat: number | null; lon: number | null;
  device: string | null; os: string | null; browser: string | null;
}
export const SITE_EVENTS = ["site_view", "site_goal", "site_leave"] as const;
const APP_VISIT_EVENTS = ["app_open", "app_screen", "app_feature", "app_close"] as const;
/** every event visitsOf reads: a scan for visits needs no others */
export const VISIT_EVENTS: readonly string[] = [...SITE_EVENTS, ...APP_VISIT_EVENTS, "page_view"];
const SITE = new Set<string>(SITE_EVENTS);
const APP = new Set<string>(APP_VISIT_EVENTS);

export function visitsOf(events: readonly StoredEvent[], surfaces: readonly Surface[] = ["site"]): Visit[] {
  const sessions: Sessions = new Map();
  for (const event of [...events].sort((a, b) => a.at - b.at)) addToSessions(sessions, event);
  return visitsFrom(sessions, surfaces);
}

/** a visit while its events are still coming in: what the finished visit needs beyond its fields */
export interface Session extends Visit {
  /** the first app_open, the newest longest app_close, and whether an event with an account named the visitor */
  opened: number | null; closedMs: number | null; named: boolean;
}
/** visits being built, by `${surface or app}:${session}`, in the order their first event came */
export type Sessions = Map<string, Session>;

/** adds one event (in time order) to the visits being built */
export function addToSessions(by: Sessions, event: StoredEvent) {
  const app = APP.has(event.name), account = event.name === "page_view";
  if (!SITE.has(event.name) && !app && !account) return;
  const ctx = event.ctx ?? {};
  const session = ctx.session ?? (app && ctx.install ? `${ctx.install}:${Math.floor(event.at / DAY)}` : null);
  const visitor = app ? event.accountId ?? (ctx.install ? `install:${ctx.install}` : null) : ctx.visitor ?? (account ? event.accountId : null);
  if (!session || !visitor) return;
  const surface = app ? ctx.app?.platform === "ios" || ctx.app?.platform === "android" || (event.name === "app_open" && event.props.kind === "mobile") ? "phone" : "desktop" : account ? "account" : "site";
  const key = `${app ? "app" : surface}:${session}`;
  let visit = by.get(key);
  if (!visit) {
    visit = { session, visitor, surface, start: event.at, end: event.at, host: ctx.host ?? null, keyword: null, pages: [], goals: [], leaves: new Map(), entry: "", exit: "", engagedMs: 0, bounced: true,
      source: "direct", channel: "direct", referrer: null, campaign: null, ref: null, country: null, region: null, city: null, lat: null, lon: null, device: null, os: null, browser: null,
      opened: null, closedMs: null, named: false };
    by.set(key, visit);
    if (app) attribute(visit, ctx);
  }
  visit.start = Math.min(visit.start, event.at); visit.end = Math.max(visit.end, event.at);
  if (app) {
    if (surface === "phone") visit.surface = surface;
    if (event.accountId) { visit.visitor = event.accountId; visit.named = true; }
    fill(visit, ctx);
    if (event.name === "app_open" && visit.opened === null) visit.opened = event.at;
    if (event.name === "app_screen") visit.pages.push({ path: String(event.props.screen ?? "/"), at: event.at, pv: null });
    if (event.name === "app_close" && typeof event.props.ms === "number") visit.closedMs = Math.max(visit.closedMs ?? 0, event.props.ms);
  } else if (event.name === "site_view" || account) {
    const first = visit.pages.length === 0;
    const path = String(event.props.path ?? ctx.page ?? "/");
    // the account page lives under /dashboard on the site's origin; its own paths start at its root
    visit.pages.push({ path: account ? `/dashboard${path === "/" ? "" : path}` : path, at: event.at, pv: ctx.pv ?? null });
    if (first) attribute(visit, ctx);
    else fill(visit, ctx);
  } else if (event.name === "site_goal") visit.goals.push({ goal: String(event.props.goal), at: event.at, to: typeof event.props.to === "string" ? event.props.to : null });
  else if (event.name === "site_leave" && ctx.pv) {
    const prev = visit.leaves.get(ctx.pv);
    visit.leaves.set(ctx.pv, { path: String(event.props.path ?? ctx.page ?? "/"), scroll: Math.max(prev?.scroll ?? 0, Number(event.props.scroll) || 0), ms: Math.max(prev?.ms ?? 0, Number(event.props.ms) || 0) });
  }
}

const ATTRIBUTED = ["source", "channel", "referrer", "campaign", "ref", "keyword"] as const;
const FILLED = ["country", "region", "city", "lat", "lon", "device", "os", "browser"] as const;
/** folds `later` (the same visits' events from a later time) into `into`, as if every event had been added to `into` in order */
export function mergeSessions(into: Sessions, later: Sessions) {
  for (const [key, next] of later) {
    const visit = into.get(key);
    if (!visit) { into.set(key, next); continue; }
    const app = key.startsWith("app:");
    if (app) {
      if (next.named) { visit.visitor = next.visitor; visit.named = true; }
      if (next.surface === "phone") visit.surface = "phone";
    } else if (!visit.pages.length && next.pages.length) {
      // a site or account visit takes its source from its first page view
      for (const field of ATTRIBUTED) (visit as unknown as Record<string, unknown>)[field] = next[field];
    }
    for (const field of FILLED) (visit as unknown as Record<string, unknown>)[field] ??= next[field];
    visit.start = Math.min(visit.start, next.start); visit.end = Math.max(visit.end, next.end);
    visit.pages.push(...next.pages); visit.goals.push(...next.goals);
    for (const [pv, leave] of next.leaves) {
      const prev = visit.leaves.get(pv);
      visit.leaves.set(pv, { path: leave.path, scroll: Math.max(prev?.scroll ?? 0, leave.scroll), ms: Math.max(prev?.ms ?? 0, leave.ms) });
    }
    visit.opened ??= next.opened;
    if (next.closedMs !== null) visit.closedMs = Math.max(visit.closedMs ?? 0, next.closedMs);
  }
}

/** the finished visits on these surfaces, oldest first; they share the sessions' lists, so sessions are finished once */
export function visitsFrom(by: Sessions, surfaces: readonly Surface[]): Visit[] {
  const out: Visit[] = [];
  for (const state of by.values()) { const visit = finished(state, surfaces); if (visit) out.push(visit); }
  return out.sort((a, b) => a.start - b.start);
}
/** visitsFrom in pieces, letting `pause` hand the event loop back between them */
export async function visitsFromPaced(by: Sessions, surfaces: readonly Surface[], pause: () => Promise<void>): Promise<Visit[]> {
  const out: Visit[] = [];
  let i = 0;
  for (const state of by.values()) {
    const visit = finished(state, surfaces);
    if (visit) out.push(visit);
    if ((++i & 4095) === 0) await pause();
  }
  // visits come in the order of their first event, which is their start: sorting is only ever a check
  for (let k = 1; k < out.length; k++) if (out[k]!.start < out[k - 1]!.start) return out.sort((a, b) => a.start - b.start);
  return out;
}
function finished(state: Session, surfaces: readonly Surface[]): Visit | null {
  if (!surfaces.includes(state.surface)) return null;
  const pages = state.pages;
  if (!pages.length && state.opened !== null) pages.push({ path: "/", at: state.opened, pv: null });
  if (!pages.length) return null;
  pages.sort((a, b) => a.at - b.at);
  let engaged = 0;
  for (const leave of state.leaves.values()) engaged += leave.ms;
  return { session: state.session, visitor: state.visitor, surface: state.surface, start: state.start, end: state.end, host: state.host, keyword: state.keyword, pages, goals: state.goals,
    leaves: state.leaves, entry: pages[0]!.path, exit: pages.at(-1)!.path, engagedMs: state.closedMs ?? Math.max(engaged, state.end - state.start),
    bounced: pages.length === 1 && state.goals.length === 0, source: state.source, channel: state.channel, referrer: state.referrer, campaign: state.campaign, ref: state.ref,
    country: state.country, region: state.region, city: state.city, lat: state.lat, lon: state.lon, device: state.device, os: state.os, browser: state.browser };
}
function attribute(visit: Visit, ctx: EventContext) {
  visit.source = ctx.source ?? "direct"; visit.channel = ctx.channel ?? "direct"; visit.referrer = ctx.referrer ?? null;
  visit.campaign = ctx.utm?.campaign ?? null; visit.ref = ctx.ref ?? ctx.utm?.source ?? null;
  visit.keyword = ctx.utm?.term?.toLowerCase().replace(/[^a-z0-9_.-]/g, "") || null;
  fill(visit, ctx);
}
function fill(visit: Visit, ctx: EventContext) {
  visit.country ??= ctx.country ?? null; visit.region ??= ctx.region ?? null; visit.city ??= ctx.city ?? null;
  visit.lat ??= ctx.lat ?? null; visit.lon ??= ctx.lon ?? null;
  visit.device ??= ctx.device ?? null; visit.os ??= ctx.os ?? null; visit.browser ??= ctx.browser ?? null;
}

/** who each site visitor and app install became: the identify links */
export interface Identity { accountOf: Map<string, string>; visitorsOf: Map<string, Set<string>>; installsOf: Map<string, Set<string>> }
export function identityOf(events: readonly StoredEvent[]): Identity {
  const accountOf = new Map<string, string>(), visitorsOf = new Map<string, Set<string>>(), installsOf = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.name !== "identify" || !event.accountId) continue;
    const visitor = event.ctx?.visitor, install = event.ctx?.install;
    if (visitor) { accountOf.set(visitor, event.accountId); (visitorsOf.get(event.accountId) ?? visitorsOf.set(event.accountId, new Set()).get(event.accountId)!).add(visitor); }
    if (install) { accountOf.set(`install:${install}`, event.accountId); (installsOf.get(event.accountId) ?? installsOf.set(event.accountId, new Set()).get(event.accountId)!).add(install); }
  }
  return { accountOf, visitorsOf, installsOf };
}

export const DIMENSIONS = ["channel", "source", "referrer", "campaign", "ref", "page", "entry", "exit", "country", "region", "city", "browser", "os", "device", "goal", "surface", "host", "keyword"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Filters = Partial<Record<Dimension, string>>;

/** the values a visit has for a dimension (a page or goal dimension can have several) */
export function valuesOf(visit: Visit, dim: Dimension): string[] {
  switch (dim) {
    case "page": return [...new Set(visit.pages.map(page => page.path))];
    case "goal": return [...new Set(visit.goals.map(goal => goal.goal))];
    case "entry": return [visit.entry];
    case "exit": return [visit.exit];
    // no referring host: the named source a link carried (?ref, utm_source), else the visit came in direct
    case "referrer": return [visit.referrer || (visit.source && visit.source !== "direct" && visit.source !== "unknown" ? visit.source : "direct")];
    default: {
      const value = visit[dim];
      return [value === null || value === undefined || value === "" ? "unknown" : String(value)];
    }
  }
}
export const matches = (visit: Visit, filters: Filters) => Object.entries(filters).every(([dim, value]) => value === undefined || valuesOf(visit, dim as Dimension).includes(value));

export interface People {
  /** account id -> sign-up time, for accounts that exist */
  signups: ReadonlyMap<string, number>;
  /** account id -> first payment time (paid or granted) */
  paid: ReadonlyMap<string, number>;
}

const pct = (part: number, whole: number) => whole > 0 ? part / whole : null;
const accountOf = (identity: Identity, person: string) => person.startsWith("acct_") ? person : identity.accountOf.get(person);
const median = (values: ArrayLike<number>) => {
  if (!values.length) return null;
  const sorted = Float64Array.from(values).sort(), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

/** a view's numbers built one visit at a time, so a long list of visits can be fed in pieces */
export interface Tally<T> { add(visit: Visit): void; result(): T }
const fed = <T,>(tally: Tally<T>, visits: readonly Visit[]) => { for (const visit of visits) tally.add(visit); return tally.result(); };

export interface Kpis { visitors: number; visits: number; pageviews: number; signups: number; paid: number; waitlist: number; conversion: number | null; bounce: number | null; visitMs: number | null }
/** the KPI strip for one window; with filters, signups and payments count only people whose visits match */
export function kpis(visits: readonly Visit[], identity: Identity, people: People, from: number, to: number, filters: Filters = {}): Kpis {
  return fed(kpisTally(identity, people, from, to, filters), visits);
}
export function kpisTally(identity: Identity, people: People, from: number, to: number, filters: Filters = {}): Tally<Kpis> {
  const visitors = new Set<string>(), joined = new Set<string>(), engaged: number[] = [];
  let count = 0, pageviews = 0, bounced = 0;
  return {
    add(visit) {
      if (visit.start < from || visit.start >= to || !matches(visit, filters)) return;
      visitors.add(visit.visitor); count++; pageviews += visit.pages.length; engaged.push(visit.engagedMs);
      if (visit.bounced) bounced++;
      if (visit.goals.some(goal => goal.goal === "waitlist_join")) joined.add(visit.visitor);
    },
    result() {
      const allowed = Object.keys(filters).length > 0 ? new Set([...visitors].map(visitor => accountOf(identity, visitor)).filter((id): id is string => !!id)) : null;
      const counted = (map: ReadonlyMap<string, number>) => [...map].filter(([id, at]) => at >= from && at < to && (!allowed || allowed.has(id))).length;
      const signups = counted(people.signups);
      return { visitors: visitors.size, visits: count, pageviews, signups, paid: counted(people.paid), waitlist: joined.size, conversion: pct(signups, visitors.size), bounce: pct(bounced, count), visitMs: median(engaged) };
    },
  };
}

/** buckets of an hour for windows up to two days, else of a day, starting at `from` (the caller's local midnight) */
export function bucketsOf(from: number, to: number): { size: number; starts: number[] } {
  const size = to - from <= 2 * DAY ? HOUR : DAY;
  const starts: number[] = [];
  for (let at = from; at < to; at += size) starts.push(at);
  return { size, starts };
}
export interface Series { size: number; starts: number[]; visitors: number[]; signups: number[]; paid: number[]; waitlist: number[] }
export function series(visits: readonly Visit[], people: People, from: number, to: number, filters: Filters = {}, identity?: Identity): Series {
  return fed(seriesTally(people, from, to, filters, identity), visits);
}
export function seriesTally(people: People, from: number, to: number, filters: Filters = {}, identity?: Identity): Tally<Series> {
  const { size, starts } = bucketsOf(from, to);
  const index = (at: number) => Math.floor((at - starts[0]!) / size);
  const visitors = starts.map(() => new Set<string>()), joined = starts.map(() => new Set<string>());
  const allowed = Object.keys(filters).length && identity ? new Set<string>() : null;
  return {
    add(visit) {
      if (visit.start < from || visit.start >= to || !matches(visit, filters)) return;
      visitors[index(visit.start)]?.add(visit.visitor);
      if (visit.goals.some(goal => goal.goal === "waitlist_join")) joined[index(visit.start)]?.add(visit.visitor);
      const account = identity ? accountOf(identity, visit.visitor) : undefined;
      if (allowed && account) allowed.add(account);
    },
    result() {
      const signups = starts.map(() => 0), paid = starts.map(() => 0);
      for (const [id, at] of people.signups) if (at >= from && at < to && (!allowed || allowed.has(id))) signups[index(at)]! += 1;
      for (const [id, at] of people.paid) if (at >= from && at < to && (!allowed || allowed.has(id))) paid[index(at)]! += 1;
      return { size, starts, visitors: visitors.map(set => set.size), signups, paid, waitlist: joined.map(set => set.size) };
    },
  };
}

export interface BreakdownRow { key: string; visitors: number; signups: number; paid: number }
/** a ranked card: visitors per value, with the signups and payments of the people those visitors became */
export function breakdown(visits: readonly Visit[], identity: Identity, people: People, dim: Dimension, from: number, to: number, filters: Filters = {}, limit = 50): BreakdownRow[] {
  return fed(breakdownTally(identity, people, dim, from, to, filters, limit), visits);
}
export function breakdownTally(identity: Identity, people: People, dim: Dimension, from: number, to: number, filters: Filters = {}, limit = 50): Tally<BreakdownRow[]> {
  const rows = new Map<string, { visitors: Set<string>; accounts: Set<string> }>();
  return {
    add(visit) {
      if (visit.start < from || visit.start >= to || !matches(visit, filters)) return;
      const account = accountOf(identity, visit.visitor);
      for (const value of valuesOf(visit, dim)) {
        const row = rows.get(value) ?? rows.set(value, { visitors: new Set(), accounts: new Set() }).get(value)!;
        row.visitors.add(visit.visitor);
        if (account) row.accounts.add(account);
      }
    },
    result() {
      const within = (map: ReadonlyMap<string, number>, ids: Set<string>) => [...ids].filter(id => { const at = map.get(id); return at !== undefined && at >= from && at < to; }).length;
      return [...rows].map(([key, row]) => ({ key, visitors: row.visitors.size, signups: within(people.signups, row.accounts), paid: within(people.paid, row.accounts) }))
        .sort((a, b) => b.visitors - a.visitors || b.signups - a.signups || a.key.localeCompare(b.key)).slice(0, limit);
    },
  };
}
/** feeds visits to tallies, handing the event loop back between pieces */
export async function feed(visits: readonly Visit[], tallies: ReadonlyArray<Tally<unknown>>, pause: () => Promise<void>) {
  for (let i = 0; i < visits.length; i++) {
    const visit = visits[i]!;
    for (const tally of tallies) tally.add(visit);
    if ((i & 1023) === 1023) await pause();
  }
}

/** how many people were on the site (the account pages included) in the last five minutes, and in an app; `present` are
 * the site's visitors only presence.ts saw (pages still open, the owner's own) */
export function online(events: readonly StoredEvent[], now: number, present: Iterable<string> = []) {
  const site = new Set<string>(present), app = new Set<string>();
  for (const event of events) {
    if (event.at < now - ONLINE_MS || event.at > now + 60_000) continue;
    if (SITE.has(event.name) && event.ctx?.visitor) site.add(event.ctx.visitor);
    if (event.name === "page_view" && (event.ctx?.visitor || event.accountId)) site.add(event.ctx?.visitor ?? event.accountId!);
    if (event.name.startsWith("app_") && (event.ctx?.install || event.accountId)) app.add(event.ctx?.install ?? event.accountId!);
  }
  return { site: site.size, app: app.size };
}

export const isActive = (event: StoredEvent) => ACTIVE.has(event.name) && !!event.accountId;

/** each account's active days, as UTC day numbers */
export function activeDays(events: readonly StoredEvent[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const event of events) if (isActive(event)) (out.get(event.accountId!) ?? out.set(event.accountId!, new Set()).get(event.accountId!)!).add(Math.floor(event.at / DAY));
  return out;
}

/** came back on day n after signing up: D1 is day 1, D7 days 7 to 13, D30 days 30 to 59 */
export const RETURN_WINDOWS = { d1: [1, 2], d7: [7, 14], d30: [30, 60] } as const;
export function returned(signup: number, days: Set<number> | undefined, window: readonly [number, number]): boolean {
  if (!days) return false;
  const base = Math.floor(signup / DAY);
  for (const day of days) if (day - base >= window[0] && day - base < window[1]) return true;
  return false;
}
/** whether a window could have happened yet for a signup; open windows are left out of a rate */
export const due = (signup: number, window: readonly [number, number], now: number) => Math.floor(signup / DAY) + window[0] < Math.floor(now / DAY) + 1 && signup + window[0] * DAY <= now;

export function retention(signups: ReadonlyMap<string, number>, days: Map<string, Set<number>>, now: number, weeks = 8) {
  const week = 7 * DAY, thisWeek = Math.floor((now - 4 * DAY) / week) * week + 4 * DAY;
  const cohorts = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = thisWeek - i * week, members = [...signups].filter(([, at]) => at >= start && at < start + week);
    const rate = (window: readonly [number, number]) => {
      const eligible = members.filter(([, at]) => due(at, window, now));
      return eligible.length ? { n: eligible.filter(([id, at]) => returned(at, days.get(id), window)).length, of: eligible.length } : null;
    };
    const weekly = Array.from({ length: i + 1 }, (_, w) => {
      const from = start + w * week;
      if (from > now) return null;
      const active = members.filter(([id]) => [...(days.get(id) ?? [])].some(day => day * DAY >= from && day * DAY < from + week)).length;
      return members.length ? active / members.length : null;
    });
    cohorts.push({ start, size: members.length, d1: rate(RETURN_WINDOWS.d1), d7: rate(RETURN_WINDOWS.d7), d30: rate(RETURN_WINDOWS.d30), weekly });
  }
  return cohorts;
}

export interface FunnelStepResult { id: string; label: string; count: number; medianMs: number | null }
export interface FunnelInput {
  from: number; to: number; now: number;
  mode: "visitors" | "signups";
  visits: readonly Visit[];
  identity: Identity;
  /** the window's events, or `facts` already taken from them */
  events?: readonly StoredEvent[];
  facts?: FunnelFacts;
  people: People;
  /** first time each account chose a cloud (a cart checkout with a desktop) */
  cloudChosen: ReadonlyMap<string, number>;
  /** first time each account paired an app or connected a workspace */
  paired: ReadonlyMap<string, number>;
  /** first bot reply per account */
  replied: ReadonlyMap<string, number>;
}
const ONBOARDING = ["name", "plan", "app"] as const;

/** what the funnel reads from events, per account: the first time of each onboarding step ("done" when finished), its active
 *  days, and its newest event (the page it was on) */
export interface FunnelFacts {
  onboarding: Map<string, Map<string, number>>;
  days: Map<string, Set<number>>;
  last: Map<string, { name: string; page: string | null }>;
}
export function funnelFacts(events: readonly StoredEvent[]): FunnelFacts {
  const onboarding = new Map<string, Map<string, number>>(), last = new Map<string, { name: string; page: string | null }>();
  for (const event of events) {
    if (!event.accountId) continue;
    last.set(event.accountId, { name: event.name, page: event.name === "page_view" ? String(event.props.path) : event.ctx?.page ?? null });
    const step = event.name === "onboarding_step" ? String(event.props.step) : event.name === "onboarding_done" ? "done" : null;
    if (!step) continue;
    const per = onboarding.get(event.accountId) ?? onboarding.set(event.accountId, new Map()).get(event.accountId)!;
    if (!per.has(step) || per.get(step)! > event.at) per.set(step, event.at);
  }
  return { onboarding, days: activeDays(events), last };
}

/**
 * The Madani funnel per person: a step counts someone who reached it and every step above it, whenever they did (someone
 * may pair the app before paying); a step done before the one above it is left out of that step's median time.
 * The steps, in order: site visit, waitlist or signup, the onboarding steps, a cloud chosen, paid,
 * an app paired, the first bot reply, then coming back on D1, D7 and D30. Each step counts the people who reached it
 * after every step before it; the median time is from the step before.
 */
export function funnel(input: FunnelInput) {
  const { identity } = input;
  const firstVisit = new Map<string, Visit>();
  for (const visit of input.visits) if (!firstVisit.has(visit.visitor) || firstVisit.get(visit.visitor)!.start > visit.start) firstVisit.set(visit.visitor, visit);
  const { onboarding, days, last: lastEventOf } = input.facts ?? funnelFacts(input.events ?? []);
  type Person = { key: string; source: string; channel: string; account: string | null; times: Array<number | null>; last: { page: string | null; scroll: number | null; event: string | null } };
  const people: Person[] = [];
  const accountSteps = (account: string | null): Array<number | null> => {
    const signup = account ? input.people.signups.get(account) ?? null : null;
    const onb = account ? onboarding.get(account) : undefined;
    // an account made in the desktop app opens the web welcome once and then sets up in the app: pairing it counts as onboarded
    const inApp = account && !onb?.has("done") ? input.paired.get(account) ?? null : null;
    const steps: Array<number | null> = [...ONBOARDING.map(step => onb?.get(step) ?? inApp), onb?.get("done") ?? inApp,
      account ? input.cloudChosen.get(account) ?? null : null, account ? input.people.paid.get(account) ?? null : null,
      account ? input.paired.get(account) ?? null : null, account ? input.replied.get(account) ?? null : null];
    const back = (window: readonly [number, number]) => signup !== null && returned(signup, days.get(account!), window) ? signup + window[0] * DAY : null;
    return [...steps, back(RETURN_WINDOWS.d1), back(RETURN_WINDOWS.d7), back(RETURN_WINDOWS.d30)];
  };
  if (input.mode === "visitors") {
    const byVisitor = new Map<string, Visit[]>();
    for (const visit of input.visits) (byVisitor.get(visit.visitor) ?? byVisitor.set(visit.visitor, []).get(visit.visitor)!).push(visit);
    for (const [visitor, visit] of firstVisit) {
      if (visit.start < input.from || visit.start >= input.to) continue;
      const account = identity.accountOf.get(visitor) ?? null;
      const mine = byVisitor.get(visitor)!;
      const joined = mine.flatMap(item => item.goals.filter(goal => goal.goal === "waitlist_join").map(goal => goal.at));
      const signup = account ? input.people.signups.get(account) ?? null : null;
      const second = [signup, ...joined].filter((at): at is number => at !== null).sort((a, b) => a - b)[0] ?? null;
      const lastVisit = mine.at(-1)!;
      const lastLeave = [...lastVisit.leaves.values()].at(-1);
      people.push({ key: visitor, source: visit.source, channel: visit.channel, account, times: [visit.start, second, ...accountSteps(account)],
        last: { page: lastVisit.exit, scroll: lastLeave?.scroll ?? null, event: lastVisit.goals.at(-1)?.goal ?? null } });
    }
  } else {
    for (const [account, at] of input.people.signups) {
      if (at < input.from || at >= input.to) continue;
      const visitor = [...(identity.visitorsOf.get(account) ?? [])][0];
      const visit = visitor ? firstVisit.get(visitor) : undefined;
      const lastEvent = lastEventOf.get(account);
      people.push({ key: account, source: visit?.source ?? "unknown", channel: visit?.channel ?? "unknown", account, times: [visit?.start ?? null, at, ...accountSteps(account)],
        last: { page: lastEvent?.page ?? null, scroll: null, event: lastEvent?.name ?? null } });
    }
  }
  const labels: Array<[string, string]> = [["visit", "visited the site"], ["signup", input.mode === "visitors" ? "joined the waitlist or signed up" : "signed up"],
    ["onboarding_name", "onboarding: name"], ["onboarding_plan", "onboarding: plan"], ["onboarding_app", "onboarding: app"], ["onboarded", "finished onboarding"],
    ["cloud", "chose madani cloud"], ["paid", "paid"], ["paired", "paired an app"], ["replied", "first bot reply"], ["d1", "came back day 1"], ["d7", "came back week 2"], ["d30", "came back month 2"]];
  const startAt = input.mode === "visitors" ? 0 : 1;
  const steps: FunnelStepResult[] = [];
  const reachedAt: number[] = [];
  let alive = people.map(() => true);
  const dropped = new Map<string, Person[]>();
  for (let s = startAt; s < labels.length; s++) {
    const gaps: number[] = [];
    const next = people.map((person, i) => {
      if (!alive[i]) return false;
      const at = person.times[s];
      if (at === null || at === undefined) return false;
      const prev = s > startAt ? person.times[s - 1] : null;
      if (prev !== null && prev !== undefined && at >= prev) gaps.push(at - prev);
      return true;
    });
    const lost = people.filter((_, i) => alive[i] && !next[i]);
    if (s > startAt) dropped.set(labels[s - 1]![0], lost);
    alive = next;
    reachedAt.push(next.filter(Boolean).length);
    steps.push({ id: labels[s]![0], label: labels[s]![1], count: reachedAt.at(-1)!, medianMs: s > startAt ? median(gaps) : null });
  }
  const top = (values: Array<string | null>, limit = 6) => {
    const counts = new Map<string, number>();
    for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, limit);
  };
  const scrollBuckets = (list: Person[]) => [0, 25, 50, 75].map(low => list.filter(person => person.last.scroll !== null && person.last.scroll >= low && person.last.scroll < low + 25 + (low === 75 ? 1 : 0)).length);
  const drop = Object.fromEntries([...dropped].map(([id, list]) => [id, { count: list.length, lastPages: top(list.map(person => person.last.page)), lastEvents: top(list.map(person => person.last.event)), scroll: scrollBuckets(list) }]));
  const sources = new Map<string, Person[]>();
  for (const person of people) (sources.get(person.channel) ?? sources.set(person.channel, []).get(person.channel)!).push(person);
  // how many steps in a row from the first each person reached: they count toward every step up to there
  const depth = (person: Person) => { let k = startAt; while (k < labels.length && person.times[k] !== null && person.times[k] !== undefined) k++; return k - startAt; };
  const bySource = [...sources].map(([channel, list]) => {
    const counts = labels.slice(startAt).map(() => 0);
    for (const person of list) for (let k = depth(person) - 1; k >= 0; k--) counts[k]! += 1;
    return { channel, counts };
  }).sort((a, b) => b.counts[0]! - a.counts[0]!);
  return { mode: input.mode, steps, dropoff: drop, bySource };
}
