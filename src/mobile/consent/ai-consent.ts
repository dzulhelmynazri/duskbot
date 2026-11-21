import type { Bot, InstanceInfo } from "@/state/store";
import type { MobilePlatform } from "../platform";

/** what the person answered on this phone, for one account and one linked computer */
export type AiConsent = { answer: "allowed"; at: number; providers: string[] } | { answer: "declined"; at: number };

/** per account and per linked computer: another computer runs other AIs, another account is another person */
export const consentKey = (accountId: string | null, connection: string) => `madani.mobile.ai-consent.v1.${accountId ?? "none"}.${connection}`;

/** The AI services the bots use, by the names the computer gives them, so the question can say who gets the messages. */
export function aiProviders(bots: readonly Pick<Bot, "modelSelection">[], instances: readonly Pick<InstanceInfo, "instanceId" | "displayName">[]): string[] {
  const names = new Set<string>();
  for (const bot of bots) {
    const name = instances.find((instance) => instance.instanceId === bot.modelSelection?.instanceId)?.displayName?.trim();
    if (name) names.add(name.slice(0, 60));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function parseConsent(value: string | null): AiConsent | null {
  try {
    const data: unknown = value ? JSON.parse(value) : null;
    if (!data || typeof data !== "object") return null;
    const one = data as Record<string, unknown>;
    if (typeof one.at !== "number") return null;
    if (one.answer === "declined") return { answer: "declined", at: one.at };
    if (one.answer === "allowed" && Array.isArray(one.providers) && one.providers.every((name) => typeof name === "string")) return { answer: "allowed", at: one.at, providers: one.providers as string[] };
  } catch {}
  return null;
}

/** Allowed for every AI the bots use now: one the person never saw named (a bot moved to another AI) asks again. */
export function consentCovers(consent: AiConsent | null, providers: readonly string[]): boolean {
  return consent?.answer === "allowed" && providers.every((name) => consent.providers.includes(name));
}

export function createConsentStore(prefs: MobilePlatform["prefs"], key: string, now: () => number = Date.now) {
  let current: AiConsent | null = null;
  let loaded = false;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const ready = prefs.get(key).then((value) => { current = parseConsent(value); }, () => {}).finally(() => { loaded = true; emit(); });
  const save = async (next: AiConsent) => { current = next; emit(); await prefs.set(key, JSON.stringify(next)).catch(() => {}); };
  return {
    ready,
    loaded: () => loaded,
    get: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    allow: (providers: readonly string[]) => save({ answer: "allowed", at: now(), providers: [...providers] }),
    decline: () => save({ answer: "declined", at: now() }),
  };
}
export type ConsentStore = ReturnType<typeof createConsentStore>;
