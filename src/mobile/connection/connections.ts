import { feature } from "@/lib/product-analytics";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MobileConnectionRecord, MobileRelayChannel, MobileTransport } from "../../../shared/mobile-link";
import { usePlatform, type MobilePlatform } from "../platform";
import { deviceChannelKey, type RelaySecrets } from "../transport/link-crypto";
import { withDirect } from "../transport/direct";
import { frameGuard, open as openRelay, RelayGoneError } from "../transport/relay";
import type { PhoneTransport } from "../transport/transport";
import { forgetTranscriptShelf } from "@/state/transcript-cache";
import { outboxKey } from "./active";
import { PairError } from "./pair";
import { RACED_COMPANION_TRY_MS, raceRoutes, routeHeadStart, routeOrder, type RouteOutcome } from "./route-order";
import { asleepAnswer, goneAnswer, wakingAnswer } from "@/lib/cloud-power";

/** `asleep`: the place's edge said its madani cloud sleeps (or is waking). It is still the place: the app opens on it and
 * wakes it, because the edge never wakes a cloud for a read, so asking again could never get past this answer. */
export type WorkspaceTransport = PhoneTransport & { asleep?: true };

/** The place's edge says its madani cloud was deleted: no route will ever reach it again. */
export class PlaceGoneError extends Error {
  constructor() {
    super("this madani cloud was deleted");
    this.name = "PlaceGoneError";
  }
}

export async function connectToWorkspace(record: MobileConnectionRecord, token: string, platform: MobilePlatform, signal: AbortSignal): Promise<WorkspaceTransport> {
  const saved: MobileTransport[] = record.via ?? (record.origin ? [record.transport === "companion"
    ? { kind: "companion", url: record.origin, net: "lan", priority: 0 }
    : { kind: "https", url: record.origin }] : []);
  const routes = record.relayLate && record.relay?.agentPub && !saved.some((route) => route.kind === "relay")
    ? [...saved, { kind: "relay" as const, base: record.relay.base, channel: record.relay.channel, token: "", key: "" }] : saved;
  const ordered = routeOrder(routes, platform.kind);
  let gone = false, refused = false, deleted = false;
  const sleeping: WorkspaceTransport[] = [];
  const close = (transport: PhoneTransport) => { if (transport.kind === "relay") transport.channel.close(); };
  const attempt = async (route: MobileTransport, raced: AbortSignal): Promise<RouteOutcome<PhoneTransport>> => {
    let transport: PhoneTransport | undefined;
    let response: Response;
    try {
      const timed = AbortSignal.any([raced, AbortSignal.timeout(route.kind === "companion" ? RACED_COMPANION_TRY_MS : 15_000)]);
      const headers = { Authorization: `Bearer ${token}` };
      if (route.kind === "relay") {
        const relay = record.relay;
        const saved = await platform.secrets.get(`relay.${record.id}`);
        if (!relay?.agentPub || !saved) return { kind: "failed" };
        const keys = JSON.parse(saved) as RelaySecrets;
        const key = await deviceChannelKey(keys.priv, relay.agentPub, relay.channel);
        raced.throwIfAborted();
        // direct first: a webrtc link to the server takes requests once it is up, the relay stays underneath
        const guard = frameGuard();
        const channel = withDirect(openRelay(relay.base, relay.channel, keys.token, key, guard), { channel: relay.channel, key, guard, lifecycle: platform });
        transport = { kind: "relay", channel, token };
        response = await channel.request("GET", "/api/auth/session", headers, null, timed);
      } else {
        if (route.kind === "companion" && !platform.native) return { kind: "failed" };
        transport = { kind: "bearer", origin: route.url, token };
        response = await fetch(`${route.url}/api/auth/session`, { headers, credentials: "omit", redirect: "error", signal: timed });
      }
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      if (transport) close(transport);
      if (error instanceof RelayGoneError) gone = true;
      return { kind: "failed" };
    }
    // A companion can validate `/api/pair` without exposing the desktop's session endpoint.
    const companionRefused = route.kind === "companion" && [403, 404].includes(response.status);
    if (raced.aborted || (!response.ok && !companionRefused)) {
      close(transport);
      if (raced.aborted) return { kind: "failed" };
      // a computer's companion knows only the phones that paired through it; one paired over the relay is answered there
      if (response.status === 401 && !(route.kind === "companion" && record.relay)) { refused = true; return { kind: "final" }; }
      if (transport.kind !== "relay" && (asleepAnswer(response) || wakingAnswer(response))) sleeping[ordered.indexOf(route)] = { ...transport, asleep: true };
      if (transport.kind !== "relay" && goneAnswer(response)) deleted = true;
      return { kind: "failed" };
    }
    return { kind: "ok", value: transport };
  };
  const result = await raceRoutes(ordered, { headStart: (route) => routeHeadStart(route, routes, platform.kind), attempt, discard: close, signal });
  if ("won" in result) return result.won;
  if (refused) throw new PairError("refused");
  const asleep = sleeping.find(Boolean);
  if (asleep) return asleep;
  if (deleted) throw new PlaceGoneError();
  // the relay dropping this phone's channel is the removal reaching a phone that has no other way to hear of it
  throw new PairError(gone ? "refused" : "unreachable");
}

