import type { MobilePushRegistration } from "../../../shared/mobile-link";
import type { MobilePlatform } from "../platform";
import { createConnectionStore } from "./connections";

const pending = new WeakMap<MobilePlatform, Promise<void>>();

/** a workspace drops a token APNs or FCM refused, so a saved registration is checked before it is trusted */
async function stillRegistered(service: MobilePushRegistration["service"]): Promise<boolean> {
  try {
    const response = await fetch("/api/mobile/device", { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); return true; }
    const answer = await response.json() as { device?: { push?: unknown } };
    return answer.device?.push === service;
  } catch {
    return true;
  }
}

/** `prompt`: the system may ask the person now (they just did something a notification follows up on); without it a
 * phone that was never asked registers nothing, so the app never asks at launch */
export function registerPushForConnection(platform: MobilePlatform, { prompt = false }: { prompt?: boolean } = {}): Promise<void> {
  const existing = pending.get(platform);
  if (existing) return existing;
  const work = (async () => {
    if (!platform.native || !platform.registerPush) return;
    const active = await createConnectionStore(platform).active();
    if (!active?.record.deviceId || !active.record.capabilities.notifications) return;
    const registration = await platform.registerPush({ prompt });
    if (!registration) return;
    const body: MobilePushRegistration = {
      service: registration.platform, token: registration.token,
      ...(registration.platform === "apns" ? { environment: import.meta.env.DEV ? "sandbox" : "production" } : {}),
    };
    const value = JSON.stringify(body);
    const key = `madani.mobile.push.${active.record.id}`;
    if (await platform.prefs.get(key) === value && await stillRegistered(body.service)) return;
    if ((await createConnectionStore(platform).active())?.record.id !== active.record.id) return;
    const response = await fetch("/api/mobile/push", { method: "PUT", headers: { "Content-Type": "application/json" }, body: value, signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    if (response.ok) await platform.prefs.set(key, value);
  })().catch(() => {}).finally(() => pending.delete(platform));
  pending.set(platform, work);
  return work;
}
