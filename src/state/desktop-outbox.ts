import { useEffect, useMemo } from "react";
import { createOutbox, type OutboxPrefs } from "./outbox-queue";
import { installSendOutbox } from "./send-outbox";
import { useStore } from "./store";

const KEY = "madanibot.outbox.v1";

/** localStorage as an outbox's prefs; a storage that refuses (private browsing, a full quota) keeps the list in memory. */
export function storagePrefs(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = globalThis.localStorage): OutboxPrefs {
  return {
    get: async (key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } },
    set: async (key, value) => { try { storage?.setItem(key, value); } catch {} },
    remove: async (key) => { try { storage?.removeItem(key); } catch {} },
  };
}

/** The workspace this window talks to, so another server's unsent messages never go to this one. */
export function desktopOutboxKey(origin = globalThis.location?.origin ?? ""): string {
  return `${KEY}:${origin}`;
}

/** A message that could not reach the server stays in the chat as sending and goes again, with the same sendId, as soon
 * as the live connection is back or the computer is online again. */
export function useDesktopOutbox(): void {
  const { state, dispatch } = useStore();
  const outbox = useMemo(() => createOutbox(storagePrefs(), desktopOutboxKey()), []);
  useEffect(() => installSendOutbox(outbox), [outbox]);
  const ready = state.hydrated && state.connected;
  useEffect(() => { if (ready) void outbox.flush(dispatch); }, [ready, outbox, dispatch]);
  useEffect(() => {
    if (!ready) return;
    const online = () => void outbox.flush(dispatch);
    globalThis.addEventListener?.("online", online);
    return () => globalThis.removeEventListener?.("online", online);
  }, [ready, outbox, dispatch]);
}
