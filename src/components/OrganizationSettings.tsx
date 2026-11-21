import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import type { ManagedDesktopState } from "../../electron/managed-desktop.mjs";
import { activeLocale, t } from "@/lib/i18n";
import { Card as RowsCard, CopyRow, FormDialog, FormField, ItemRow, NavRow, NoteRow } from "./ListRows";
import { textFieldCls } from "./ui/GrokDialog";
import { CompanyModels } from "./CompanyModels";

const providerNames: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };
const DEFAULT_PORTAL_ORIGIN = "https://madani.bot";

/** Security: only the trusted desktop bridge can enroll this computer or hold its token. */
export function OrganizationSettings() {
  const bridge = window.madaniDesktop?.remoteClient?.active ? undefined : window.madaniDesktop?.organization;
  const [connection, setConnection] = useState<ManagedDesktopState | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [dialog, setDialog] = useState<"custom" | "security" | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const revision = useRef(0);
  const status = useRef<ManagedDesktopState["status"] | undefined>(undefined);

  const acceptConnection = (next: ManagedDesktopState) => {
    const changed = status.current !== next.status;
    status.current = next.status;
    setConnection(next);
    // Outside React's state updater: updaters must stay pure and can run during rendering.
    if (changed) setError("");
    if (next.status !== "connected" && next.status !== "reauth-required") setConfirmDisconnect(false);
  };

  useEffect(() => {
    // Acknowledges only the rendered destination, never enrollment.
    void bridge?.settingsOpened?.().catch(() => {});
    const current = ++generation.current;
    const initialRevision = revision.current;
    const receive = (next: ManagedDesktopState) => {
      if (generation.current !== current) return;
      revision.current++;
      acceptConnection(next);
    };
    const unsubscribe = bridge?.onState(receive);
    void bridge?.state().then((next) => {
      // A push can arrive while the initial snapshot is in flight.
      if (revision.current === initialRevision) receive(next);
    }).catch(() => {
      if (generation.current === current && revision.current === initialRevision) setError(t("organization.loadFailed"));
    });
    return () => { generation.current++; unsubscribe?.(); };
  }, [bridge]);

  const perform = async (action: () => Promise<ManagedDesktopState>) => {
    if (!bridge || pending.current) return;
    pending.current = true;
    setBusy(true); setError("");
    const current = generation.current;
    const startedRevision = revision.current;
    try {
      const next = await action();
      if (generation.current === current && revision.current === startedRevision) {
        acceptConnection(next);
      }
    } catch {
      // IPC exceptions can contain internal paths; display only product copy.
      if (generation.current === current && revision.current === startedRevision) setError(t("organization.actionFailed"));
    } finally {
      pending.current = false;
      if (generation.current === current) setBusy(false);
    }
  };

  if (!bridge) return <RowsCard><NoteRow>{t("organization.desktopOnly")}</NoteRow></RowsCard>;
  const enrolled = connection?.status === "connected" || connection?.status === "reauth-required" || connection?.status === "unavailable" || connection?.status === "license-expired";
  const licenseExpired = connection?.status === "license-expired" || connection?.notice === "license-expired";
  const expiry = connection?.enrollment?.expiresAt ?? connection?.expiresAt;
  const date = typeof expiry === "number" && Number.isFinite(expiry) ? new Date(expiry) : null;
  const dateLabel = date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short" }).format(date) : null;
  const models = connection?.providers?.filter((provider) => provider.configured && provider.models.length > 0) ?? [];
  return <>
    <RowsCard label={t("settings.section.organization")} footnote={<>{t("organization.additive")} {t("organization.privacy")}</>} data-settings-block="organization-connection">
      {!connection && <ItemRow title={<span role="status">{error || t("organization.loading")}</span>}>
        <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.refresh())}>{t("organization.refresh")}</button>
      </ItemRow>}
      {connection?.message && <NoteRow><span role="status">{connection.message}</span></NoteRow>}
      {licenseExpired && <NoteRow tone="warn">{t("organization.licenseExpired")}</NoteRow>}
      {connection?.status === "signed-out" && <>
        <ItemRow title={t("settings.section.organization")} hint={t("organization.signInHelp")}>
          <button type="button" disabled={busy} className="ui-button ui-button-primary" onClick={() => void perform(() => bridge.begin({ portalOrigin: DEFAULT_PORTAL_ORIGIN }))}>{busy ? t("organization.working") : t("organization.signIn")}</button>
        </ItemRow>
        <NavRow data-settings-open="organization-custom" title={t("organization.advanced")} hint={t("settings.s2.org.customHint")} value={DEFAULT_PORTAL_ORIGIN} onClick={() => setDialog("custom")} />
      </>}
      {connection?.status === "connecting" && <>
        <ItemRow title={<span role="status">{t("organization.browserConsent")}</span>}>
          {connection.enrollment && bridge.reopen && <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.reopen!())}>{t("organization.reopen")}</button>}
          <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.cancelEnrollment())}>{t("organization.cancel")}</button>
        </ItemRow>
        {connection.enrollment && <NavRow data-settings-open="organization-security" title={t("organization.securityDetails")} hint={t("settings.s2.org.securityHint")} onClick={() => setDialog("security")} />}
      </>}
      {enrolled && <>
        <ItemRow title={<span className="flex min-w-0 items-center gap-2">{connection.branding?.logo && <img src={connection.branding.logo} alt="Organization logo" className="size-5 shrink-0 rounded object-contain" />}<span className="break-words">{connection.organization?.name}</span></span>}
          hint={<span className="break-all">{connection.email}</span>}>
          {!confirmDisconnect && connection.status !== "reauth-required" && <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.refresh())}>{t("organization.refresh")}</button>}
          {!confirmDisconnect && <button type="button" disabled={busy} className="ui-button" onClick={() => setConfirmDisconnect(true)}>{t("organization.disconnect")}</button>}
        </ItemRow>
        {confirmDisconnect && <div role="group" aria-label={t("organization.disconnectTitle")} className="contents">
          <ItemRow title={t("organization.disconnectTitle")} hint={t("organization.disconnectWarning")}>
            <button type="button" autoFocus disabled={busy} className="ui-button" onClick={() => setConfirmDisconnect(false)}>{t("organization.keepConnection")}</button>
            <button type="button" disabled={busy} className="ui-button ui-button-danger" onClick={() => void perform(() => bridge.disconnect())}>{t("organization.disconnectConfirm")}</button>
          </ItemRow>
        </div>}
        {connection.status === "reauth-required" ? <NoteRow tone="warn">{t("organization.reauth")}</NoteRow> : connection.status === "license-expired" ? <>
          {models.map((provider) => <ItemRow key={provider.id} title={providerNames[provider.id] ?? provider.id} value={t("organization.companyModelsUnavailable")} />)}
        </> : connection.status === "connected" ? <>
          <NoteRow>{t("organization.modelHelp")}</NoteRow>
          {models.length > 0 ? <div className="px-2 py-1.5 text-[13px] leading-[18px]"><CompanyModels providers={connection.providers!} /></div> : <NoteRow>{t("organization.noModels")}</NoteRow>}
        </> : null}
      </>}
      {connection?.status === "unavailable" && <NoteRow><span role="status">{t("organization.unavailable")}</span></NoteRow>}
      {dateLabel && <NoteRow>{t("organization.expires", { date: dateLabel })}</NoteRow>}
      {error && connection && <NoteRow tone="danger">{error}</NoteRow>}
    </RowsCard>
    <AnimatePresence>{dialog === "custom" && connection?.status === "signed-out" && <FormDialog key="organization-custom" data-panel-modal="organization-custom" title={t("organization.advanced")} description={t("organization.advancedHelp")}
      saveLabel={t("organization.customSignIn")} canSave={Boolean(address.trim())} busy={busy}
      onSave={async () => { if (address.trim()) { await perform(() => bridge.begin({ portalOrigin: address.trim() })); setDialog(null); } }}
      onClose={() => setDialog(null)}>
      <FormField label={t("organization.address")}>
        <input type="url" required value={address} disabled={busy} onChange={(event) => setAddress(event.target.value)}
          placeholder={DEFAULT_PORTAL_ORIGIN} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} maxLength={2048} className={textFieldCls} />
      </FormField>
    </FormDialog>}</AnimatePresence>
    <AnimatePresence>{dialog === "security" && connection?.status === "connecting" && connection.enrollment && <FormDialog key="organization-security" data-panel-modal="organization-security" title={t("organization.securityDetails")}
      description={t("organization.securityDetailsHelp")} onClose={() => setDialog(null)}>
      <div className="-mx-2"><CopyRow title={t("organization.code")} text={connection.enrollment.userCode} /></div>
    </FormDialog>}</AnimatePresence>
  </>;
}
