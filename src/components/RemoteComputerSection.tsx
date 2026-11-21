import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { t } from "@/lib/i18n";
import { Card as RowsCard, FormDialog, FormField, ItemRow, NavRow, NoteRow } from "./ListRows";
import { textFieldCls } from "./ui/GrokDialog";

function errorText(error: unknown): string {
  return String((error as { message?: string })?.message ?? error).replace(
    /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    "",
  );
}

export function isServerPairingLink(input: string): boolean {
  const link = input.trim();
  if (!/^https:\/\//i.test(link) || /[\s\\]/.test(link)) return false;
  try {
    const url = new URL(link);
    const code = /(?:^|[#&])code=([^&]+)/.exec(url.hash)?.[1];
    return url.protocol === "https:" && !url.username && !url.password && !url.search
      && (url.pathname === "/pair" || url.pathname === "/pair/")
      && Boolean(code && decodeURIComponent(code).trim());
  } catch {
    return false;
  }
}

/** Pairing this desktop with another desktop app as its client: one row that opens a small form for the other app's
 * address and six-digit code, or, once paired, the computer it is on and Disconnect. A server is connected from Your
 * servers on the same page. */
export function RemoteComputerSection({ hideWhenUnavailable = false, simple = false }: { hideWhenUnavailable?: boolean; /** one unlabelled row named for what it does */ simple?: boolean }) {
  const bridge = window.madaniDesktop?.remoteClient;
  const [state, setState] = useState<DesktopRemoteClientState>({ active: bridge?.active === true });
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  const aliveRef = useRef(true);
  const refreshState = useCallback(() => {
    // The bridge's own snapshot is the truth: re-read it after every transition rather than trusting the action's
    // return value.
    void bridge?.state().then((next) => {
      if (aliveRef.current) setState(next);
    }).catch(() => {});
  }, [bridge]);

  useEffect(() => {
    aliveRef.current = true;
    refreshState();
    return () => {
      aliveRef.current = false;
    };
  }, [refreshState]);

  const run = async (action: () => Promise<unknown>) => {
    if (pending.current || !bridge) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      refreshState();
      setOpen(false);
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (!bridge) {
    if (hideWhenUnavailable) return null;
    return <RowsCard label={t("remote.client.idle")}><NoteRow>{t("remote.client.desktopOnly")}</NoteRow></RowsCard>;
  }

  if (state.active) {
    return (
      <RowsCard label={t("remote.client.active")} data-settings-block="remote-client">
        <ItemRow title={t("remote.client.connected", { name: state.serverName || t("remote.client.fallbackName") })} hint={state.endpoint}>
          <button type="button" className="ui-button" disabled={busy} onClick={() => void run(() => bridge.disconnect())}>{t("remote.client.disconnect")}</button>
        </ItemRow>
        {error && <NoteRow tone="danger">{error}</NoteRow>}
      </RowsCard>
    );
  }

  return (
    <RowsCard label={simple ? undefined : t("remote.client.idle")} data-settings-block="remote-client">
      <NavRow data-settings-open="companion-pair" title={t(simple ? "remote.client.idle" : "settings.s2.remote.pair")} hint={t(simple ? "settings.elsewhere.connectHint" : "settings.s2.remote.pairHint")} onClick={() => { setError(""); setOpen(true); }} />
      <AnimatePresence>{open && (
        <FormDialog key="companion-pair"
          data-panel-modal="companion-pair"
          title={t(simple ? "remote.client.idle" : "settings.s2.remote.pair")}
          description={t("remote.client.restartNote")}
          saveLabel={t("remote.client.pair")}
          canSave={endpoint.trim() !== "" && code.length === 6}
          busy={busy}
          error={error || undefined}
          onSave={() => run(() => bridge.pair(endpoint, code))}
          onClose={() => setOpen(false)}
        >
          <FormField label={t("remote.client.companion.address")}>
            <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} disabled={busy}
              placeholder="computer.tailnet.ts.net" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={textFieldCls} />
          </FormField>
          <FormField label={t("remote.client.companion.code")}>
            <input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} disabled={busy}
              placeholder="000000" inputMode="numeric" autoComplete="one-time-code" className={`${textFieldCls} max-w-32 font-mono tracking-[0.2em]`} />
          </FormField>
        </FormDialog>
      )}</AnimatePresence>
    </RowsCard>
  );
}
