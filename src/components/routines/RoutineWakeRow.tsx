import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { Card, SwitchRow } from "../ListRows";

/** While a Mac sleeps no schedule runs: the shell can hold it awake the hour before one is due, plugged in only. */
export function RoutineWakeRow() {
  const bridge = typeof window !== "undefined" ? window.madaniDesktop?.routines : undefined;
  const [state, setState] = useState<DesktopRoutineWake | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const load = () => bridge.wakeState().then((next) => { if (!cancelled) setState(next); }).catch(() => {});
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [bridge]);
  if (!bridge || !state) return null;
  return (
    <Card data-settings-block="routine-wake">
      <SwitchRow
        title={t("automations.wake")}
        hint={state.keepAwake && state.onBattery ? t("automations.wakeBattery") : undefined}
        checked={state.keepAwake}
        disabled={busy}
        onChange={() => {
          setBusy(true);
          bridge.keepAwake(!state.keepAwake).then(setState).catch(() => {}).finally(() => setBusy(false));
        }}
      />
    </Card>
  );
}
