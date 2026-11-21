import { useEffect, useState } from "react";
import type { TalkKeyId, TalkShortcutState } from "../../electron/talk-shortcut.mjs";
import { t } from "@/lib/i18n";
import { SettingsSelect } from "./SettingsSelect";
import { SettingRow, Switch } from "./SettingsPrimitives";

/** Settings search finds the talk shortcut only where its row can show: this Mac app's own page. */
export function talkShortcutKeywords(madaniDesktop: Window["madaniDesktop"] = typeof window === "undefined" ? undefined : window.madaniDesktop): string[] {
  return madaniDesktop?.platform === "darwin" && madaniDesktop.talkShortcut ? ["talk", "voice", "shortcut", "hotkey", "hold to talk", "push to talk", "quick asks"] : [];
}

export function TalkShortcutRow() {
  const bridge = window.madaniDesktop?.talkShortcut;
  const [state, setState] = useState<TalkShortcutState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void bridge?.state().then((next) => { if (live) setState(next); }).catch(() => {});
    return () => { live = false; };
  }, [bridge]);
  if (!bridge || !state?.available) return null;
  const label = state.keys.find((key) => key.id === state.key)?.label ?? "";
  const change = (next: { enabled?: boolean; key?: TalkKeyId }) => {
    setBusy(true); setFailed(false);
    void bridge.set(next).then(setState, () => setFailed(true)).finally(() => setBusy(false));
  };
  const problem = failed ? t("settings.talk.failed") : state.enabled && state.taken ? t("settings.talk.taken", { key: label }) : null;
  // one row for the switch, and the key as its own row's quiet value once it is on
  return (
    <>
      <SettingRow icon="mic" title={t("settings.talk.title")} subtitle={t("settings.s2.talk.subtitle", { key: label })}
        message={problem ? <div role="alert" className="text-danger">{problem}</div> : null}>
        <Switch checked={state.enabled} disabled={busy} aria-label={t("settings.talk.aria")} onClick={() => change({ enabled: !state.enabled })} />
      </SettingRow>
      {state.enabled && (
        <SettingRow title={t("settings.s2.talk.key")}>
          <SettingsSelect
            data-settings-select="talk-key"
            value={state.key}
            disabled={busy}
            aria-label={t("settings.talk.keyAria")}
            // SAFETY: the options are rendered from state.keys, so the value is always a member.
            onChange={(event) => change({ key: event.target.value as TalkKeyId })}
          >
            {state.keys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>)}
          </SettingsSelect>
        </SettingRow>
      )}
    </>
  );
}
