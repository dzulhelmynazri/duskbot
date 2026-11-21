import { DEFAULT_DASHBOARD_URL } from "../../shared/dashboard-protocol";
import { api } from "@/state/api";
import { openExternalLink } from "./app-links";

interface LinkAnswer { claimUrl: string; dashboardUrl: string; workspaceId: string; claimed: boolean }

/** where the account dashboard opens for the server this window shows: its one-time claim link the first time, the
 * workspace's page after that. the server enrolls itself (POST /api/dashboard/link), so a Mac, a VPS seen through the
 * link and a phone all connect the same way. */
async function dashboardLink(): Promise<LinkAnswer | null> {
  try {
    return await api<LinkAnswer>("/api/dashboard/link", { method: "POST", body: "{}", timeoutMs: 15_000 });
  } catch (error) {
    // an older server or one that cannot reach the service still gets the person to their dashboard
    console.warn("account dashboard link failed", error instanceof Error ? error.message : error);
    return null;
  }
}

const linkUrl = (link: LinkAnswer | null) => !link ? DEFAULT_DASHBOARD_URL
  : link.claimed ? `${link.dashboardUrl}/?workspace=${encodeURIComponent(link.workspaceId)}` : link.claimUrl;

export async function accountDashboardUrl(): Promise<string> {
  return linkUrl(await dashboardLink());
}

/** the desktop app signed in to the account opens the workspace's page already signed in (a one-time handoff link), so
 * the browser never asks for a second sign-in; anywhere else, the claim link or the workspace's page */
export async function openAccountDashboard(): Promise<void> {
  const desktop = window.madaniDesktop?.remoteClient?.active ? undefined : window.madaniDesktop;
  // this computer's own window, or a cloud of the account seen in the app
  const openPage = desktop?.cloudAccount?.openPage ?? desktop?.cloudPlan?.openPage;
  const link = await dashboardLink();
  if (openPage && (!link || link.claimed)) {
    const opened = await openPage(link ? "workspace" : "home", link?.workspaceId).catch(() => null);
    if (opened && "opened" in opened && opened.opened) return;
  }
  await openExternalLink(linkUrl(link));
}
