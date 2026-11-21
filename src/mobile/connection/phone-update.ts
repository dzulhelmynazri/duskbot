// whether the server this phone talks to needs a newer phone app (shared/server-api.ts phoneTooOld), and where to get one.
// a server older than the phone needs is never the person's job: a VPS or madani cloud server updates itself.
import { useEffect, useState } from "react";
import { phoneTooOld } from "../../../shared/server-api";
import type { MobilePlatform } from "../platform";

/** the App Store's numeric id for the iPhone app (apps/site/releases.json "ios") */
export const IOS_APP_STORE_ID: string | null = "6834725640";
/** the Android app is a signed APK on madani.bot's download page, not on Google Play */
export const ANDROID_APP_URL = "https://madani.bot/download#android";

export function storeUrl(kind: MobilePlatform["kind"], iosId: string | null = IOS_APP_STORE_ID): string {
  if (kind === "android") return ANDROID_APP_URL;
  if (kind === "ios" && iosId) return `https://apps.apple.com/app/id${iosId}`;
  return "https://madani.bot/download";
}

const pageFetch: typeof fetch = (...args) => fetch(...args);

/** asked once per linked computer, through its transport; a server that does not answer never shows the line */
export function usePhoneTooOld(connection: string | null, fetchImpl: typeof fetch = pageFetch): boolean {
  const [old, setOld] = useState(false);
  useEffect(() => {
    setOld(false);
    if (!connection) return;
    let active = true;
    void fetchImpl("/.well-known/madanibot/environment", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((descriptor) => { if (active) setOld(phoneTooOld(descriptor)); }, () => {});
    return () => { active = false; };
  }, [connection, fetchImpl]);
  return old;
}
