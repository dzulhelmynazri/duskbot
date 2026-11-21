// The offer to move this computer's bots to the person's new My Cloud (one-home.mjs does the move). The first move waits
// for the person's yes: once a Cloud is ready and this computer has bots or chats the move would carry, a sheet asks once;
// closed, a slim line at the top of the window asks; closed too, Settings → Computer keeps the action. A computer with
// nothing to carry moves by itself, as before.
//
// Everything here is read from state, never from an event: a Cloud that became ready while the app was closed is asked
// about at the next launch the same way. What the person chose is kept per Cloud (userData/cloud-move-offer.json), so a
// new Cloud asks again. Once accepted, the move's own journal takes over; this only says what it did, as product events:
// started, succeeded (with counts) and failed (with its reason code, once per code per move).

import { awayIn, parseJournal } from "./one-home.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const moment = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

export const OFFER_STAGES = Object.freeze(["none", "prompt", "banner", "settings"]);
/** Where the person said yes. */
export const OFFER_SOURCES = Object.freeze(["prompt", "banner", "settings", "two_places", "vps_move"]);
/** This computer's move summary is read again at most this often while the offer could show. */
export const LOOK_MS = 60_000;
/** The move kinds that are the person's own work, besides bots (cloud-send-parts.mjs MoveKind). */
const WORK = new Set(["bot", "routine", "call", "webhook", "app-event"]);
const MOVING = new Set(["copy", "wait", "freeze", "final", "check", "switch"]);
const WORD = /^[a-z0-9_]{1,40}$/u;

/** The Cloud an offer belongs to: the account and its Cloud's address. */
export const offerKey = (cloud) => `${cloud.account} ${cloud.origin}`;

/** What this computer's move summary (GET /api/cloud-send?move=1) would carry: its bots (a fresh install's untouched
 * starter is never in it), whether there is anything of the person's own at all, and whether the person talked with any
 * of those bots (`talked`): only then is the move asked about; otherwise what the first run brought in goes by itself. */
export function movable(summary) {
  const items = record(summary) && Array.isArray(summary.items) ? summary.items.filter(record) : [];
  const bots = items.filter((item) => item.kind === "bot");
  return { bots: bots.length, something: items.some((item) => WORK.has(item.kind)), talked: bots.some((item) => item.talked === true) };
}

/** The saved choices, read back for `key` only: another Cloud's are none. */
export function parseOffer(value, key) {
  if (!record(value) || value.v !== 1 || value.key !== key) return { v: 1, key };
  const accepted = record(value.accepted) && moment(value.accepted.at) && OFFER_SOURCES.includes(value.accepted.from) ? { at: value.accepted.at, from: value.accepted.from } : undefined;
  const reported = record(value.reported) && moment(value.reported.move)
    ? { move: value.reported.move, started: value.reported.started === true, done: value.reported.done === true,
      failed: Array.isArray(value.reported.failed) ? value.reported.failed.filter((code) => typeof code === "string" && WORD.test(code)).slice(0, 20) : [] }
    : undefined;
  return { v: 1, key, ...(accepted ? { accepted } : {}), ...(moment(value.prompt) ? { prompt: value.prompt } : {}), ...(moment(value.banner) ? { banner: value.banner } : {}),
    ...(reported ? { reported } : {}) };
}

/**
 * Which ask shows now. `cloud`: My Cloud as one-home reads it before any gate (one-home-main.mjs oneHomeCloud); `journal`:
 * the move's; `keep`: the person keeps this computer's bots here; `own`: a move to a server of their own is chosen;
 * `local`: what this computer would carry (movable), null while unknown; `saved`: parseOffer for this Cloud.
 * @returns {"none" | "prompt" | "banner" | "settings"}
 */
export function offerStage({ cloud, journal, keep = false, own = false, local, saved }) {
  if (!cloud?.origin || !cloud.ready || !cloud.moves || cloud.ended || own) return "none";
  const moving = parseJournal(journal);
  // A move under way or done says so on its own line; one that came home may be offered again.
  if (moving && moving.phase !== "back") return "none";
  if (!local?.something || !local.talked) return "none";
  if (keep) return "settings";
  if (saved?.accepted) return "none";
  if (!saved?.prompt) return "prompt";
  if (!saved?.banner) return "banner";
  return "settings";
}

/**
 * @param {{
 *   store: { read(): unknown, write(value: unknown): void },
 *   cloud(): null | { origin: string | null, account: string, ready: boolean, moves: boolean, ended: boolean },
 *   journal(): unknown,
 *   keep: { on(): boolean, set(on: boolean): Promise<unknown> },
 *   own?(): boolean,
 *   summary(): Promise<unknown>,
 *   kick(): unknown,
 *   onChange?(): void,
 *   track?(name: string, props: Record<string, string | number | boolean>): void,
 *   now?(): number,
 *   log?(line: string): void,
 * }} deps `summary()`: this computer's move summary, rejecting while its server doesn't answer. `kick()`: one-home goes on
 * (a yes, or a computer found to have nothing to carry). `track()`: a product event from main.
 */
