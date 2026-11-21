import { t } from "@/lib/i18n";
import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Trash2 } from "../icons";
import { Card as RowsCard, FormDialog, FormField, ItemRow, NavRow, NoteRow, SwitchRow, pillCls } from "./ListRows";
import { CloudTile } from "./cloud-buy/parts";
import { cloudColor } from "@/lib/cloud-look";
import { askConfirm } from "./ConfirmDialog";
import { textFieldCls } from "./ui/GrokDialog";
import { PixelIcon } from "./ui/PixelIcon";
import { openPlaceSetup, pastedPairingLink } from "@/lib/place-setup";
import { vpsLinkAvailable } from "@/lib/vps-link";

type SavedWorkspaces = Awaited<ReturnType<NonNullable<NonNullable<Window["madaniDesktop"]>["environments"]>["state"]>>;

export function ConnectedWorkspacesSettings() {
  const bridge = window.madaniDesktop?.environments;
  const [saved, setSaved] = useState<SavedWorkspaces | null>(null);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [envName, setEnvName] = useState("");
  const [envDir, setEnvDir] = useState("");
  const [envForget, setEnvForget] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [envPurge, setEnvPurge] = useState(false);
  const [envError, setEnvError] = useState("");
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    void bridge?.state().then((state) => { if (generation.current === current) setSaved(state); })
      .catch(() => { if (generation.current === current) setError(t("settings.s2.servers.loadError")); });
    return () => { generation.current++; };
  }, [bridge]);
  const perform = async (action: () => Promise<unknown>, fail: (message: string) => void = setError) => {
    if (pending.current || !bridge) return;
    pending.current = true; setBusy(true); setError(""); setEnvError("");
    const current = generation.current;
    try {
      // Security: a successful switch unloads this renderer; never ask for its privileged saved list again after the
      // origin changes.
      if (await action() === true) return;
      const state = await bridge.state();
      if (generation.current === current) setSaved(state);
    } catch (nextError) {
      if (generation.current === current) fail(String((nextError as Error)?.message ?? nextError)
        .replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    } finally {
      pending.current = false;
      if (generation.current === current) setBusy(false);
    }
  };
  if (!bridge) return <RowsCard><NoteRow>{t("settings.s2.servers.desktopOnly")}</NoteRow></RowsCard>;
  const locals = saved?.environments.filter(entry => entry.kind === "local") ?? [];
  const forgetEntry = locals.find(entry => entry.id === envForget);
  // a quiet trash button at the end of a row, named for what it forgets
  const forgetButton = (label: string, onClick: () => void) => (
    <button type="button" disabled={busy} aria-label={label} title={label} onClick={onClick}
      className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.035] hover:text-danger outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:opacity-45">
      <Trash2 size={13} aria-hidden="true" />
    </button>
  );
  const current = <span data-panel-value="" className="shrink-0 text-[13px] leading-[18px] text-ink-secondary">{t("connectedWorkspaces.current")}</span>;
  return <>
    {saved?.packaged && <RowsCard label={t("connectedWorkspaces.localTitle")} data-settings-block="environments">
      {locals.map((entry) => {
        const active = entry.id === saved.activeId;
        return <ItemRow key={entry.id} title={entry.name} hint={<>{entry.dataDir}{entry.missing && <> · <span>{t("connectedWorkspaces.missing")}</span></>}</>}>
          {active ? current : <button type="button" className="ui-button" disabled={busy} aria-label={t("connectedWorkspaces.switchTo", { name: entry.name })}
            onClick={() => void perform(async () => {
              if (!await askConfirm({ art: <PixelIcon name="laptop" size={28} />, title: t("connectedWorkspaces.switchTitle", { name: entry.name }), body: t("connectedWorkspaces.switchBody"), confirmLabel: t("connectedWorkspaces.switchAction"), tone: "neutral" })) return;
              const result = await bridge.switch(entry.id);
              if (result && result.ok === false) throw new Error(t("connectedWorkspaces.switchError"));
              return true;
            }, setEnvError)}>{t("connectedWorkspaces.switch")}</button>}
          {!active && forgetButton(t("connectedWorkspaces.forgetName", { name: entry.name }), () => { setEnvForget(entry.id); setEnvPurge(false); })}
        </ItemRow>;
      })}
      <NavRow data-settings-open="new-environment" title={t("connectedWorkspaces.newEnvironment")} hint={t("settings.s2.env.newHint")} onClick={() => { setEnvError(""); setCreating(true); }} />
      {envError && !creating && !forgetEntry && <NoteRow tone="danger">{envError}</NoteRow>}
    </RowsCard>}
    <RowsCard label={t("settings.s2.servers.title")} data-settings-block="servers">
      {!saved ? <NoteRow>{error ? t("settings.s2.servers.loadFailed") : t("settings.s2.servers.loading")}</NoteRow> :
        [{ id: "local", name: t("settings.s2.servers.thisComputer"), origin: "", color: undefined }, ...saved.environments.filter((entry) => entry.kind !== "local")].map((entry) => {
          const active = entry.id === saved.activeId;
          return <ItemRow key={entry.id} title={<span className="flex min-w-0 items-center gap-2">{cloudColor(entry.color) && <CloudTile color={entry.color} size={16} />}<span className="truncate">{entry.name}</span></span>}
            hint={entry.origin || t("settings.s2.servers.local")}>
            {active ? current : <button type="button" className="ui-button" disabled={busy} aria-label={t("settings.s2.servers.switchTo", { name: entry.name })}
              onClick={() => void perform(async () => { await bridge.switch(entry.id); return true; })}>{t("connectedWorkspaces.switch")}</button>}
            {entry.id !== "local" && forgetButton(t("settings.s2.servers.forget", { name: entry.name }), () => void perform(() => bridge.forget(entry.id)))}
          </ItemRow>;
        })}
      {vpsLinkAvailable() && <NavRow data-settings-open="add-vps" title={t("vpsLink.add")} hint={t("vpsLink.addHint")} onClick={() => openPlaceSetup("server")} />}
      <NavRow data-settings-open="connect-server" title={t("vpsLink.connectByAddress")} hint={t("settings.s2.servers.connectHint")} onClick={() => { setError(""); setAdding(true); }} />
      {error && saved && !adding && <NoteRow tone="danger">{error}</NoteRow>}
    </RowsCard>
    <AnimatePresence>{adding && <FormDialog key="connect-server" data-panel-modal="connect-server" title={t("settings.s2.servers.connect")} description={t("settings.s2.servers.commandNote")}
      saveLabel={t("settings.s2.servers.connectAction")} canSave={Boolean(address.trim())} busy={busy} error={error || undefined}
      onSave={() => perform(async () => { const done = await bridge.addFromLink(pastedPairingLink(address) ?? address.trim(), name.trim()); setAdding(false); return done; })}
      onClose={() => setAdding(false)}>
      <FormField label={t("settings.s2.servers.address")}>
        <input required value={address} disabled={busy} onChange={(event) => setAddress(event.target.value)}
          placeholder="https://bots.yourcompany.com" autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} className={textFieldCls} />
      </FormField>
      <FormField label={t("settings.s2.servers.name")}>
        <input value={name} disabled={busy} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder={t("settings.s2.servers.namePlaceholder")} className={textFieldCls} />
      </FormField>
    </FormDialog>}</AnimatePresence>
    <AnimatePresence>{creating && <FormDialog key="new-environment" data-panel-modal="new-environment" title={t("connectedWorkspaces.newEnvironment")} saveLabel={t("connectedWorkspaces.create")}
      canSave={Boolean(envName.trim())} busy={busy} error={envError || undefined}
      onSave={() => perform(async () => {
        const created = await bridge.create(envName.trim(), envDir.trim() || undefined);
        if (!created?.ok) throw new Error(t("connectedWorkspaces.createError"));
        setEnvName(""); setEnvDir(""); setCreating(false);
      }, setEnvError)}
      onClose={() => setCreating(false)}>
      <FormField label={t("connectedWorkspaces.name")}>
        <input required value={envName} disabled={busy} maxLength={60} onChange={(event) => setEnvName(event.target.value)} placeholder={t("connectedWorkspaces.environmentPlaceholder")} className={textFieldCls} />
      </FormField>
      <FormField label={t("connectedWorkspaces.dataFolder")}>
        <span className="flex gap-2">
          <input value={envDir} disabled={busy} onChange={(event) => setEnvDir(event.target.value)} placeholder={t("connectedWorkspaces.defaultFolder")} className={textFieldCls} />
          <button type="button" disabled={busy} className={pillCls} onClick={() => void perform(async () => {
            const picked = await bridge.pickDir();
            if (picked?.ok && picked.path) setEnvDir(picked.path);
          }, setEnvError)}>{t("connectedWorkspaces.choose")}</button>
        </span>
      </FormField>
    </FormDialog>}</AnimatePresence>
    <AnimatePresence>{forgetEntry && <FormDialog key="forget-environment" data-panel-modal="forget-environment" title={t("settings.s2.env.forgetTitle", { name: forgetEntry.name })}
      saveLabel={t("connectedWorkspaces.forget")} cancelLabel={t("connectedWorkspaces.cancel")} busy={busy} error={envError || undefined}
      onSave={() => perform(async () => {
        const result = envPurge ? await bridge.forget(forgetEntry.id, true) : await bridge.forget(forgetEntry.id);
        if (result && result.ok === false) throw new Error(t("connectedWorkspaces.forgetError"));
        setEnvForget(null);
      }, setEnvError)}
      onClose={() => setEnvForget(null)}>
      <div className="-mx-2 flex flex-col">
        <SwitchRow title={t("settings.s2.env.purge")} hint={forgetEntry.dataDir} checked={envPurge} disabled={busy} onChange={() => setEnvPurge(!envPurge)} />
      </div>
    </FormDialog>}</AnimatePresence>
  </>;
}
