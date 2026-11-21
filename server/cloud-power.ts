// A Cloud home's power: whether it is busy, and the sleep handshake with the Admin (docs/cloud-pro.md, "Sleeping
// homes"). The home never stops itself: on a plan that sleeps, the Admin reads `report()` about once a minute through
// its signed `GET /api/cloud/power`, asks `prepareSleep()` through `POST /api/cloud/power/sleep` once the home is idle,
// then suspends the machine (or stops it) and wakes it again before the next scheduled run. On every other plan the Admin
// never asks, and nothing here changes how the home behaves.
//
// Privacy: the report carries fixed codes and times only, like the health report.
import { readFileSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { withLegacyHeaders } from "../electron/legacy-names.mjs";

/** Why a home is not idle, as fixed codes (the Admin keeps the latest one for its operator page). */
export type CloudPowerBusy = "turn" | "run" | "live-call" | "computer" | "maintenance" | "recent-activity" | "recent-work" | "just-woke" | "due-soon" | "team" | "focus";

export interface CloudPowerReport {
  v: 1; at: number; bootedAt: number; wokeAt: number;
  idle: boolean; busy: CloudPowerBusy[];
  lastActivityAt: number | null; lastWorkAt: number | null;
  /** The earliest scheduled run (an enabled routine's next run or a queued run's retry, or 30 minutes on while a bot
   * waits for something), null when none: the Admin starts a sleeping home a minute before it. */
  nextDueAt: number | null;
  /** The runs due in the next day, each with how far it may move (`flexMs`, 0 for its exact time): runs inside the
   * person's waking hours leave the night's quiet gap in plain view (apps/cloud-service/docs/power.md). */
  upcoming?: Array<{ at: number; flexMs: number }>;
  /** The home said yes to a sleep request and has not been used or woken since. */
  sleeping: boolean;
  /** Holds that ran past CLOUD_HOLD_CAP_MS with no bot working, no input and no bytes moving: no longer counted as busy,
   * so the home can sleep; the Admin sends its operator one alert per incident. Absent when none. */
  stuck?: CloudPowerBusy[];
  /** What the first request after its last wake (or boot) was, if one came within WOKE_BY_MS: a fixed code for its kind
   * (`wakeCode`) and whether it was a background one. The Admin logs it for a wake by Fly's proxy: what woke it. */
  wokeBy: { by: string; background: boolean } | null;
}

export interface CloudPowerProbes {
  /** A turn runs anywhere: a bot, a room, delegated work. */
  turn(): boolean;
  /** A routine run is queued to start now, starting or running. One waiting for a person's answer is not: the answer wakes the home. */
  run(): boolean;
  liveCall(): boolean;
  /** A cloud computer is on, starting or within its own idle window: its idle timer lives in this process. */
  computer(): boolean;
  /** Backup or restore, Move to Cloud, an engine or browser install, a provider sign-in. */
  maintenance(): boolean;
  nextDueAt(): number | null;
  upcoming?(): Array<{ at: number; flexMs: number }>;
}

/** No user activity for this long (the Admin may ask for another window in its sleep request). */
export const CLOUD_IDLE_ACTIVITY_MS = 10 * 60_000;
/** Work finished this long ago, so follow-ups and delegated work get going first. */
export const CLOUD_IDLE_WORK_MS = 2 * 60_000;
/** Awake at least this long, so a wake is never undone before the request that caused it is served. */
export const CLOUD_IDLE_AWAKE_MS = 2 * 60_000;
/** The next run at least this far away: the Admin wakes a home a minute early, so a shorter sleep isn't worth it. */
export const CLOUD_IDLE_DUE_MS = 5 * 60_000;
/** A sleep the Admin asked for but never carried out (the suspend failed, the Admin restarted) ends by itself. */
export const CLOUD_SLEEP_PENDING_MS = 120_000;
/** A hold that is not a bot's own work (a transfer or other maintenance, a cloud computer, a live call) keeps the home up at
 * most this long with no bot working, no input and (for transfers) no bytes moving; each also ends on its own idle timer. */
export const CLOUD_HOLD_CAP_MS = 6 * 60 * 60_000;
const CAPPED: readonly CloudPowerBusy[] = ["maintenance", "computer", "live-call"];
/** The clock tick that notices a resume: a jump this much larger than the tick means the machine was suspended. */
const TICK_MS = 5_000, RESUME_JUMP_MS = 15_000;
/** The app pings `POST /api/cloud/focus` this often while its window is focused on the home. */
export const CLOUD_FOCUS_PING_MS = 4 * 60_000;
/** A focus ping counts this long (a ping and a missed one's slack). */
export const CLOUD_FOCUS_FRESH_MS = CLOUD_FOCUS_PING_MS + 2 * 60_000;
/** A focused window keeps the home up this long at most without use (the managed rails' `focusCapMs`). */
export const CLOUD_FOCUS_CAP_MS = 30 * 60_000;
export const CLOUD_FOCUS_PATH = "/api/cloud/focus";
/** The first request this soon after a wake or a boot is taken for what woke the home (`wokeBy`). */
export const WOKE_BY_MS = 30_000;
/** Each kind of request, as a fixed code, by its path: never more of the request than that. Anything else is a page. */
const WAKE_CODES: readonly [RegExp, string][] = [
  [/^\/api\/events$/, "events"], [/^\/api\/sync(\/|$)/, "sync"],
  [/^\/\.well-known\/madanibot\/environment$/, "version"], [/^\/api\/phones(\/|$)/, "phone"], [/^\/api\/presence(\/|$)/, "presence"],
  [/^\/api\/auth\/session$/, "session"], [/^\/(?:api\/)?(?:auth\/)?pair(?:ing)?(?:\/|$)/, "pair"], [/^\/api\/cloud\//, "admin"],
  [/^\/api\/health$/, "health"], [/^\/hooks(\/|$)/, "webhook"], [/^\/mcp-oauth\//, "sign-in"], [/^\/api\//, "api"],
];
/** A request's kind (`wokeBy`): "events" (a page's live stream), "version" (the desktop's version check), "api" and so on. */
export const wakeCode = (path: string) => WAKE_CODES.find(([pattern]) => pattern.test(path))?.[1] ?? "page";
/** Paths that never count as someone using the home: the event stream, the public probe, Files loops, the Admin's own
 * power reads, and the polls of an older desktop that still lends its computer (lending is retired; those get a 404). */
const BACKGROUND = [/^\/api\/events$/, /^\/api\/health$/, /^\/api\/sync(\/|$)/, /^\/api\/shared-computers(\/|$)/, /^\/api\/cloud\/power(\/|$)/, /^\/api\/cloud\/focus$/,
  // the phone's 25-second "the app is open" beat: a focus hint (server/mobile/link.ts), never use, or an open phone never sleeps its home
  /^\/api\/mobile\/presence$/,
  // the app lending its connection (server/home-egress-link.ts) links up whenever the home is awake: never someone using it
  /^\/api\/computer\/egress\/link$/,
  // the Mac app's long poll for its cloud bots' work (server/mac-control/host.ts) waits whenever the home is awake: never someone using it
  /^\/api\/mac\/self\/jobs$/];
export const CLOUD_POWER_PATH = "/api/cloud/power";
export const CLOUD_POWER_SLEEP_PATH = "/api/cloud/power/sleep";
export const CLOUD_BACKGROUND_HEADER = "x-madani-background";
export const CLOUD_POWER_HEADER = "x-madani-cloud-power";
const MARKER = "cloud-sleep.json";
/** Long-polls and streams that stay open by design: never "in flight" work. An open screen is not either: its input is
 * someone using the home and the screen itself a hint (server/routes/desktop-viewer.ts `presence`). */
const HELD = [/^\/api\/events$/, /^\/api\/sync\/changes$/, /^\/api\/desktop-viewer\/.+\/(?:websockify|direct)$/, /^\/api\/computer\/egress\/link$/, /^\/api\/mac\/self\/jobs$/];

/** The answer a held poll (Files sync) gets once the home agreed to sleep: the desktop pauses until it wakes. */
export function answerAsleep(res: ServerResponse, json: (res: ServerResponse, status: number, body: unknown) => void) {
  for (const [name, value] of Object.entries(withLegacyHeaders({ [CLOUD_POWER_HEADER]: "asleep" }))) res.setHeader(name, value);
  json(res, 503, { error: "asleep" });
}

/** A request counts as someone using the home unless it is a background path or the client marked it as background. */
export function countsAsActivity(path: string, headers: Record<string, string | string[] | undefined>): boolean {
  if (BACKGROUND.some((pattern) => pattern.test(path))) return false;
  const marked = headers[CLOUD_BACKGROUND_HEADER];
  return !(marked === "1" || (Array.isArray(marked) && marked.includes("1")));
}

/**
 * Whether this boot follows a sleep the machine was stopped for (its marker on the volume): then waking is not a startup,
 * and the routines' "run on startup" option does not fire. Reads and removes the marker. Any other boot: false, as before.
 */
export function wokeFromSleep(dataDir: string): boolean {
  const path = join(dataDir, MARKER);
  try {
    readFileSync(path, "utf8");
  } catch { return false; }
  rmSync(path, { force: true });
  return true;
}

export function createCloudPower(options: {
  dataDir: string; probes: CloudPowerProbes;
  /** A Team Cloud: the Admin never sleeps a team plan, and a sleep request is refused as busy with `team`. */
  team?: boolean;
  /** Tells connected clients the home is going to sleep (`{ kind: "power", state: "sleeping" }`, `by: "owner"` when paused). */
  broadcast(payload: Record<string, unknown>): void;
  now?: () => number;
  log?: (line: string) => void;
}) {
  const now = options.now ?? Date.now;
  const bootedAt = now();
  let wokeAt = bootedAt, lastActivityAt: number | null = null, lastWorkAt: number | null = null;
  /** The first request since `wokeAt` (`arrived`), and whether one came. */
  let wokeBy: CloudPowerReport["wokeBy"] = null, wokeSeen = false;
  let sleepingSince: number | null = null, inFlight = 0;
  /** The app's focus pings: the last one, and the first of the current run of them. */
  let focusAt: number | null = null, focusSince: number | null = null;
  let sleepAbort = new AbortController();
  let lastTick = now();
  /** When each capped hold began, the last bytes any in-flight transfer moved, and the holds now past their cap. */
  const holdSince = new Map<CloudPowerBusy, number>(), stuck = new Set<CloudPowerBusy>();
  const transfers = new Map<object, { bytes: () => number; seen: number }>();
  let progressAt = 0;

  const clearMarker = () => { try { rmSync(join(options.dataDir, MARKER), { force: true }); } catch {} };
  const endSleep = () => {
    if (sleepingSince === null) return;
    sleepingSince = null;
    sleepAbort = new AbortController();
    clearMarker();
  };
  const sleeping = () => {
    if (sleepingSince !== null && now() - sleepingSince >= CLOUD_SLEEP_PENDING_MS) endSleep();
    return sleepingSince !== null;
  };
  const working = (): CloudPowerBusy[] => {
    const busy: CloudPowerBusy[] = [];
    const { probes } = options;
    if (probes.turn()) busy.push("turn");
    if (probes.run()) busy.push("run");
    if (probes.liveCall()) busy.push("live-call");
    if (probes.computer()) busy.push("computer");
    if (probes.maintenance() || inFlight > 0) busy.push("maintenance");
    const at = now(), botWorking = busy.includes("turn") || busy.includes("run");
    for (const [, transfer] of transfers) { const bytes = transfer.bytes(); if (bytes !== transfer.seen) { transfer.seen = bytes; progressAt = at; } }
    for (const code of CAPPED) {
      if (!busy.includes(code)) { holdSince.delete(code); stuck.delete(code); continue; }
      if (!holdSince.has(code)) holdSince.set(code, at);
      const from = Math.max(holdSince.get(code)!, lastActivityAt ?? 0, code === "maintenance" ? progressAt : 0);
      if (!botWorking && at - from >= CLOUD_HOLD_CAP_MS) stuck.add(code); else stuck.delete(code);
    }
    return stuck.size ? busy.filter((code) => !stuck.has(code)) : busy;
  };
  /** A resume: the clock jumped past the tick (noticed once, by the tick or by a request). */
  const resumed = (at: number) => {
    if (at - lastTick <= TICK_MS + RESUME_JUMP_MS) return;
    lastTick = at;
    wokeAt = at;
    wokeBy = null;
    wokeSeen = false;
    endSleep();
  };
  /** Samples work (so "finished two minutes ago" needs no hook in every kind of work) and notices a resume. */
  const tick = () => {
    const at = now();
    resumed(at);
    lastTick = at;
    if (working().length) lastWorkAt = at;
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();

  const upcoming = () => { const runs = options.probes.upcoming?.(); return runs ? { upcoming: runs } : {}; };
  const busyNow = (activityMs: number): CloudPowerBusy[] => {
    tick();
    const at = now(), busy = working(), workingNow = busy.length > 0;
    if (lastActivityAt !== null && at - lastActivityAt < activityMs) busy.push("recent-activity");
    if (!workingNow && lastWorkAt !== null && at - lastWorkAt < CLOUD_IDLE_WORK_MS) busy.push("recent-work");
    if (at - wokeAt < CLOUD_IDLE_AWAKE_MS) busy.push("just-woke");
    const due = options.probes.nextDueAt();
    if (due !== null && due - at < CLOUD_IDLE_DUE_MS) busy.push("due-soon");
    // a hint, not work: capped from the later of the focus starting and the last use, as the managed rails cap it
    if (focusAt !== null && focusSince !== null && at - focusAt < CLOUD_FOCUS_FRESH_MS && at - Math.max(focusSince, lastActivityAt ?? 0) < CLOUD_FOCUS_CAP_MS) busy.push("focus");
    return busy;
  };

  /** Someone used the home (see `countsAsActivity`): a pending sleep is off. */
  const noteActivity = () => {
    lastActivityAt = now();
    endSleep();
  };
  /** An authenticated request in progress (an upload, a download) keeps the home awake until it ends; held polls and
   * the event stream don't. Returns the release. */
  const begin = (path: string, bytes?: () => number): (() => void) => {
    if (HELD.some((pattern) => pattern.test(path))) return () => {};
    inFlight += 1;
    const key = {};
    if (bytes) transfers.set(key, { bytes, seen: bytes() });
    let released = false;
    return () => { if (!released) { released = true; inFlight -= 1; transfers.delete(key); } };
  };

  return {
    noteActivity,
    begin,
    /** The app's window is focused on the home (a ping): never someone using it, and it never ends a pending sleep. */
    noteFocus() {
      const at = now();
      if (focusAt === null || at - focusAt >= CLOUD_FOCUS_FRESH_MS) focusSince = at;
      focusAt = at;
    },
    /** Any request at all, first thing (the server's own and its webhooks'): the first after a wake or a boot is what woke
     * it (`wokeBy`). Only its kind is kept. A resume is noticed here too, before the clock tick. */
    arrived(path: string, headers: IncomingHttpHeaders) {
      const at = now();
      resumed(at);
      if (wokeSeen || at - wokeAt > WOKE_BY_MS) return;
      wokeSeen = true;
      wokeBy = { by: wakeCode(path), background: !countsAsActivity(path, headers) };
    },
    /** An authenticated request: someone using the home (`countsAsActivity`), and work in progress until it ends. */
    request(path: string, headers: IncomingHttpHeaders, res: Pick<ServerResponse, "once"> & { socket?: { bytesRead?: number; bytesWritten?: number;
      once?(event: "close", listener: () => void): unknown; off?(event: "close", listener: () => void): unknown } | null }) {
      if (countsAsActivity(path, headers)) noteActivity();
      // bytes moving on its connection are a transfer's progress (CLOUD_HOLD_CAP_MS)
      const socket = res.socket;
      const release = begin(path, () => (socket?.bytesRead ?? 0) + (socket?.bytesWritten ?? 0));
      // a websocket route detaches the socket from its response, which then never closes
      socket?.once?.("close", release);
      res.once("close", () => { release(); socket?.off?.("close", release); });
    },
    report(activityMs = CLOUD_IDLE_ACTIVITY_MS): CloudPowerReport {
      const busy = busyNow(activityMs);
      return { v: 1, at: now(), bootedAt, wokeAt, idle: busy.length === 0, busy, lastActivityAt, lastWorkAt, nextDueAt: options.probes.nextDueAt(), ...upcoming(), sleeping: sleeping(), wokeBy,
        ...(stuck.size ? { stuck: [...stuck] } : {}) };
    },
    /** The Admin is about to suspend or stop this machine: yes only when idle now. From here until a resume, someone's
     * use or CLOUD_SLEEP_PENDING_MS, held polls answer "asleep" and new ones are refused (`sleeping`). `force`: the owner
     * paused it, so it stops whatever runs: the notice goes out even while busy, and the answer is always yes. */
    prepareSleep(activityMs = CLOUD_IDLE_ACTIVITY_MS, { force = false }: { force?: boolean } = {}): { ok: true; nextDueAt: number | null } | { ok: false; busy: CloudPowerBusy[] } {
      const busy = options.team ? ["team" as const, ...busyNow(activityMs)] : busyNow(activityMs);
      if (busy.length && !force) return { ok: false, busy };
      sleepingSince = now();
      try { writeFileAtomic(join(options.dataDir, MARKER), JSON.stringify({ at: sleepingSince })); }
      catch (error) { options.log?.(`cloud power: could not write the sleep marker: ${error instanceof Error ? error.message : String(error)}`); }
      sleepAbort.abort();
      // `by: "owner"`: the owner's own pause, which the app shows; our idle sleep it never shows
      options.broadcast({ kind: "power", state: "sleeping", ...(force ? { by: "owner" } : {}) });
      return { ok: true, nextDueAt: options.probes.nextDueAt() };
    },
    sleeping,
    /** Aborted the moment the home agrees to sleep: held long-polls end with it and answer "asleep". */
    sleepSignal: () => sleepAbort.signal,
    /** Tests: the clock tick, without waiting for the timer. */
    tick,
    close() { clearInterval(timer); },
  };
}

export type CloudPower = ReturnType<typeof createCloudPower>;

/** The running home's power, for route modules built before it (Files sync); null on any server that is not a Cloud home. */
let registered: Pick<CloudPower, "sleeping" | "sleepSignal"> & Partial<Pick<CloudPower, "noteFocus">> | null = null;
export function registerCloudPower(power: Pick<CloudPower, "sleeping" | "sleepSignal"> & Partial<Pick<CloudPower, "noteFocus">> | null) { registered = power; }
export const cloudPowerNow = () => registered;
