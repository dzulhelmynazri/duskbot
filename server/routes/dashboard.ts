import { DASHBOARD_DISCOVERY_PATH, DEFAULT_DASHBOARD_URL } from "../../shared/dashboard-protocol.ts";
import { EnrollRefusedError } from "../dashboard-reporter.ts";
import type { createDashboardReporter } from "../dashboard-reporter.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS } from "./table.ts";
import type { RouteHandler } from "./table.ts";

export interface DashboardRouteDeps {
  reporter: Omit<ReturnType<typeof createDashboardReporter>, "syncChoice">;
  linkAgentBase(): string | null;
  /** the usage-signals switch the desktop app's usage-analytics setting drives */
  usageSignals?: { choice(): { enabled: boolean }; set(next: { enabled: boolean }): void };
  /** called after the person changes the switch, so the account hears of it at once */
  onUsageChoice?(): void;
  /** the usage outbox's waiting notes (usage-signals.ts) */
  usageNotes?: { notes(): object | null; sent(ids: readonly string[]): void };
  /** experience signals for the desktop app to forward (server/experience.ts); taking them removes them */
  experience?: { take(max?: number): object[] };
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}
export function dashboardUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch { return null; }
}
export function createDashboardRoutes(deps: DashboardRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === "/api/dashboard/usage-signals" && deps.usageSignals && (method === "GET" || method === "PUT")) {
      res.setHeader("cache-control", "no-store");
      if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin can change usage signals." });
      if (method === "PUT") {
        const body = await readBody(req) as { enabled?: unknown } | null;
        if (!body || typeof body !== "object" || typeof body.enabled !== "boolean") return json(res, 400, { error: "Expected { enabled: boolean }." });
        deps.usageSignals.set({ enabled: body.enabled });
        deps.onUsageChoice?.();
      }
      return json(res, 200, deps.usageSignals.choice());
    }
    if (path === "/api/dashboard/experience" && deps.experience && method === "GET") {
      res.setHeader("cache-control", "no-store");
      if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin can read experience signals." });
      return json(res, 200, { signals: deps.experience.take() });
    }
    if (path === "/api/dashboard/usage-notes" && deps.usageNotes && (method === "GET" || method === "POST")) {
      res.setHeader("cache-control", "no-store");
      if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin can read usage notes." });
      if (method === "GET") return json(res, 200, { notes: deps.reporter.status().connected ? null : deps.usageNotes.notes() });
      const body = await readBody(req) as { sent?: unknown } | null;
      const ids = body && typeof body === "object" && Array.isArray(body.sent) ? body.sent.filter((id): id is string => typeof id === "string" && id.length <= 64).slice(0, 100) : null;
      if (!ids) return json(res, 400, { error: "Expected { sent: string[] }." });
      deps.usageNotes.sent(ids);
      return json(res, 200, { ok: true });
    }
    if (path !== "/api/dashboard/link" || !["GET", "POST", "DELETE"].includes(method)) return PASS;
    res.setHeader("cache-control", "no-store");
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin can connect the dashboard." });
    if (method === "GET") return json(res, 200, deps.reporter.status());
    if (String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
    if (method === "DELETE") { await deps.reporter.forget(); return json(res, 200, { ok: true }); }
    const body = await readBody(req) as { url?: unknown; enrollToken?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "Expected a JSON object." });
    if (body.enrollToken !== undefined && (typeof body.enrollToken !== "string" || body.enrollToken.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(body.enrollToken))) return json(res, 400, { error: "Invalid enrollment token." });
    // a workspace already linked (by the app after sign-in, say) keeps its dashboard unless another is named
    let selected: unknown = body.url ?? (deps.reporter.status().connected ? deps.reporter.status().url ?? undefined : undefined) ?? (deps.env ?? process.env).MADANI_DASHBOARD_URL;
    if (selected === undefined) {
      const base = deps.linkAgentBase();
      if (base) {
        try {
          const response = await (deps.fetch ?? fetch)(`${base.replace(/\/+$/, "")}${DASHBOARD_DISCOVERY_PATH}`, { signal: AbortSignal.timeout(2000), redirect: "error" });
          if (response.ok) {
            const discovery = await response.json() as { v?: number; url?: unknown };
            if (discovery.v === 1) selected = dashboardUrl(discovery.url) ?? undefined;
          }
        } catch {}
      }
      selected ??= DEFAULT_DASHBOARD_URL;
    }
    const url = dashboardUrl(selected);
    if (!url) return json(res, 400, { error: "Use an https dashboard URL, or localhost http for a fixture." });
    try {
      const answer = await (body.enrollToken === undefined ? deps.reporter.link(url) : deps.reporter.link(url, { enrollToken: body.enrollToken as string }));
      return json(res, 200, { claimUrl: answer.claimUrl, dashboardUrl: answer.dashboardUrl, workspaceId: answer.workspaceId, claimed: answer.claimExpiresAt === 0 });
    } catch (error) {
      // a refusal says why (another account owns this computer, a limit); only a dashboard out of reach is "try again"
      if (error instanceof EnrollRefusedError) return json(res, 409, { error: error.message });
      return json(res, 502, { error: "Could not connect to the dashboard. Try again shortly." });
    }
  };
}
