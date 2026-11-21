import type { IncomingMessage, ServerResponse } from "node:http";
import { EVENTS, isEventName, routeOf, type EventName, type Props } from "./events.ts";
import { deviceOf, geoOf, referrerHost, touchContext, type EventContext } from "./context.ts";
import type { Present } from "./presence.ts";
import type { UsageRan } from "./usage.ts";
import { MAX_REPORT_FRUSTRATIONS, MAX_REPORT_SESSIONS, cleanUsageDigest, cleanUsageFrustration, cleanUsageSession, type UsageDigest, type UsageFrustration, type UsageReport, type UsageSession } from "../../../../shared/usage-signals.ts";

export const TRACK_PATH = "/v1/t";
export const APP_EVENTS_PATH = "/v1/app/events";
export const MAX_TRACK_BYTES = 4096;
export const MAX_APP_BYTES = 32_768;
export const MAX_APP_BATCH = 50;
const ID = /^[A-Za-z0-9_-]{22}$/, PV = /^[A-Za-z0-9_-]{8}$/, INSTALL = /^[A-Za-z0-9_-]{16,40}$/;
export const AUTOMATED = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|httpclient|headless|lighthouse|facebookexternalhit|embedly/i;

type Record_ = (name: EventName, input: { accountId?: string | null; props?: Props; at?: number; visitor?: string | null; ctx?: EventContext }) => void;
export interface IngestDeps {
  track: Record_;
  now(): number;
  trustProxy: boolean;
  /** origins whose pages may send site events (the site and the account page) */
  origins: Set<string>;
  readBody(req: IncomingMessage, max: number): Promise<Buffer>;
  rate(req: IncomingMessage, kind: string, max: number): void;
  /** a request from a signed-in admin's browser: the owner's own visits are never counted */
  isOwner(req: IncomingMessage): boolean;
  /** the account of an app's bearer session, or null */
  appAccount(req: IncomingMessage): string | null;
  /** records `identify` the first time this pair is seen */
  identify(accountId: string, ctx: { visitor?: string; install?: string }, via: "page" | "app"): void;
  declined(req: IncomingMessage): boolean;
  /** a visitor whose browser must keep no ids (see `cookieless` in context.ts) */
  cookieless(req: IncomingMessage): boolean;
  /** a cookieless visitor's ids: a daily-rotating salted hash and its current visit, both derived here */
  dailyVisit(req: IncomingMessage): { visitor: string; session: string };
  /** marks someone as on the site right now, in memory only (presence.ts) */
  present?(entry: Omit<Present, "at">): void;
}

const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : undefined;

function cors(req: IncomingMessage, res: ServerResponse, allowed: Set<string> | "*") {
  const origin = req.headers.origin;
  if (allowed === "*") res.setHeader("access-control-allow-origin", "*");
  else if (typeof origin === "string" && allowed.has(origin)) { res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "origin"); }
}
function done(res: ServerResponse, status = 204) { if (!res.writableEnded) { res.writeHead(status, { "cache-control": "no-store" }); res.end(); } }

