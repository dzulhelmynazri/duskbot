import { ModalLayer } from "./ui/ModalLayer";
import { useEffect, useState } from "react";
import { X } from "../icons";
import { t } from "@/lib/i18n";
import { stopWaitingInBrowser, useWaitingInBrowser } from "@/lib/account-intent";
import { signedInNow } from "@/lib/sign-in-sheet";

/** The one calm state while an account step goes on in the browser: what to do there, Open again and Cancel. It closes
 *  by itself when the app is signed in (the person may finish in the browser and never come back here). */
export function ContinueInBrowserSheet({ kind, onClose }: { kind: "signin" | "upgrade" | "billing"; onClose: () => void }) {
  const bridge = window.madaniDesktop?.cloudAccount;
  const [busy, setBusy] = useState(false);
  return <ModalLayer><div className="ui-scrim fixed inset-0 z-[70] flex items-center justify-center p-4">
    <div role="dialog" aria-modal="true" aria-labelledby="continue-browser-title" data-continue-in-browser={kind} className="relative w-full max-w-[400px] rounded-[20px] bg-app p-7 shadow-xl">
      <button type="button" onClick={onClose} aria-label={t("accounts.close")} className="absolute end-4 top-4 grid size-8 place-items-center rounded-full text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"><X size={16} /></button>
      <h2 id="continue-browser-title" className="m-0 text-[17px] font-medium leading-6 text-ink">{t("continueBrowser.title")}</h2>
      <p className="mt-2 text-[14px] leading-5 text-ink-secondary">{t(kind === "upgrade" ? "continueBrowser.upgrade" : kind === "billing" ? "continueBrowser.billing" : "continueBrowser.signin")}</p>
      <p className="mt-2 text-[13px] leading-[18px] text-ink-tertiary">{t("continueBrowser.note")}</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" data-continue-open="" className="ui-button ui-button-primary" disabled={busy} onClick={() => { setBusy(true); void bridge?.reopen().finally(() => setBusy(false)); }}>{t("continueBrowser.open")}</button>
        <button type="button" data-continue-cancel="" className="ui-button" disabled={busy} onClick={() => { void bridge?.cancel().catch(() => {}); onClose(); }}>{t("continueBrowser.cancel")}</button>
      </div>
    </div>
  </div></ModalLayer>;
}

/** Mounted once on the app's page: shows the sheet while the app waits on the browser, and goes on once signed in. */
export function SignInSheetHost() {
  const waiting = useWaitingInBrowser();
  const bridge = window.madaniDesktop?.cloudAccount;
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    if (!waiting || !bridge) return;
    let alive = true;
    const look = (status: string | undefined, signedIn: boolean) => {
      if (!alive) return;
      if (signedIn) { stopWaitingInBrowser(); signedInNow(); return; }
      setConnecting(status === "connecting");
      if (status !== "connecting") stopWaitingInBrowser();
    };
    void bridge.state().then((state) => look(state.status, Boolean(state.account) && state.status === "connected"), () => {});
    const off = bridge.onState((state) => look(state.status, Boolean(state.account) && state.status === "connected"));
    return () => { alive = false; off(); };
  }, [waiting, bridge]);
  if (!waiting || !connecting) return null;
  return <ContinueInBrowserSheet kind={waiting.kind} onClose={stopWaitingInBrowser} />;
}
