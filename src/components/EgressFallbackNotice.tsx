import { useEffect } from "react";
import { egressRouteState, type EgressStatus } from "../../shared/computer-egress";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { serverHas } from "@/lib/server-compat";

const SEEN_KEY = "madani-egress-fallback-seen";
const POLL_MS = 60_000;

/** Once ever: a quiet note when "Route traffic through this computer" is on and the person's computer is offline. */
export function EgressFallbackNotice() {
  const { dispatch } = useStore();
  useEffect(() => {
    let seen = false;
    try { seen = window.localStorage.getItem(SEEN_KEY) === "1"; } catch { /* storage off: ask every launch */ }
    if (seen) return;
    const abort = new AbortController();
    let timer = 0;
    // a link that is still coming up reads offline for a moment: only a second offline answer in a row says so
    let offlineBefore = false;
    const check = async () => {
      try {
        if (!(await serverHas("computerEgress"))) { window.clearInterval(timer); return; }
        const response = await fetch("/api/computer/egress", { signal: abort.signal, cache: "no-store" });
        if (response.status === 404 || response.status === 403) { window.clearInterval(timer); return; }
        if (!response.ok) return;
        const status = await response.json() as EgressStatus;
        const offline = egressRouteState(status) === "offline";
        const confirmed = offline && offlineBefore;
        offlineBefore = offline;
        if (!confirmed) return;
        try { window.localStorage.setItem(SEEN_KEY, "1"); } catch { /* shown once this launch */ }
        window.clearInterval(timer);
        dispatch({ type: "notice", notice: { kind: "note", botName: null, text: t("routeTraffic.notice") } });
      } catch { /* the next check asks again */ }
    };
    timer = window.setInterval(() => void check(), POLL_MS);
    void check();
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [dispatch]);
  return null;
}
