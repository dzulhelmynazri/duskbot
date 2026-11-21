import { useCallback, useEffect, useState } from "react";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";

/** "Reconnecting" shows this long; after it the phone says it can't reach the place and offers to try again */
export const STUCK_AFTER_MS = 15_000;
/** a live stream that opens, or comes back, within this says nothing at all */
export const RECONNECTING_AFTER_MS = 2_500;
/** a madani cloud usually wakes within a minute; after this the phone says it is taking a while */
export const WAKE_SLOW_AFTER_MS = 90_000;

export type ConnectionNotice = "offline" | "reconnecting" | "waking" | "stuck" | "wake-slow" | null;

export type NoticeInput = {
  hydrated: boolean; connected: boolean; offline: boolean; waking: boolean; resuming: boolean;
  /** a madani cloud that agreed to sleep: the person's next action wakes it, so it is never a problem */
  asleep?: boolean;
  /** when the place last answered a request (src/mobile/connection/reachability.ts), null if it has not */
  answeredAt?: number | null;
  /** when the live connection was last seen dropping, null while connected */
  downSince: number | null; wakingSince: number | null; now: number;
};

/** What the phone says about its live connection: nothing, a short status, or (time-boxed) a problem with an action. */
export function connectionNotice(input: NoticeInput): ConnectionNotice {
  if (!input.hydrated) return null;
  if (input.offline) return "offline";
  if (input.waking) return input.wakingSince !== null && input.now - input.wakingSince >= WAKE_SLOW_AFTER_MS ? "wake-slow" : "waking";
  if (input.connected || input.resuming || input.asleep) return null;
  if (input.downSince !== null && input.now - input.downSince < RECONNECTING_AFTER_MS) return null;
  if (answeredRecently(input)) return "reconnecting";
  return input.downSince !== null && input.now - input.downSince >= STUCK_AFTER_MS ? "stuck" : "reconnecting";
}

const answeredRecently = (input: Pick<NoticeInput, "answeredAt" | "now">) => input.answeredAt != null && input.now - input.answeredAt < STUCK_AFTER_MS;

/** a managed madani cloud lives at d<20 hex>.madani.bot (or a preview of one); anything else is a computer */
export function isCloudOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try { return /^d[0-9a-f]{20}\.madani\.bot$/.test(new URL(origin).hostname); } catch { return false; }
}

export type PlaceKind = "cloud" | "computer";
export function placeKind(record: Pick<MobileConnectionRecord, "origin" | "via"> | undefined): PlaceKind {
  if (!record) return "computer";
  const origins = [record.origin, ...(record.via ?? []).map((route) => (route.kind === "https" ? route.url : undefined))];
  return origins.some((origin) => isCloudOrigin(origin)) ? "cloud" : "computer";
}

const since = { down: null as number | null, waking: null as number | null };
const restarted = new Set<() => void>();

/** Tracks when the connection dropped and when a wake began, once for every screen that asks, and re-renders when a
 * time box runs out. */
export function useConnectionNotice(input: Omit<NoticeInput, "downSince" | "wakingSince" | "now">, clock: () => number = Date.now) {
  const { hydrated, connected, offline, waking, resuming, asleep, answeredAt } = input;
  // a resume, going offline or a cloud asleep restarts the clock: the wait before "can't reach" counts from when it could connect
  const down = hydrated && !connected && !offline && !waking && !resuming && !asleep;
  const wakingNow = waking && !offline;
  const [downSince, setDownSince] = useState<number | null>(() => (down ? since.down ??= clock() : null));
  const [wakingSince, setWakingSince] = useState<number | null>(() => (wakingNow ? since.waking ??= clock() : null));
  const [, setTick] = useState(0);
  useEffect(() => {
    const sync = () => { setDownSince(since.down); setWakingSince(since.waking); };
    restarted.add(sync);
    return () => { restarted.delete(sync); };
  }, []);
  useEffect(() => {
    if (down) since.down ??= clock(); else since.down = null;
    setDownSince(since.down);
  }, [down, clock]);
  useEffect(() => {
    if (wakingNow) since.waking ??= clock(); else since.waking = null;
    setWakingSince(since.waking);
  }, [wakingNow, clock]);
  const stuckAt = downSince === null ? null : Math.max(downSince, answeredAt ?? -Infinity) + STUCK_AFTER_MS;
  const quietUntil = downSince === null ? null : downSince + RECONNECTING_AFTER_MS;
  const deadline = quietUntil !== null && quietUntil > clock() ? quietUntil : stuckAt ?? (wakingSince !== null ? wakingSince + WAKE_SLOW_AFTER_MS : null);
  useEffect(() => {
    if (deadline === null) return;
    const wait = deadline - clock();
    if (wait <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), wait + 50);
    return () => clearTimeout(timer);
  }, [deadline, clock]);
  const notice = connectionNotice({ ...input, downSince, wakingSince, now: clock() });
  /** trying again gives the connection a fresh time box, on every screen */
  const restart = useCallback(() => {
    if (since.down !== null) since.down = clock();
    if (since.waking !== null) since.waking = clock();
    for (const sync of restarted) sync();
  }, [clock]);
  return { notice, restart };
}
