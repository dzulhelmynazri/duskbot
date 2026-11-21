import { useCallback, useEffect, useState } from "react";
import { egressRouteState, type EgressStatus } from "../../shared/computer-egress";
import { t } from "@/lib/i18n";
import { serverHas } from "@/lib/server-compat";
import { NoteRow, SwitchRow } from "./ListRows";

const POLL_MS = 10_000;

/** Settings > Computer > Your computer: the bot computers' web traffic through the person's own computer. Only on a linked VPS. */
export function RouteTrafficRow({ blockedOnly = false }: { blockedOnly?: boolean } = {}) {
  const [status, setStatus] = useState<EgressStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!(await serverHas("computerEgress"))) return;
    const response = await fetch("/api/computer/egress", { signal, cache: "no-store" });
    if (!response.ok) return;
    setStatus(await response.json() as EgressStatus);
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    const tick = () => void load(abort.signal).catch(() => {});
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [load]);

  if (!status?.available) return null;

  const save = async (change: { enabled: boolean } | { blockedSitesEnabled: boolean }) => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/computer/egress", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!response.ok) throw new Error();
      setStatus(await response.json() as EgressStatus);
    } catch {
      setError(t("routeTraffic.error"));
    } finally {
      setPending(false);
    }
  };

  const inApp = typeof window !== "undefined" && window.madaniDesktop?.remoteClient?.active === true;
  const state = egressRouteState(status);
  const fallback = state === "offline" || state === "slow";
  const hint = state === "off" || state === "unknown" ? t("routeTraffic.hint") : state === "offline" ? t("routeTraffic.offline") : state === "slow" ? t("routeTraffic.slow") : t("routeTraffic.through");
  return (
    <>
      {!blockedOnly && <SwitchRow
        data-settings-row="route-traffic"
        title={inApp ? t("routeTraffic.title") : t("routeTraffic.titleWeb")}
        hint={<span aria-live="polite" className={fallback ? "text-warning" : undefined}>{hint}</span>}
        checked={status.enabled}
        disabled={pending}
        onChange={() => void save({ enabled: !status.enabled })}
      />}
      {typeof status.blockedSitesEnabled === "boolean" && (
        <SwitchRow
          data-settings-row="route-blocked-sites"
          title={inApp ? t("routeTraffic.blockedTitle") : t("routeTraffic.blockedTitleWeb")}
          hint={t("routeTraffic.blockedHint")}
          checked={status.blockedSitesEnabled}
          disabled={pending}
          onChange={() => void save({ blockedSitesEnabled: !status.blockedSitesEnabled })}
        />
      )}
      {error && <NoteRow tone="danger">{error}</NoteRow>}
    </>
  );
}
