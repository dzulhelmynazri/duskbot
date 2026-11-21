// A new madani cloud opened from this computer runs the app's first run there, with what this computer already knows: the
// person's name, picture and About me fill what the cloud lacks, the AIs signed in here are named so the cloud can
// offer the same ones, and the AI keys saved here go along sealed, so those AIs work there without asking again (CLI
// logins go through the Admin's hold instead). The cloud's own "welcome to madani cloud" is marked done, since the first
// run replaces it. All of it goes over this window's own signed-in session with the cloud, once; the hints the
// cloud already has are kept. A cloud whose welcome already ended is left alone.
import { cloudSealer } from "./cloud-seal.mjs";
import { uploadPicture } from "./team-profile-seed.mjs";

export const CLOUD_WELCOME_DONE = "cloud-welcome-done";
export const CLOUD_FROM_COMPUTER = "cloud-from-computer";
export const COMPUTER_AI_HINT = "computer-ai:";
const ENDED = new Set([CLOUD_WELCOME_DONE, "cloud-setup-hidden"]);
// the cloud meets its chief in its own first run
const NOT_CARRIED = new Set(["met-chief-v1"]);
const HINTS_MAX = 100;
const AIS_MAX = 8;
const STORED_PICTURE = /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)$/;

const strings = (value) => (Array.isArray(value) ? value.filter((hint) => typeof hint === "string") : []);

/** The AIs that work on this computer (signed in, not the free backup), by instance id. */
export function computerAis(instances) {
  const ready = (instance) => instance?.snapshot?.state === "available" && instance.snapshot.freeFallback !== true
    && (instance.driverKind === "clineAgent" ? instance.snapshot.authenticated === true : instance.access === "custom" || instance.snapshot.authenticated !== false);
  return strings((Array.isArray(instances) ? instances : []).filter(ready).map((instance) => instance.instanceId))
    .filter((id) => /^[\w.-]{1,40}$/u.test(id)).slice(0, AIS_MAX);
}

/** The onboarding patch for the cloud, or null when its welcome already ended. `mine` is this computer's record, `ais`
 * the AIs signed in here. Never a completedAt: the cloud's first run is still to come. */
export function welcomeForCloud(mine, theirs, ais = []) {
  const seen = strings(theirs?.hintsSeen);
  if (seen.some((hint) => ENDED.has(hint))) return null;
  const carried = strings(mine?.hintsSeen).filter((hint) => !NOT_CARRIED.has(hint));
  const own = [CLOUD_WELCOME_DONE, CLOUD_FROM_COMPUTER, ...ais.map((id) => `${COMPUTER_AI_HINT}${id}`)];
  const rest = [...new Set([...seen, ...carried])].filter((hint) => !own.includes(hint));
  return { hintsSeen: [...own, ...rest].slice(0, HINTS_MAX) };
}

/** What of this computer's profile the cloud lacks: the name and About me (the picture goes up on its own). */
export function profileForCloud(mine, theirs) {
  const patch = {};
  const name = typeof mine?.name === "string" ? mine.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (name && !String(theirs?.name ?? "").trim()) patch.name = name;
  const about = typeof mine?.aboutMe === "string" ? mine.aboutMe.trim().slice(0, 24_000) : "";
  if (about && !String(theirs?.aboutMe ?? "").trim()) patch.aboutMe = about;
  return patch;
}

const KEY_ID = /^key:\w{1,40}$/u;
const keyIds = (listed) => (Array.isArray(listed?.connections) ? listed.connections : [])
  .filter((item) => item?.kind === "key" && typeof item.id === "string" && KEY_ID.test(item.id)).map((item) => ({ id: item.id, label: String(item.label ?? item.id) }));

/** The AI keys saved here that the cloud has none of, sealed for it as the move sends them; a key already there wins.
 * `handoff` asks this computer's server for one key over its private port. Answers the labels that went. */
export async function carryAiKeys({ call, localJson, handoff, log = () => {} }) {
  const theirs = await call("GET", "/api/cloud-connections").catch(() => null);
  if (!theirs?.ok) return [];
  const have = new Set(keyIds(theirs.body).map((item) => item.id));
  const sealer = cloudSealer({ call });
  const carried = [];
  for (const item of keyIds(await localJson("/api/cloud-connections")).filter((one) => !have.has(one.id))) {
    const config = (await handoff({ kind: "connection", id: item.id }).catch(() => null))?.connection?.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    const saved = await sealer.config("PATCH", config).catch(() => null);
    if (saved?.ok) carried.push(item.label);
    else log(`cloud welcome: the ${item.label} key didn't go (${saved?.status ?? "no answer"})`);
  }
  return carried;
}

/**
 * Carries this computer's first-run facts to the cloud at `origin`, once. `fetch` carries this window's cookies (the
 * page's own session with the cloud); `localRequest` is this computer's server. The profile goes first, so the cloud's
 * first run already has the name when it reads the hints, and the AI keys go last. `handoff`: this computer's server's
 * private port, for the keys; without it they stay. Answers true when the record changed, false when there was nothing
 * to do or the cloud didn't answer.
 */
export async function carryWelcomeToCloud({ origin, fetch, localRequest, handoff = null, log = () => {} }) {
  if (!origin) return false;
  const cloud = (route, init = {}) => fetch(`${origin}${route}`, { credentials: "include", cache: "no-store", redirect: "error", ...init,
    headers: { accept: "application/json", origin, ...init.headers }, signal: AbortSignal.timeout(20_000) });
  const localJson = async (route) => {
    try { const response = await localRequest(route, { signal: AbortSignal.timeout(10_000) }); return response.ok ? await response.json() : null; } catch { return null; }
  };
  try {
    const read = await cloud("/api/config");
    if (!read.ok) { log(`cloud welcome: the cloud's settings didn't answer (${read.status})`); return false; }
    const theirs = await read.json();
    const mine = await localJson("/api/config");
    const patch = welcomeForCloud(mine?.onboarding, theirs?.onboarding, computerAis((await localJson("/api/instances"))?.instances));
    if (!patch) return false;

    const profile = profileForCloud(mine?.profile, theirs?.profile);
    const picture = mine?.profile?.avatarUrl;
    if (!theirs?.profile?.avatarUrl && typeof picture === "string" && STORED_PICTURE.test(picture)) {
      const stored = await uploadPicture(picture, localRequest, cloud).catch(() => null);
      if (stored) profile.avatarUrl = stored;
    }
    if (Object.keys(profile).length) {
      const saved = await cloud("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile }) });
      log(`cloud welcome: ${saved.ok ? `carried ${Object.keys(profile).join(", ")}` : `profile not carried (${saved.status})`}`);
    }
    const wrote = await cloud("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ onboarding: patch }) });
    if (!wrote.ok) { log(`cloud welcome: not marked (${wrote.status})`); return false; }
    if (handoff) {
      const call = async (method, route, body) => {
        const answer = await cloud(route, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
        return { ok: answer.ok, status: answer.status, body: await answer.json().catch(() => null) };
      };
      const keys = await carryAiKeys({ call, localJson, handoff, log }).catch(() => []);
      if (keys.length) log(`cloud welcome: carried the ${keys.join(", ")} key${keys.length > 1 ? "s" : ""}`);
    }
    return true;
  } catch (error) {
    log(`cloud welcome: not marked (${error?.message ?? error})`);
    return false;
  }
}
