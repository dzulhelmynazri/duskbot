import { useEffect, useState, type ReactNode } from "react";

import { appVersion } from "@/lib/app-links";
import { t } from "@/lib/i18n";

import type { AppUpdateBridge, AppUpdateState } from "../../electron/app-update.mjs";
import { productName } from "../lib/brand";
import { ItemRow, NavRow } from "./ListRows";

function ownBridge() {
  return window.madaniDesktop?.remoteClient?.active === true ? undefined : window.madaniDesktop?.appUpdate;
}

/**
 * Settings > Version on this app's own page (electron/app-update.mjs). A mac or Windows app that installs its own updates
 * (or a Linux AppImage) checks, downloads and restarts here, and always says how a check went; a source checkout says it is a dev build.
 * Anything else (a .deb, a server's page, the browser) keeps `fallback`, the server's check.
 */
export function AppVersionRow({ fallback, bridge = ownBridge() }: { fallback: ReactNode; bridge?: AppUpdateBridge }) {
  const [update, setUpdate] = useState<AppUpdateState | null>(bridge ? null : { ready: null, mode: "notice" });
  const [asked, setAsked] = useState<"checking" | "done" | null>(null);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let heard = false;
    const unsubscribe = bridge.onState(state => { if (active) { heard = true; setUpdate(state); } });
    void bridge.state().then(state => { if (active && !heard) setUpdate(state); }, () => { if (active && !heard) setUpdate({ ready: null, mode: "notice" }); });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  if (!update) return null;
  if (update.mode === "dev") {
    return <ItemRow data-settings-row="app-version" title={t("appUpdate.devTitle", { app: productName() })} hint={t("appUpdate.devHint")} />;
  }
  if (update.mode !== "self" || !bridge) return <>{fallback}</>;

  const title = `${productName()} ${appVersion()}`;
  const ready = update.ready;
  if (ready) {
    const restart = () => {
      setRestarting(true);
      void bridge.restart().then(ok => { if (!ok) setRestarting(false); }, () => setRestarting(false));
    };
    return <NavRow data-settings-open="app-update" title={title} hint={t("appUpdate.ready", { version: ready })} value={restarting ? t("settings.updates.restartingShort") : t("appUpdate.restart")} drill={false} disabled={restarting} onClick={restart} />;
  }
  if (update.available && (update.progress != null || update.checking)) {
    const percent = update.progress == null ? null : Math.round(update.progress * 100);
    const hint = percent === null ? t("appUpdate.downloading", { version: update.available }) : `${t("appUpdate.downloading", { version: update.available })} · ${t("appUpdate.percent", { percent })}`;
    return <NavRow data-settings-open="app-update" title={title} hint={hint} value={t("common.checking")} drill={false} disabled onClick={() => {}} />;
  }
  const checking = asked === "checking" || update.checking === true;
  const hint = asked === "done" && !checking ? (update.failed ? t("sidebar.update.checkFailed") : t("appUpdate.latest")) : undefined;
  const check = () => {
    setAsked("checking");
    void bridge.download?.().then(() => setAsked("done"), () => setAsked("done"));
  };
  return <NavRow data-settings-open="app-update" title={title} hint={hint} value={checking ? t("common.checking") : t("settings.updates.check")} drill={false} disabled={checking} onClick={check} />;
}
