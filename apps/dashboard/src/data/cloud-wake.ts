import { useSyncExternalStore } from "react";
import type { WorkspaceDetail } from "../../../../shared/dashboard-protocol";
import { api } from "../lib/api";
import type { CloudDesktop } from "./contracts";

const WAKE_WAIT_MS = 90_000;
const WAKE_POLL_MS = 1_500;
/** a cloud that answered this recently is taken as awake, so the next action goes at once */
const AWAKE_FOR_MS = 5 * 60_000;
const READY_SHOWN_MS = 4_000;

export interface WakeDeps {
  workspace(id: string): Promise<WorkspaceDetail>;
  power(cloudId: string, on: boolean): Promise<unknown>;
  now(): number;
  sleep(ms: number): Promise<void>;
}
const browserDeps: WakeDeps = {
  workspace: (id) => api.workspace(id), power: api.power, now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** wakes a madani cloud we put to sleep and resolves once it reports again */
export async function wokenUp(cloud: Pick<CloudDesktop, "id">, workspaceId: string, deps: WakeDeps): Promise<boolean> {
  const before = (await deps.workspace(workspaceId).catch(() => null))?.workspace.lastReportAt ?? 0;
  await deps.power(cloud.id, true).catch(() => {});
  const until = deps.now() + WAKE_WAIT_MS;
  while (deps.now() < until) {
    await deps.sleep(WAKE_POLL_MS);
    const detail = await deps.workspace(workspaceId).catch(() => null);
    if (detail?.workspace.freshness === "live" && (detail.workspace.lastReportAt ?? 0) > before) return true;
  }
  return false;
}

/** what the person asked for while the cloud slept; offered as a button once it is awake, so a tab opens inside that click */
export interface PendingAction { key: string; label: string; run(): void; cancel(): void }
export interface Wake {
  cloudId: string;
  name: string;
  startedAt: number;
  phase: "waking" | "ready";
  pending: PendingAction[];
  hidden: boolean;
}

interface State { wakes: Record<string, Wake>; asking: { cloudId: string; key: string } | null }
const store = { state: { wakes: {}, asking: null } as State, listeners: new Set<() => void>() };
const set = (next: Partial<State>) => { store.state = { ...store.state, ...next }; store.listeners.forEach((fn) => fn()); };
const put = (cloudId: string, change: Partial<Wake> | null) => {
  const { [cloudId]: old, ...rest } = store.state.wakes;
  set({ wakes: change === null || !old ? rest : { ...rest, [cloudId]: { ...old, ...change } } });
};
const running = new Map<string, Promise<boolean>>();
const awakeAt = new Map<string, number>();

export const isAwake = (cloudId: string, now = Date.now()) => now - (awakeAt.get(cloudId) ?? -Infinity) < AWAKE_FOR_MS;

/** one wake per cloud, however many actions wait on it; the corner pill follows it. `pending` asks first, in a small dialog */
export function wakeCloud(cloud: Pick<CloudDesktop, "id" | "workspaceId">, name: string, opts: { pending?: PendingAction; deps?: WakeDeps } = {}): Promise<boolean> {
  const deps = opts.deps ?? browserDeps;
  const { pending } = opts;
  if (isAwake(cloud.id, deps.now())) return Promise.resolve(true);
  const wake = store.state.wakes[cloud.id];
  if (wake) put(cloud.id, { hidden: false, pending: pending ? [...wake.pending.filter((p) => p.key !== pending.key), pending] : wake.pending });
  else set({ wakes: { ...store.state.wakes, [cloud.id]: { cloudId: cloud.id, name, startedAt: deps.now(), phase: "waking", pending: pending ? [pending] : [], hidden: false } } });
  if (pending) set({ asking: { cloudId: cloud.id, key: pending.key } });
  const already = running.get(cloud.id);
  if (already) return already;
  const job = (cloud.workspaceId ? wokenUp(cloud, cloud.workspaceId, deps) : Promise.resolve(false)).then((ok) => {
    running.delete(cloud.id);
    if (store.state.asking?.cloudId === cloud.id) set({ asking: null });
    if (!ok) { put(cloud.id, null); return false; }
    awakeAt.set(cloud.id, deps.now());
    const now = store.state.wakes[cloud.id];
    if (!now) return true;
    put(cloud.id, { phase: "ready" });
    if (!now.pending.length) setTimeout(() => { if (!store.state.wakes[cloud.id]?.pending.length) put(cloud.id, null); }, READY_SHOWN_MS);
    return true;
  });
  running.set(cloud.id, job);
  return job;
}

/** the pending action leaves the pill: it ran from elsewhere, or the person called it off */
export function dropPending(key: string) {
  for (const wake of Object.values(store.state.wakes)) {
    if (!wake.pending.some((p) => p.key === key)) continue;
    const pending = wake.pending.filter((p) => p.key !== key);
    if (wake.phase === "ready" && !pending.length) put(wake.cloudId, null);
    else put(wake.cloudId, { pending });
  }
  if (store.state.asking?.key === key) set({ asking: null });
}

export const wakeActions = {
  /** runs a pending action inside the click that asked for it */
  run(cloudId: string, key: string) {
    const action = store.state.wakes[cloudId]?.pending.find((p) => p.key === key);
    dropPending(key);
    action?.run();
  },
  cancel(key: string) {
    const action = Object.values(store.state.wakes).flatMap((w) => w.pending).find((p) => p.key === key);
    dropPending(key);
    action?.cancel();
    for (const wake of Object.values(store.state.wakes)) if (wake.phase === "waking" && !wake.pending.length) put(wake.cloudId, { hidden: true });
  },
  closeAsk: () => set({ asking: null }),
  hide: (cloudId: string) => {
    const wake = store.state.wakes[cloudId];
    if (wake?.phase === "ready") { wake.pending.forEach((p) => p.cancel()); put(cloudId, null); }
    else put(cloudId, { hidden: true });
  },
};

export const useWakes = () => useSyncExternalStore((fn) => { store.listeners.add(fn); return () => void store.listeners.delete(fn); }, () => store.state, () => store.state);

/** for tests */
export const wakeState = () => store.state;
export const resetWakes = () => { running.clear(); awakeAt.clear(); set({ wakes: {}, asking: null }); };