/** the tracker's answer to a recorded event: whether it may keep madani_vid and madani_sid; anything else means it may not */
export interface TrackAnswer { persist: boolean }
function answer(res: ServerResponse, value: TrackAnswer) {
  if (res.writableEnded) return;
  res.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** the site tracker's beacon: text/plain JSON (no preflight), one event per request */
export async function handleTrack(req: IncomingMessage, res: ServerResponse, deps: IngestDeps) {
  cors(req, res, deps.origins);
  if (res.hasHeader("access-control-allow-origin")) res.setHeader("access-control-allow-credentials", "true");
  if (req.method === "OPTIONS") { res.setHeader("access-control-allow-methods", "POST"); res.setHeader("access-control-allow-headers", "content-type"); return done(res); }
  if (req.method !== "POST") return done(res, 405);
  const origin = req.headers.origin;
  if (typeof origin === "string" && !deps.origins.has(origin)) return done(res, 403);
  deps.rate(req, "track", 3000);
  let raw: Buffer;
  try { raw = await deps.readBody(req, MAX_TRACK_BYTES); } catch { return done(res, 413); }
  if (deps.declined(req) || AUTOMATED.test(String(req.headers["user-agent"] ?? "")) || !req.headers["user-agent"]) return done(res);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch { return done(res, 400); }
  if (!body || typeof body !== "object" || body.v !== 1 || typeof body.vid !== "string" || !ID.test(body.vid) || typeof body.sid !== "string" || !ID.test(body.sid)) return done(res, 400);
  const host = text(body.h, 253)?.toLowerCase();
  const hosts = new Set([...deps.origins].map(item => { try { return new URL(item).hostname; } catch { return ""; } }));
  if (!host || !hosts.has(host)) return done(res, 400);
  const path = routeOf(text(body.p, 300) ?? "/") ?? "/";
  const pv = typeof body.pv === "string" && PV.test(body.pv) ? body.pv : undefined;
  // the owner's own visits are never recorded, only shown as here now; a ping is an open page saying it still is
  const owner = deps.isOwner(req);
  if (owner || body.e === "ping") {
    const { country, city, lat, lon } = geoOf(req, deps.trustProxy);
    const visitor = owner ? `owner:${body.vid}` : deps.cookieless(req) ? deps.dailyVisit(req).visitor : body.vid;
    deps.present?.({ key: visitor, page: path, owner, ...(country ? { country } : {}), ...(city ? { city } : {}), ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}) });
    return done(res);
  }
  const persist = !deps.cookieless(req);
  const ids = persist ? { visitor: body.vid, session: body.sid } : deps.dailyVisit(req);
  const base: EventContext = { session: ids.session, ...(pv ? { pv } : {}), host, page: path };
  if (body.e === "pageview") {
    const tags = body.u && typeof body.u === "object" ? body.u as Record<string, unknown> : {};
    const width = Number(body.w);
    deps.track("site_view", { props: { path }, visitor: ids.visitor, ctx: {
      ...base, ...deviceOf(String(req.headers["user-agent"] ?? ""), { brands: req.headers["sec-ch-ua"], hint: body.b }), ...geoOf(req, deps.trustProxy), ...(Number.isInteger(width) && width > 0 && width < 20_000 ? { width } : {}),
      ...touchContext({ referrer: referrerHost(body.r, host), utmSource: tags.utm_source ?? tags.source, utmMedium: tags.utm_medium, utmCampaign: tags.utm_campaign,
        utmContent: tags.utm_content, utmTerm: tags.utm_term, ref: tags.ref ?? tags.via }),
    } });
  } else if (body.e === "goal") {
    const meta = body.m && typeof body.m === "object" ? body.m as Record<string, unknown> : {};
    const goal = text(body.g, 40);
    if (!goal || !/^[a-z0-9_]{1,40}$/.test(goal)) return done(res, 400);
    const to = typeof meta.to === "string" ? routeOf(meta.to) : null, from = typeof meta.from === "string" ? routeOf(meta.from) : null;
    const props: Props = { goal, ...(to ? { to } : {}), ...(from ? { from } : {}), ...(typeof meta.host === "string" ? { host: meta.host.toLowerCase() } : {}) };
    for (const key of ["section", "label", "value"]) if (typeof meta[key] === "string") props[key] = meta[key].toLowerCase();
    deps.track("site_goal", { props, visitor: ids.visitor, ctx: base });
  } else if (body.e === "sections") {
    if (!Array.isArray(body.l) || body.l.length > 30) return done(res, 400);
    for (const entry of body.l) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !/^[a-z0-9_]{1,40}$/.test(entry[0]) || typeof entry[1] !== "number" || !Number.isFinite(entry[1])) continue;
      deps.track("site_section", { props: { path, section: entry[0], ms: Math.max(0, Math.min(86_400_000, Math.round(entry[1]))) }, visitor: ids.visitor, ctx: base });
    }
  } else if (body.e === "leave") {
    const folds = Math.round(Number(body.f) || 0);
    deps.track("site_leave", { props: { path, scroll: Math.max(0, Math.min(100, Math.round(Number(body.s) || 0))), ms: Math.max(0, Math.min(86_400_000, Math.round(Number(body.t) || 0))),
      ...(folds > 0 ? { folds: Math.min(100, folds) } : {}) }, visitor: ids.visitor, ctx: base });
  } else return done(res, 400);
  return answer(res, { persist });
}

