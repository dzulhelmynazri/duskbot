import { cloudPlanSnapshot, UPGRADE_SOURCES } from "./cloud-account.mjs";

/** the account website pages a page of the app may open signed in (cloud-account.mjs HANDOFF_PAGES, less checkout) */
export const ACCOUNT_PAGES = Object.freeze(["home", "workspace", "cloud", "billing", "account", "usage"]);

/** Another Cloud of the person's own, as its page may see its plan: its tier and whether it runs, from the session's list. */
export function otherCloudSnapshot(cloud) {
  const runs = ["ready", "setting_up", "offline"].includes(cloud.status);
  return { status: runs ? "paid" : "attention", ...(cloud.tier ? { tier: cloud.tier } : {}) };
}

// Security: an upgrade goes only to a plan the verified session lists, and only with the confirmation main kept from its
// own preview; a page never holds it. Upgrading is My Cloud's alone: another Cloud of the person's (`otherCloud(event)`,
// its page) reads its own plan, never My Cloud's.
/** after a phone sign-in code passed the person's presence check, its silent renewals skip it this long */
export const PHONE_SIGN_IN_RENEW_MS = 75 * 60_000;

// Security: a phone sign-in code logs a phone in to the account, so a page only gets one after main's own presence check
// (Touch ID or the confirm), never on the page's word; only the renewals of a screen already checked skip it, for an hour or so.
export function installCloudPlanIpc({ ipcMain, pageSender, account, client, notices, homePage, otherCloud = () => null, presence = async () => false, now = Date.now }) {
  let phoneCheckedUntil = 0;
  ipcMain.handle("cloud-plan:phone-sign-in", (event, renew) => pageSender("cloud-plan:phone-sign-in", async () => {
    if (!(renew === true && now() < phoneCheckedUntil)) {
      if (!(await presence())) return { outcome: "canceled" };
      phoneCheckedUntil = now() + PHONE_SIGN_IN_RENEW_MS;
    }
    return client().phoneSignIn();
  })(event));
  // whether this computer is signed in to a madani bot account: the phone panel shows its QR only then
  ipcMain.handle("cloud-plan:signed-in", pageSender("cloud-plan:signed-in", () => client().state()?.status === "connected"));
  ipcMain.handle("cloud-plan:state", event => {
    const other = otherCloud(event);
    if (other) return { ...otherCloudSnapshot(other), ...(homePage(event) ? { home: true } : {}) };
    return pageSender("cloud-plan:state", () => {
      const state = account()?.state();
      return { ...cloudPlanSnapshot(state, { notice: notices().due(state) }), ...(homePage(event) ? { home: true } : {}) };
    })(event);
  });
  ipcMain.handle("cloud-plan:notice-seen", pageSender("cloud-plan:notice-seen", () => { notices().seen(account()?.state()); }));
  ipcMain.handle("cloud-plan:manage", event => (otherCloud(event) ? client().openDashboard().then(() => {}) : pageSender("cloud-plan:manage", async () => { await client().openDashboard(); })(event)));
  ipcMain.handle("cloud-plan:open-page", (event, page, workspaceId) => {
    if (!ACCOUNT_PAGES.includes(page)) throw new Error("Unknown account page.");
    const open = () => client().webHandoff({ page, ...(page === "workspace" ? { workspaceId: String(workspaceId) } : {}) });
    return otherCloud(event) ? open() : pageSender("cloud-plan:open-page", open)(event);
  });
  const upgradeArgs = (plan, source) => {
    const offered = client().state().usage?.upgrades ?? [];
    if (typeof plan !== "string" || !UPGRADE_SOURCES.includes(source) || !offered.some(entry => entry.tier === plan)) throw new Error("Choose a plan to move to.");
    return [plan, source];
  };
  ipcMain.handle("cloud-plan:upgrade-preview", (event, plan, source) => pageSender("cloud-plan:upgrade-preview", () => client().upgradePreview(...upgradeArgs(plan, source)))(event));
  ipcMain.handle("cloud-plan:upgrade", (event, plan, source) => pageSender("cloud-plan:upgrade", () => client().upgrade(...upgradeArgs(plan, source)))(event));
  // Cancel trial / Cancel plan and Keep my plan: the page's survey is checked in main, and the Cloud is the session's own.
  ipcMain.handle("cloud-plan:cancel", (event, survey) => pageSender("cloud-plan:cancel", () => client().cancelPlan(survey))(event));
  ipcMain.handle("cloud-plan:keep", pageSender("cloud-plan:keep", () => client().keepPlan()));
  // The room card (the session's `room`): Not now, and Restart now after its upgrade; both for the session's own Cloud.
  ipcMain.handle("cloud-plan:room-not-now", (event, id) => pageSender("cloud-plan:room-not-now", () => client().roomNotNow(typeof id === "string" ? id.slice(0, 64) : ""))(event));
  ipcMain.handle("cloud-plan:restart-now", pageSender("cloud-plan:restart-now", () => client().restartNow()));
}
