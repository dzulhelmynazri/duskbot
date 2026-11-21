import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

type AppMenuEntry = { available: boolean; on: boolean };

/** An AppImage's entry in this computer's app menu, which the app adds on its first run; off removes it for good. */
export function AppMenuEntryRow() {
  const bridge = window.madaniDesktop?.appMenuEntry;
  const [state, setState] = useState<AppMenuEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void bridge?.state().then((next) => { if (alive) setState(next); }).catch(() => {});
    return () => { alive = false; };
  }, [bridge]);
  if (!bridge || !state?.available) return null;
  const set = (on: boolean) => {
    setBusy(true); setFailed(false);
    void bridge.set(on).then(setState, () => setFailed(true)).finally(() => setBusy(false));
  };
  return <SettingRow icon="laptop" title={t("settings.appMenuEntry.title")} subtitle={t("settings.appMenuEntry.subtitle")}
    message={failed ? <span role="alert" className="text-danger">{t("settings.appMenuEntry.failed")}</span> : undefined}>
    <Switch checked={state.on} disabled={busy} aria-label={t("settings.appMenuEntry.title")} onClick={() => set(!state.on)} />
  </SettingRow>;
}
