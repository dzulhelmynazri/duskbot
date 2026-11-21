import { api } from "@/state/api";
import type { MobilePlatform } from "../platform";

const enrolling = new WeakMap<MobilePlatform, Set<string>>();

export async function enrollWorkspace(platform: MobilePlatform, connectionId: string, accountId: string,
  enrollGrant: () => Promise<{ enrollToken: string; dashboardUrl: string } | null>): Promise<void> {
  const key = `madani.account.enrolled.${connectionId}`;
  const running = enrolling.get(platform) ?? new Set<string>();
  enrolling.set(platform, running);
  if (running.has(key)) return;
  running.add(key);
  try {
    // Security invariant: enrolling with a grant makes its account the workspace's owner, so a phone signed in to
    // another account never moves a workspace it already enrolled; its owner does that from their own account.
    if (await platform.prefs.get(key)) return;
    const grant = await enrollGrant();
    if (!grant) throw new Error("Enrollment unavailable");
    await api("/api/dashboard/link", { method: "POST", body: JSON.stringify({ url: grant.dashboardUrl, enrollToken: grant.enrollToken }) });
    await platform.prefs.set(key, accountId);
  } catch { console.warn("Account workspace enrollment failed"); }
  finally { running.delete(key); }
}
