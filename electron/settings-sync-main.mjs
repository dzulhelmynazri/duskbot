// Main's side of settings sync (settings-sync.mjs): the same places connector sync keeps level (this computer, My Cloud
// while it is awake, servers of the person's own; never a team's Cloud), brought level every two minutes, at once when
// this computer's server says a setting changed, and soon after one changes at another place (a light look every 20
// seconds at what each place last changed).
import { ownRemotePlaces } from "./connector-sync-main.mjs";
import { localSettingsPlace, remoteSettingsPlace, syncSettings } from "./settings-sync.mjs";

const EVERY_MS = 2 * 60_000;
const LOOK_MS = 20_000;
const SOON_MS = 1_000;
export const SETTINGS_CHANGED = "madanibot:settings-changed";

/** What a place last changed, in one line: two looks that differ mean something changed there. */
const lastChange = (listing) => listing ? Object.entries(listing.settings).map(([key, entry]) => `${key}:${entry.digest.slice(0, 12)}:${entry.at}`).sort().join(",") : "";

/**
 * @param {{
 *   localRequest(route: string, init?: RequestInit): Promise<Response>,
 *   handoff(what: object): Promise<any>,
 *   fetch: typeof fetch,
 *   environments(): any[],
 *   cloud(): { origin: string | null, asleep: boolean, sleeps?: boolean },
 *   ownHome: { owns(place: any): boolean },
 *   saveSecret?(key: string, value: unknown): Promise<boolean>,
 *   log?(line: string): void,
 * }} deps
 */
export function installSettingsSyncMain({ localRequest, handoff, fetch: fetchImpl, environments, cloud, ownHome, saveSecret, log = () => {} }) {
  const local = () => ({ key: "local", kind: "local", label: "This computer", client: localSettingsPlace(localRequest, handoff, { saveSecret }) });
  const places = () => [local(), ...ownRemotePlaces({ fetch: fetchImpl, environments, cloud, ownHome }).map(({ call, ...place }) => ({ ...place, client: remoteSettingsPlace(call) }))];
  const refused = new Map();
  const seen = new Map();
  let running = null, again = false;
  const pass = async () => {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        const all = places();
        // each place's listing is read once, here, for the look as well as the pass
        for (const place of all) {
          const list = place.client.list;
          place.client = { ...place.client, list: async () => { const listing = await list(); seen.set(place.key, lastChange(listing)); return listing; } };
        }
        const done = await syncSettings(all, { log, refused });
        if (done.changed.length) log(`settings sync: ${done.changed.length} changed`);
        // what this pass wrote is the places' own now: the look must not take it for a change
        if (done.changed.length) for (const place of all) seen.set(place.key, lastChange(await place.client.list().catch(() => null)));
        return done;
      } catch { return null; }
      finally { running = null; }
    })();
    const done = await running;
    if (again) { again = false; void pass(); }
    return done;
  };
  let soonTimer = null;
  const soon = () => {
    if (soonTimer) return;
    soonTimer = setTimeout(() => { soonTimer = null; void pass(); }, SOON_MS);
    soonTimer.unref?.();
  };
  // another place changed something: worth a pass
  const look = async () => {
    if (running) return;
    for (const place of places().filter((entry) => entry.key !== "local")) {
      const listing = await place.client.list().catch(() => null);
      if (!listing) continue;
      const line = lastChange(listing);
      if (seen.has(place.key) && seen.get(place.key) !== line) { soon(); return; }
      seen.set(place.key, line);
    }
  };
  const timer = setInterval(() => void pass(), EVERY_MS);
  timer.unref?.();
  const looking = setInterval(() => void look(), LOOK_MS);
  looking.unref?.();
  const first = setTimeout(() => void pass(), 25_000);
  first.unref?.();
  return {
    pass,
    soon,
    /** This computer's server said a setting changed here. */
    receive(message) {
      if (message?.type !== SETTINGS_CHANGED) return false;
      soon();
      return true;
    },
    /** Coming home from a Cloud that ended: its settings come here first where they are newer (`call`: the export
     * session there). */
    bringHome: (call) => syncSettings([local(), { key: "cloud:ending", kind: "cloud", label: "My Cloud", client: remoteSettingsPlace(call) }], { log }),
    close: () => { clearInterval(timer); clearInterval(looking); clearTimeout(first); if (soonTimer) clearTimeout(soonTimer); },
  };
}
