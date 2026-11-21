import { useEffect, useState } from "react";
import { CLOUD_MAC_MODES, type CloudMacMode, type CloudMacState } from "../../shared/cloud-mac";
import { t } from "@/lib/i18n";
import { Folder, FolderPlus, X } from "../icons";
import type { LocaleKey } from "@/locales";
import { ItemRow, NavRow, NoteRow, SelectRow, SwitchRow } from "./ListRows";
import { useMacControl } from "./MacControlRow";

const MODE_LABEL: Record<CloudMacMode, LocaleKey> = { auto: "cloudMac.mode.auto", ask: "cloudMac.mode.ask", never: "cloudMac.mode.never" };
const MODE_HINT: Record<CloudMacMode, LocaleKey> = { auto: "cloudMac.mode.autoHint", ask: "cloudMac.mode.askHint", never: "cloudMac.mode.neverHint" };

export const cloudMacBridge = () => (typeof window === "undefined" ? undefined : window.madaniDesktop?.cloudMac);

/** The bridge's live state; null until it answers or where there is no bridge. */
export function useCloudMacState(bridge: CloudMacBridge | undefined): [CloudMacState | null, (next: CloudMacState) => void] {
  const [state, setState] = useState<CloudMacState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.state().then((next) => { if (live) setState(next); }).catch(() => {});
    const off = bridge.onChange((next) => setState(next));
    return () => { live = false; off(); };
  }, [bridge]);
  return [state, setState];
}

/** Settings > Your computer on the person's madani cloud: whether its bots may use this Mac, or where to turn that on. */
export function CloudMacCard() {
  const bridge = cloudMacBridge();
  return bridge ? <CloudMacControls bridge={bridge} /> : <CloudMacElsewhere />;
}

function CloudMacControls({ bridge }: { bridge: CloudMacBridge }) {
  const [state, setState] = useCloudMacState(bridge);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state) return null;

  const run = async (call: () => Promise<CloudMacState>) => {
    setPending(true);
    setError(null);
    try {
      setState(await call());
    } catch {
      setError(t("macControl.error"));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <SwitchRow
        data-settings-row="cloud-mac"
        title={t("cloudMac.title")}
        hint={<span aria-live="polite">{t(state.enabled ? "cloudMac.on" : "cloudMac.off")}</span>}
        checked={state.enabled}
        disabled={pending}
        onChange={() => void run(() => bridge.setEnabled(!state.enabled))}
      />
      {state.enabled && state.problem && <NoteRow tone="warn">{state.problem}</NoteRow>}
      {state.enabled && (
        <>
          <SelectRow
            data-sheet-row="cloud-mac-mode"
            title={t("cloudMac.mode")}
            value={state.mode}
            options={CLOUD_MAC_MODES.map((mode) => ({ value: mode, label: t(MODE_LABEL[mode]) }))}
            disabled={pending}
            onChange={(mode) => void run(() => bridge.setMode(mode))}
          />
          <NoteRow><span aria-live="polite">{t(MODE_HINT[state.mode])}</span></NoteRow>
          <SwitchRow
            data-settings-row="cloud-mac-limit"
            title={t("cloudMac.limitFolders")}
            hint={<span aria-live="polite">{t(state.limitFolders ? "cloudMac.limitOn" : "cloudMac.limitOff")}</span>}
            checked={state.limitFolders}
            disabled={pending}
            onChange={() => void run(() => bridge.setLimitFolders(!state.limitFolders))}
          />
          {state.limitFolders && state.folders.map((folder) => (
            <ItemRow key={folder} data-settings-row="cloud-mac-folder" icon={Folder} title={folder}>
              <button
                type="button"
                aria-label={t("cloudMac.removeFolder", { path: folder })}
                title={t("cloudMac.removeFolder", { path: folder })}
                disabled={pending}
                onClick={() => void run(() => bridge.removeFolder(folder))}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-secondary outline-none hover:bg-ink/[0.035] hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </ItemRow>
          ))}
          {state.limitFolders && (
            <NavRow icon={FolderPlus} title={t("cloudMac.addFolder")} drill={false} disabled={pending} onClick={() => void run(() => bridge.addFolder())} />
          )}
          <NavRow title={t("cloudMac.viewLog")} external onClick={() => void bridge.openLog().catch(() => {})} />
        </>
      )}
      {error && <NoteRow tone="danger">{error}</NoteRow>}
    </>
  );
}

function CloudMacElsewhere() {
  const [status] = useMacControl();
  const on = status?.enabled === true && status.online;
  return <NoteRow>{on ? t("cloudMac.remoteOn", { name: status?.name ?? "Mac" }) : t("cloudMac.remoteOff")}</NoteRow>;
}
