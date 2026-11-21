import type { MobilePlatform } from "../platform";
import { createConnectionStore } from "../connection/connections";

export const INSTALLED_KEY = "madani.mobile.installed";

const claims = new WeakMap<MobilePlatform, Promise<boolean>>();

/** Anything an earlier launch of any build left in the app's own storage: its places, or any other preference. */
async function launchedBefore(platform: MobilePlatform): Promise<boolean> {
  const keys = await platform.prefs.keys?.().catch(() => null);
  if (keys?.some((key) => key !== INSTALLED_KEY)) return true;
  const places = await createConnectionStore(platform).list().catch(() => []);
  return places.length > 0;
}

/** True once, on the first launch of an install that holds nothing from an earlier launch: a new install, or the app
 * deleted and installed again. iOS deletes an app's UserDefaults (Capacitor Preferences) with it but keeps its Keychain
 * items, so a sign-in from before the delete can still be there; Android drops both unless a backup restores them. A
 * phone updated from any earlier build keeps its preferences, so an update is never a new install; the marker is
 * written on that first launch either way. */
export function claimFreshInstall(platform: MobilePlatform): Promise<boolean> {
  const existing = claims.get(platform);
  if (existing) return existing;
  const claim = (async () => {
    if (await platform.prefs.get(INSTALLED_KEY)) return false;
    const before = await launchedBefore(platform);
    await platform.prefs.set(INSTALLED_KEY, "1");
    return !before;
  })().catch(() => false);
  claims.set(platform, claim);
  return claim;
}
