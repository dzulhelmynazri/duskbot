import { appSlug } from "../shared/dashboard-protocol.ts";
import type { AppsReport, AppsReportService } from "../shared/dashboard-protocol.ts";
import * as composio from "./composio.ts";
import { COMPOSIO_CONNECT_URL } from "./composio-connect.ts";
import type { AppConfig } from "./config.ts";

export type AppsSource = Pick<typeof composio, "connectorAvailability" | "connectedServicesInventory">;

export interface McpServerSeen { name: string; enabled: boolean; url?: string; auth?: string; bot?: string }

const GMAIL_ADDRESS = /@(gmail|googlemail)\.com$/i;
const composioConnectHost = new URL(COMPOSIO_CONNECT_URL).host;
const viaComposioConnect = (url: string | undefined) => { try { return url !== undefined && new URL(url).host === composioConnectHost; } catch { return false; } };

/** the apps connected in the app itself rather than through Composio: MCP servers (remote apps, token apps, custom
 *  servers, named `linear`, `linear-2`… per account) and a Gmail mailbox; a server waiting on its sign-in is pending */
export function connectedInApp(servers: readonly McpServerSeen[], mailboxes: readonly string[] = []): AppsReportService[] {
  const found = new Map<string, AppsReportService>();
  const add = (slug: string | null, connected: boolean) => {
    if (!slug) return;
    const known = found.get(slug);
    found.set(slug, { slug, connected: connected || known?.connected === true, pending: !connected && !known?.connected, via: "app" });
  };
  for (const server of servers) {
    if (!server.enabled || server.bot || viaComposioConnect(server.url)) continue;
    add(appSlug(server.name.replace(/-\d+$/, "")), server.auth !== "needs-sign-in");
  }
  if (mailboxes.some((address) => GMAIL_ADDRESS.test(address))) add("gmail", true);
  return [...found.values()];
}

/** `connect`: apps connected through Composio Connect where there is no key or broker, a desktop by default or a madani
 *  cloud (cloud-composio-connect.ts), null when it is not signed in. `inApp`: connectedInApp's list, reported beside
 *  Composio's whether or not Composio is set up, so the account's page shows every app the bots can use */
export async function dashboardApps(cfg: AppConfig, source: AppsSource = composio,
  connect?: () => Promise<Array<{ slug: string; connected: boolean; pending: boolean }> | null>, inApp: () => AppsReportService[] = () => []): Promise<AppsReport> {
  const own = (() => { try { return inApp(); } catch { return []; } })();
  const merged = (services: AppsReportService[]) => {
    const composioSlugs = new Set(services.map((service) => service.slug));
    return [...services, ...own.filter((service) => !composioSlugs.has(service.slug))].slice(0, 500);
  };
  if (source.connectorAvailability(cfg) !== "configured") {
    const viaConnect = await connect?.().catch(() => null);
    return viaConnect ? { available: true, complete: true, services: merged(viaConnect) } : { available: false, complete: true, services: merged([]) };
  }
  const inventory = await source.connectedServicesInventory(cfg);
  const services = Object.entries(inventory.services).flatMap(([slug, state]) => {
    const id = appSlug(slug);
    return id && (state.connected || state.pending) ? [{ slug: id, connected: state.connected, pending: state.pending }] : [];
  });
  return { available: true, complete: inventory.complete, services: merged(services) };
}