/** Linking the same installation again keeps what was written while it was unreachable: those sends carry ids the
 * installation has never delivered twice. */
async function moveOutbox(platform: MobilePlatform, from: string, to: string): Promise<void> {
  const held = await platform.prefs.get(outboxKey(from));
  await platform.prefs.remove(outboxKey(from));
  if (!held || await platform.prefs.get(outboxKey(to))) return;
  await platform.prefs.set(outboxKey(to), held);
}

/** The same installation linked again: at the same address, or a madani cloud (https, with its own environment id) that
 * moved to another one, whose old address will never answer again. */
function sameInstallation(a: MobileConnectionRecord, b: MobileConnectionRecord): boolean {
  if (a.environmentId !== b.environmentId) return false;
  if (a.origin === b.origin) return true;
  const ownId = (record: MobileConnectionRecord) => record.environmentId !== record.origin && record.environmentId !== record.relay?.channel;
  return a.transport === "https" && b.transport === "https" && ownId(a) && ownId(b);
}

const CONNECTIONS_KEY = "madani.mobile.connections.v1";
const ACTIVE_KEY = "madani.mobile.active.v1";
type ActiveConnection = { record: MobileConnectionRecord; token: string };
type ConnectionStore = {
  list(): Promise<MobileConnectionRecord[]>;
  active(): Promise<ActiveConnection | null>;
  save(record: MobileConnectionRecord, token: string): Promise<void>;
  setActive(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  touch(id: string): Promise<void>;
  /** `relay`: the phone's own relay channel as the place serves it now */
  setRoutes(id: string, via: MobileTransport[], relay?: MobileRelayChannel): Promise<void>;
  setAccount(id: string, account: { id: string; email: string }): Promise<void>;
};
const stores = new WeakMap<MobilePlatform, ConnectionStore>();

export function createConnectionStore(platform: MobilePlatform): ConnectionStore {
  const existing = stores.get(platform);
  if (existing) return existing;
  let writes = Promise.resolve();
  const serialize = (write: () => Promise<void>) => {
    const next = writes.then(write);
    writes = next.catch(() => {});
    return next;
  };
  const read = async (): Promise<MobileConnectionRecord[]> => {
    const json = await platform.prefs.get(CONNECTIONS_KEY);
    if (!json) return [];
    try {
      const records: unknown = JSON.parse(json);
      return Array.isArray(records) ? records.filter((record): record is MobileConnectionRecord => record && typeof record.id === "string" && typeof record.environmentId === "string" && record.sessionRef === `token.${record.id}`) : [];
    } catch { return []; }
  };
  const write = (records: MobileConnectionRecord[]) => platform.prefs.set(CONNECTIONS_KEY, JSON.stringify(records));
  const store: ConnectionStore = {
    async list() { await writes; return read(); },
    async active() {
      await writes;
      const id = await platform.prefs.get(ACTIVE_KEY);
      const record = (await read()).find((entry) => entry.id === id);
      if (!record) return null;
      const token = await platform.secrets.get(record.sessionRef);
      return token ? { record, token } : null;
    },
    save(record, token) {
      return serialize(async () => {
        const records = await read();
        const replaced = records.filter((entry) => entry.id === record.id || sameInstallation(entry, record));
        const saved = { ...record, sessionRef: `token.${record.id}` };
        await platform.secrets.set(saved.sessionRef, token);
        await write([...records.filter((entry) => !replaced.includes(entry)), saved]);
        await platform.prefs.set(ACTIVE_KEY, saved.id);
        feature("phone_paired");
        for (const old of replaced) if (old.sessionRef !== saved.sessionRef) {
          await platform.secrets.remove(old.sessionRef);
          await platform.secrets.remove(`relay.${old.id}`);
          await platform.prefs.remove(`madani.mobile.push.${old.id}`);
          await moveOutbox(platform, old.id, saved.id);
          // IndexedDB can stall in WKWebView; the saved list never waits on it
          void forgetTranscriptShelf(old.id).catch(() => {});
        }
      });
    },
    setActive(id) {
      return serialize(async () => {
        const records = await read();
        const record = records.find((entry) => entry.id === id);
        if (!record || !await platform.secrets.get(record.sessionRef)) throw new Error("connection unavailable");
        await write(records.map((entry) => entry.id === id ? { ...entry, lastUsedAt: Date.now() } : entry));
        await platform.prefs.set(ACTIVE_KEY, id);
      });
    },
    remove(id) {
      return serialize(async () => {
        const records = await read();
        if (await platform.prefs.get(ACTIVE_KEY) === id) await platform.prefs.remove(ACTIVE_KEY);
        await platform.secrets.remove(`token.${id}`);
        await platform.secrets.remove(`relay.${id}`);
        await platform.prefs.remove(`madani.mobile.push.${id}`);
        await platform.prefs.remove(outboxKey(id));
        void forgetTranscriptShelf(id).catch(() => {});
        await write(records.filter((entry) => entry.id !== id));
      });
    },
    touch(id) {
      return serialize(async () => write((await read()).map((entry) => entry.id === id ? { ...entry, lastUsedAt: Date.now() } : entry)));
    },
    setRoutes(id, via, relay) {
      return serialize(async () => write((await read()).map((entry) => entry.id === id ? { ...entry, via, ...(relay ? { relay, ...(via.some((route) => route.kind === "relay") ? {} : { relayLate: true as const }) } : {}) } : entry)));
    },
    setAccount(id, account) {
      return serialize(async () => write((await read()).map((entry) => entry.id === id ? { ...entry, account: { id: account.id, email: account.email } } : entry)));
    },
  };
  stores.set(platform, store);
  return store;
}

export type ConnectionsApi = {
  connections: MobileConnectionRecord[];
  activeId: string | null;
  /** the saved list has been read once */
  loaded: boolean;
  switchTo(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  refresh(): Promise<void>;
};

export function useConnections(): ConnectionsApi {
  const platform = usePlatform();
  const store = useMemo(() => createConnectionStore(platform), [platform]);
  const [connections, setConnections] = useState<MobileConnectionRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    const records = await store.list();
    const id = await platform.prefs.get(ACTIVE_KEY);
    setConnections(records);
    setActiveId(id);
  }, [platform, store]);
  useEffect(() => { void refresh().catch(() => {}).finally(() => setLoaded(true)); }, [refresh]);
  const switchTo = useCallback(async (id: string) => {
    await store.setActive(id);
    window.location.reload();
  }, [store]);
  const remove = useCallback(async (id: string) => {
    const wasActive = await platform.prefs.get(ACTIVE_KEY) === id;
    await store.remove(id);
    if (wasActive) window.location.reload();
    else await refresh();
  }, [platform, store, refresh]);
  return { connections, activeId, loaded, switchTo, remove, refresh };
}
