import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { NoteRow, SwitchRow } from "./ListRows";

const POLL_MS = 10_000;

/** Settings > Computer > Your computer: the app reaches this linked server straight over its SSH port, relay as fallback. */
export function DirectLinkRow() {
  const bridge = typeof window === "undefined" ? undefined : window.madaniDesktop?.linkDirect;
  const [status, setStatus] = useState<LinkDirectState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!bridge) return;
    setStatus(await bridge.state());
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    const tick = () => void load().catch(() => {});
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [bridge, load]);

  if (!bridge || !status) return null;

  const toggle = async () => {
    setPending(true);
    setError(false);
    try {
      setStatus(await bridge.set(!status.on));
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };

  // which way the app reaches the server now; the cloudflare backup and the cloud relay stay on when the switch is off
  const hint = status.path === "direct" ? t("linkDirect.direct") : status.path === "cloudflare" ? t("linkDirect.cloudflare") : !status.on ? t("linkDirect.off") : t("linkDirect.relay");
  return (
    <>
      <SwitchRow
        data-settings-row="link-direct"
        title={t("linkDirect.title")}
        hint={<span aria-live="polite">{hint}</span>}
        checked={status.on}
        disabled={pending}
        onChange={() => void toggle()}
      />
      {error && <NoteRow tone="danger">{t("routeTraffic.error")}</NoteRow>}
    </>
  );
}
