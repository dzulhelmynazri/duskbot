import { turnActivityStart } from "../../../shared/phone-activity";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import type { MobilePlatform } from "../platform";
import { createConnectionStore } from "../connection/connections";
import { placeKind } from "../connection/connection-notice";
import { rememberOpenChat } from "../open-chat-restore";

/** where the app opens after a sign-out or a removal: the first screen, or a computer the phone still links */
export type Landing = "first-screen" | "workspace";

const REVOKE_MS = 5_000;
const ACCOUNT_SIGN_OUT_MS = 5_000;

type Store = ReturnType<typeof createConnectionStore>;

function httpOrigins(record: MobileConnectionRecord): string[] {
  const origins = [record.origin, ...(record.via ?? []).map((route) => (route.kind === "https" || route.kind === "companion" ? route.url : undefined))];
  return [...new Set(origins.filter((origin): origin is string => Boolean(origin)))];
}

/** asks the place to forget this phone (its session and push token with it); a place that can't be reached keeps the
 * device until its owner removes it there */
async function revokeDevice(platform: MobilePlatform, record: MobileConnectionRecord, request: typeof fetch): Promise<void> {
  const token = await platform.secrets.get(record.sessionRef).catch(() => null);
  if (!token || !record.deviceId) return;
  for (const origin of httpOrigins(record)) {
    if (!origin.startsWith("https:")) continue;
    try {
      const response = await request(`${origin}/api/mobile/devices/${encodeURIComponent(record.deviceId)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` }, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(REVOKE_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok || response.status === 401 || response.status === 404) return;
    } catch { /* the next route, or keep it */ }
  }
}

async function forgetPlace(platform: MobilePlatform, store: Store, record: MobileConnectionRecord, request: typeof fetch): Promise<void> {
  await revokeDevice(platform, record, request);
  await store.remove(record.id);
  await platform.prefs.remove(`madani.account.enrolled.${record.id}`).catch(() => {});
}

async function endLiveActivities(platform: MobilePlatform): Promise<void> {
  const bridge = platform.turnActivity;
  if (!bridge) return;
  const running = await bridge.list().catch(() => []);
  await Promise.all(running.map((one) => bridge.end(one.id, turnActivityStart(one.startedAt), true).catch(() => {})));
}

/** With the shown place gone, the most recently used place left takes over; none left is the first screen. */
export async function landAfterRemoval(store: Store): Promise<Landing> {
  if (await store.active()) return "workspace";
  const left = [...await store.list()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  for (const record of left) {
    try { await store.setActive(record.id); return "workspace"; } catch { /* its token is gone: the next one */ }
  }
  return "first-screen";
}

/** Whose madani clouds a sign-out takes off the phone: `account`'s, the ones it lists (`listed`: their addresses) and,
 * when no other account stays signed in here, every one. */
export type SignedOut = { account: string | null; othersStay: boolean; listed?: readonly string[] };

/** Signing out of a madani bot account on the phone: every madani cloud it reached through that account leaves the phone
 * (its device on the cloud, token, push registration, unsent messages and cached chats), Live Activities end, and the
 * account's session ends on the service. The phone's other accounts and their clouds stay, and so do computers paired
 * with their own QR or code; with nothing left the app opens on its first screen. */
export async function signOutPhone({ platform, signOutAccount, signedOut = { account: null, othersStay: false }, fetch: request = globalThis.fetch }: {
  platform: MobilePlatform;
  signOutAccount(): Promise<unknown>;
  signedOut?: SignedOut;
  fetch?: typeof globalThis.fetch;
}): Promise<Landing> {
  const store = createConnectionStore(platform);
  await forgetCloudPlaces(platform, request, signedOut);
  await endLiveActivities(platform);
  // the account client forgets its Keychain session before it asks the service to end it, so a slow network only
  // delays the server-side revoke, never the sign-out on the phone
  await Promise.race([signOutAccount().catch(() => {}), new Promise((resolve) => setTimeout(resolve, ACCOUNT_SIGN_OUT_MS))]);
  rememberOpenChat(null);
  return landAfterRemoval(store);
}

/** the madani clouds saved on the phone that a sign-out takes with it, forgotten as signing out does */
export async function forgetCloudPlaces(platform: MobilePlatform, request: typeof fetch = globalThis.fetch, signedOut: SignedOut = { account: null, othersStay: false }): Promise<void> {
  const store = createConnectionStore(platform);
  const leaves = (record: MobileConnectionRecord) => !signedOut.othersStay || record.account?.id === signedOut.account
    || (!record.account && httpOrigins(record).some((origin) => signedOut.listed?.includes(origin)));
  const clouds = (await store.list()).filter((record) => placeKind(record) === "cloud" && leaves(record));
  await Promise.all(clouds.map((record) => forgetPlace(platform, store, record, request).catch(() => {})));
}

/** "Remove this computer": the phone's pairing with one computer ends, there and here. */
export async function removePlace(platform: MobilePlatform, id: string, request: typeof fetch = globalThis.fetch): Promise<Landing> {
  const store = createConnectionStore(platform);
  const record = (await store.list()).find((entry) => entry.id === id);
  if (record) await forgetPlace(platform, store, record, request);
  rememberOpenChat(null);
  return landAfterRemoval(store);
}