/** the desktop and phone apps' usage: counts, screens and features, never content; anonymous until signed in */
export async function handleAppEvents(req: IncomingMessage, res: ServerResponse, deps: IngestDeps) {
  cors(req, res, "*");
  if (req.method === "OPTIONS") { res.setHeader("access-control-allow-methods", "POST"); res.setHeader("access-control-allow-headers", "content-type, authorization"); return done(res); }
  if (req.method !== "POST") return done(res, 405);
  deps.rate(req, "app-events", 1500);
  let raw: Buffer;
  try { raw = await deps.readBody(req, MAX_APP_BYTES); } catch { return done(res, 413); }
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch { return done(res, 400); }
  const install = typeof body?.install === "string" && INSTALL.test(body.install) ? body.install : null;
  const events = Array.isArray(body?.events) ? body.events : null;
  if (!install || !events || events.length < 1 || events.length > MAX_APP_BATCH) return done(res, 400);
  deps.rate(req, `app-install:${install}`, 1500);
  const accountId = deps.appAccount(req);
  const session = typeof body.session === "string" && INSTALL.test(body.session) ? body.session : undefined;
  const platform = text(body.platform, 20), version = text(body.version, 40);
  const ctx: EventContext = { install, ...(session ? { session } : {}), app: { ...(platform && /^[a-z0-9]{2,20}$/.test(platform) ? { platform } : {}), ...(version && /^[0-9A-Za-z.+-]{1,40}$/.test(version) ? { version } : {}) } };
  if (accountId) deps.identify(accountId, { install }, "app");
  const time = deps.now();
  for (const item of events as unknown[]) {
    const event = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (!isEventName(event.name) || EVENTS[event.name].source !== "app") continue;
    const at = typeof event.at === "number" && event.at > time - 7 * 86_400_000 && event.at < time + 300_000 ? Math.round(event.at) : time;
    const props = event.name === "app_screen" && event.props && typeof event.props === "object"
      ? { screen: routeOf(String((event.props as Record<string, unknown>).screen ?? "")) ?? "" } : event.props;
    deps.track(event.name, { accountId, props: props as Props, at, ctx: { ...ctx, ...(event.name === "app_screen" && typeof (props as Props).screen === "string" ? { page: (props as Props).screen as string } : {}) } });
  }
  return done(res);
}

export const APP_NOTES_PATH = "/v1/app/notes";
export const MAX_NOTES_BYTES = 131_072;
type Notes = Pick<UsageReport, "frustrations" | "sessions" | "digests">;
export interface NotesDeps {
  now(): number;
  readBody(req: IncomingMessage, max: number): Promise<Buffer>;
  rate(req: IncomingMessage, kind: string, max: number): void;
  appAccount(req: IncomingMessage): string | null;
  save(accountId: string | null, workspaceId: string, notes: Notes, ran: UsageRan): Promise<unknown>;
}
const OS: Record<string, string> = { darwin: "mac", win32: "windows", linux: "linux" };
/** notes from a desktop app whose workspace no account dashboard hears from. Security: open to anyone, like the app
 * events; every note goes through the same cleaning as a workspace report's and the install is only a key, never shown */
export async function handleAppNotes(req: IncomingMessage, res: ServerResponse, deps: NotesDeps) {
  if (req.method !== "POST") return done(res, 405);
  deps.rate(req, "app-notes", 300);
  let raw: Buffer;
  try { raw = await deps.readBody(req, MAX_NOTES_BYTES); } catch { return done(res, 413); }
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch { return done(res, 400); }
  const install = typeof body?.install === "string" && INSTALL.test(body.install) ? body.install : null;
  if (!install) return done(res, 400);
  deps.rate(req, `app-notes:${install}`, 60);
  const time = deps.now(), list = (value: unknown, max: number) => Array.isArray(value) ? value.slice(0, max) : [];
  const notes: Notes = {
    frustrations: list(body.frustrations, MAX_REPORT_FRUSTRATIONS).map(item => cleanUsageFrustration(item, time)).filter((item): item is UsageFrustration => !!item),
    sessions: list(body.sessions, MAX_REPORT_SESSIONS).map(item => cleanUsageSession(item, time)).filter((item): item is UsageSession => !!item),
    digests: list(body.digests, 2).map(item => cleanUsageDigest(item, time)).filter((item): item is UsageDigest => !!item),
  };
  const platform = text(body.platform, 20), version = text(body.version, 20);
  const os = OS[platform ?? ""];
  const ran: UsageRan = { place: "desktop", ...(os ? { os } : {}), ...(version && /^[\w.+-]{1,20}$/.test(version) ? { version } : {}) };
  await deps.save(deps.appAccount(req), `app:${install}`, notes, ran);
  return done(res);
}
