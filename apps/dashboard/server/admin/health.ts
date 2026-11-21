import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type ErrorKind = "service" | "page";
export function createErrorCounter(now: () => number = Date.now) {
  const times: Record<ErrorKind, number[]> = { service: [], page: [] };
  const totals: Record<ErrorKind, number> = { service: 0, page: 0 };
  return {
    note(kind: ErrorKind) {
      totals[kind]++;
      const list = times[kind];
      list.push(now());
      if (list.length > 5000) list.splice(0, list.length - 5000);
    },
    counts() {
      const time = now(), view = (kind: ErrorKind) => ({ hour: times[kind].filter(t => t > time - 3_600_000).length, day: times[kind].filter(t => t > time - 86_400_000).length, sinceStart: totals[kind] });
      return { service: view("service"), page: view("page") };
    },
  };
}
export type ErrorCounter = ReturnType<typeof createErrorCounter>;

/** the newest entry in the backup folder, by modification time; null when the folder is unset or unreadable */
export function newestBackup(dir: string | null): { at: number; name: string } | null {
  if (!dir) return null;
  try {
    let best: { at: number; name: string } | null = null;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const at = statSync(join(dir, name)).mtimeMs;
      if (!best || at > best.at) best = { at, name };
    }
    return best;
  } catch { return null; }
}

export function spoolCount(dir: string): number {
  try { return readdirSync(dir).filter(name => !name.startsWith(".")).length; } catch { return 0; }
}

/** MADANI_ADMIN_HEALTH_URLS: "name=https://host/path,name2=http://127.0.0.1:3106/" */
export function healthTargets(value: string | undefined): Array<{ name: string; url: string }> {
  return (value ?? "").split(",").map(part => part.trim()).filter(Boolean).flatMap(part => {
    const at = part.indexOf("="), name = part.slice(0, at).trim(), url = part.slice(at + 1).trim();
    try { const parsed = new URL(url); return at > 0 && /^[a-z0-9 _-]{1,40}$/i.test(name) && ["http:", "https:"].includes(parsed.protocol) ? [{ name, url: parsed.href }] : []; } catch { return []; }
  });
}

export async function probe(target: { name: string; url: string }, fetcher: typeof fetch = fetch) {
  const started = performance.now();
  try {
    const res = await fetcher(target.url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(4000) });
    await res.body?.cancel().catch(() => {});
    return { name: target.name, url: target.url, ok: res.status < 500, status: res.status, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { name: target.name, url: target.url, ok: false, status: null, latencyMs: null };
  }
}
