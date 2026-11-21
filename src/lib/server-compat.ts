// What the server this page talks to can answer. The desktop app shows its own build of this UI for every place, so a
// place's server can be older than the page: a part it cannot answer is hidden, never shown broken.
import { useEffect, useState } from "react";

import { levelHas, SERVER_API_LEVEL, serverApiLevel, type ServerFeature } from "../../shared/server-api";
import { ApiError } from "@/state/api";

export interface ServerCompat {
  /** `capabilities.api`, or null for a server from before levels (or one that did not say). */
  level: number | null;
  version: string | null;
  /** Parts this page found the server without, by asking. */
  missing: ServerFeature[];
}

/** Servers from before the rename describe themselves at the old name. */
const DESCRIPTORS = ["/.well-known/madanibot/environment", "/.well-known/openmausbot/environment"];

let reading: Promise<ServerCompat> | null = null;
let described: Omit<ServerCompat, "missing"> | null = null;
const missing = new Set<ServerFeature>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

async function describe(fetchImpl: typeof fetch): Promise<Omit<ServerCompat, "missing">> {
  for (const path of DESCRIPTORS) {
    const answer = await fetchImpl(path, { cache: "no-store" }).then((res) => (res.ok ? res.json() : null), () => null).catch(() => null);
    if (answer && typeof answer === "object") return { level: serverApiLevel(answer), version: typeof answer.version === "string" ? answer.version : null };
  }
  return { level: null, version: null };
}

export function currentServerCompat(): ServerCompat {
  return { level: described?.level ?? null, version: described?.version ?? null, missing: [...missing] };
}

/** Asked once per page. */
export function readServerCompat(fetchImpl: typeof fetch = fetch): Promise<ServerCompat> {
  reading ??= describe(fetchImpl).then((next) => { described = next; changed(); return currentServerCompat(); });
  return reading;
}

export async function serverHas(feature: ServerFeature, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const { level } = await readServerCompat(fetchImpl);
  return !missing.has(feature) && levelHas(level, feature) !== false;
}

/** A server's answer for a path it has no route for (server/index.ts "no route: METHOD path"), not a refusal of a known one. */
export function isMissingRoute(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && /^no route\b/.test(error.message);
}

/** `read`, when the server can answer it: null when it cannot, and the part stays hidden for this page. */
export async function whenServerHas<T>(feature: ServerFeature, read: () => Promise<T>): Promise<T | null> {
  if (!(await serverHas(feature))) return null;
  try {
    return await read();
  } catch (error) {
    if (!isMissingRoute(error)) throw error;
    missing.add(feature);
    changed();
    return null;
  }
}

/** Older than this page needs: it said a lower level, or it lacked a part this page asked for. */
export function serverBehind(compat: ServerCompat): boolean {
  return compat.missing.length > 0 || (compat.level !== null && compat.level < SERVER_API_LEVEL);
}

export function useServerCompat(): ServerCompat {
  const [compat, setCompat] = useState(currentServerCompat);
  useEffect(() => {
    const update = () => setCompat(currentServerCompat());
    listeners.add(update);
    void readServerCompat().then(update, () => {});
    return () => { listeners.delete(update); };
  }, []);
  return compat;
}

/** null until known. */
export function useServerHas(feature: ServerFeature): boolean | null {
  const compat = useServerCompat();
  const [known, setKnown] = useState(described !== null);
  useEffect(() => { void readServerCompat().then(() => setKnown(true), () => setKnown(true)); }, []);
  if (!known) return null;
  return !compat.missing.includes(feature) && levelHas(compat.level, feature) !== false;
}

/** Tests only. */
export function resetServerCompat(): void {
  reading = null;
  described = null;
  missing.clear();
}
