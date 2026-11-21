// GET /v1/ops/fleet (MADANI_OPS_TOKEN): which version every kind of install runs, read only and in counts. Desktops come
// from the opted-in installs' app_open events, madani clouds from this service's own records of their updates, own servers
// from the link service's /ops/fleet (the versions they reported when they last asked for an update).
import type { HomeUpdateState } from "../../../../cloud-service/src/home-update.ts";
import type { StoredEvent } from "../../analytics/sink.ts";

/** one desktop version: installs whose newest app_open in the window named it, and the app_error events it sent */
export interface DesktopVersionRow { version: string; installs: number; errors: number }
export interface CloudVersionRow { version: string; clouds: number; onTrial: number }
/** a canary cloud as the release tool watches it */
export interface CanaryCloud { id: string; version: string | null; trial: "pending" | "passed" | null; rolledBack: string | null; refused: string | null; stuck: boolean }
export interface ServerFleet { windowMs: number; servers: Array<{ version: string; count: number }>; agents: Array<{ version: string; count: number }> }
export interface FleetAnswer {
  at: number;
  desktops: { days: number; versions: DesktopVersionRow[] };
  clouds: { versions: CloudVersionRow[]; canary: CanaryCloud[] };
  /** null when the link service could not be read */
  servers: ServerFleet | null;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const byVersion = (a: { version: string }, b: { version: string }) => {
  const parts = (v: string) => (SEMVER.test(v) ? v.split(".").map(Number) : [-1, -1, -1]);
  const x = parts(a.version), y = parts(b.version);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i]! - x[i]!;
  return 0;
};

/** the desktop rows from raw events (the memory sink, and the shape the database's aggregation returns) */
export function desktopFleetOf(events: readonly StoredEvent[], since: number, until: number): DesktopVersionRow[] {
  const newest = new Map<string, { at: number; version: string }>(), errors = new Map<string, number>();
  for (const e of events) {
    const version = e.ctx?.app?.version;
    if (e.at < since || e.at >= until || typeof version !== "string" || !SEMVER.test(version)) continue;
    if (e.name === "app_error") errors.set(version, (errors.get(version) ?? 0) + 1);
    const install = e.ctx?.install;
    if (e.name === "app_open" && install && (newest.get(install)?.at ?? -1) <= e.at) newest.set(install, { at: e.at, version });
  }
  const installs = new Map<string, number>();
  for (const { version } of newest.values()) installs.set(version, (installs.get(version) ?? 0) + 1);
  return [...new Set([...installs.keys(), ...errors.keys()])].map(version => ({ version, installs: installs.get(version) ?? 0, errors: errors.get(version) ?? 0 })).sort(byVersion);
}

interface CloudLike { id: string; status: string; backend?: unknown; managed?: { update?: HomeUpdateState } | null }

export function cloudFleetOf(clouds: readonly CloudLike[], canaryIds: readonly string[]): FleetAnswer["clouds"] {
  const live = clouds.filter(c => c.managed && c.status !== "destroyed" && c.status !== "destroying");
  const rows = new Map<string, CloudVersionRow>();
  for (const c of live) {
    const guard = c.managed?.update?.guard, version = guard?.current?.version ?? "unknown";
    const row = rows.get(version) ?? rows.set(version, { version, clouds: 0, onTrial: 0 }).get(version)!;
    row.clouds += 1;
    if (guard?.trial) row.onTrial += 1;
  }
  const canary = canaryIds.map((id): CanaryCloud => {
    const u = live.find(c => c.id === id)?.managed?.update;
    const last = u?.guard.last ?? null;
    return { id, version: u?.guard.current?.version ?? null, trial: u?.guard.trial ? u.guard.trial.selfTest : null,
      rolledBack: last?.kind === "rolled_back" ? last.version : null, refused: u?.refused?.split(":")[1] ?? null, stuck: u?.stuck ?? false };
  });
  return { versions: [...rows.values()].sort(byVersion), canary };
}

/** the link service's counts, or null when it is not configured or does not answer */
export async function serverFleet(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<ServerFleet | null> {
  const token = env.MADANI_LINK_STATS_TOKEN;
  if (!token) return null;
  try {
    const answer = await fetchImpl(`${(env.MADANI_LINK_URL || "https://link.madani.bot").replace(/\/$/, "")}/ops/fleet`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!answer.ok) return null;
    const body = await answer.json() as ServerFleet;
    return Array.isArray(body?.servers) && Array.isArray(body?.agents) ? { windowMs: Number(body.windowMs) || 0, servers: body.servers, agents: body.agents } : null;
  } catch {
    return null;
  }
}

export const CANARY_IDS = /^[A-Za-z0-9_-]{1,80}$/;