export function createCloudMoveOffer({ store, cloud, journal, keep, own = () => false, summary, kick, onChange = () => {}, track = () => {}, now = Date.now, log = () => {} }) {
  let local = null, lookedAt = -Infinity, looking = null, said = "";
  const current = () => { const mine = cloud(); return mine?.origin ? mine : null; };
  const saved = (mine = current()) => {
    if (!mine) return null;
    try { return parseOffer(store.read(), offerKey(mine)); } catch { return parseOffer(null, offerKey(mine)); }
  };
  const save = (next) => { try { store.write(next); } catch (error) { log(`move offer: could not save (${error?.message ?? error})`); } };
  const keeps = () => { try { return keep.on(); } catch { return false; } };

  function state() {
    const mine = current();
    const stage = offerStage({ cloud: mine, journal: journal(), keep: keeps(), own: own(), local, saved: saved(mine) });
    return { stage, bots: local?.bots ?? 0 };
  }
  const publish = () => {
    const now = JSON.stringify(state());
    if (now === said) return;
    said = now;
    try { onChange(); } catch {}
  };

  /** No bot here the person talked with, by this computer's own summary: the move needs no yes. */
  const empty = () => local !== null && !local.talked;

  /** Reads this computer's summary again when the offer could show and the last look is old (or `force`). */
  async function refresh({ force = false } = {}) {
    const mine = current(), moving = parseJournal(journal());
    if (!mine || !mine.ready || mine.ended || (moving && moving.phase !== "back")) { publish(); return; }
    if (!force && now() - lookedAt < LOOK_MS) return;
    if (looking) return looking;
    looking = (async () => {
      const wasEmpty = empty();
      try { local = movable(await summary()); lookedAt = now(); }
      catch (error) { log(`move offer: this computer's summary waits (${error?.message ?? error})`); }
      finally { looking = null; }
      publish();
      if (empty() && !wasEmpty) kick();
    })();
    return looking;
  }

  return {
    state,
    refresh,
    /** The first move may start: the person said yes to this Cloud, or this computer has nothing to carry. */
    consent: () => empty() || accepted(),
    /** The person said yes to this Cloud, and does not keep this computer's bots here since. */
    accepted,
    /** The person's yes, from `from`: kept for this Cloud, a choice to keep the bots here is let go of, and the move starts. */
    async accept(from) {
      const mine = current();
      if (!mine || state().stage === "none") throw new Error("There is nothing to move to madani cloud right now.");
      const source = OFFER_SOURCES.includes(from) ? from : "settings";
      save({ ...saved(mine), accepted: { at: now(), from: source } });
      track(`cloud_move_${source}`, { action: "accepted" });
      if (keeps()) await keep.set(false);
      publish();
      await kick();
      return state();
    },
    /** The sheet or the line closed: the next ask shows instead. */
    dismiss(which) {
      const mine = current();
      if (!mine || (which !== "prompt" && which !== "banner")) return state();
      save({ ...saved(mine), [which]: now() });
      track(`cloud_move_${which}`, { action: "dismissed" });
      publish();
      return state();
    },
    /** The move changed: what it did, said once each as product events. */
    observe() {
      const mine = current(), moving = parseJournal(journal());
      if (!mine || !moving || moving.cloud?.name || !moment(moving.startedAt)) { publish(); return; }
      const before = saved(mine), from = before.accepted?.from ?? "auto";
      const was = before.reported?.move === moving.startedAt ? before.reported : { move: moving.startedAt, started: false, done: false, failed: [] };
      const next = { ...was, failed: [...was.failed] };
      if (!next.started && (MOVING.has(moving.phase) || moving.phase === "done")) { next.started = true; track("cloud_move", { step: "started", from }); }
      const code = typeof moving.failure?.code === "string" && WORD.test(moving.failure.code) ? moving.failure.code : null;
      if (code && moving.phase !== "done" && !next.failed.includes(code)) {
        next.failed.push(code);
        track("cloud_move", { step: "failed", reason: code, ...(typeof moving.failure.phase === "string" && WORD.test(moving.failure.phase) ? { phase: moving.failure.phase } : {}) });
      }
      if (!next.done && moving.phase === "done") {
        next.done = true;
        const counts = record(moving.counts) ? moving.counts : {};
        const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
        track("cloud_move", { step: "succeeded", bots: count(counts.bots), chats: count(counts.chats), routines: count(counts.routines), skills: count(counts.skills) });
      }
      if (JSON.stringify(next) !== JSON.stringify(was) || before.reported?.move !== moving.startedAt) save({ ...before, reported: next });
      publish();
    },
    /** Home is My Cloud (the move is done): nothing to offer. */
    away: () => awayIn(parseJournal(journal())),
  };

  function accepted() {
    const mine = current();
    return Boolean(mine && saved(mine)?.accepted) && !keeps();
  }
}
