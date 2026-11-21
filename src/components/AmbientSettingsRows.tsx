import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";
import { SettingRow, Switch } from "./SettingsPrimitives";
import { SettingsSelect } from "./SettingsSelect";
import { ISLAND_SIZES, notchOf } from "../../electron/ambient-geometry.mjs";
import { MOOD_EMOJI, moodOf } from "@/ambient/mood";
import { ambientSnapshot } from "@/ambient/summary";
import { turnLive } from "@/state/turn-status";
import type { AmbientPrefs } from "@/ambient/types";

type Size = AmbientPrefs["size"];
const SIZES: Size[] = ["small", "medium", "large"];
const DISPLAYS: AmbientPrefs["display"][] = ["active", "built-in", "main"];
/** A 14 inch MacBook Pro at its default scale: the notch the previews draw. */
const SAMPLE_NOTCH = notchOf({ internal: true, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }, "darwin")!;
const PREVIEW_SCALE = 0.72;

/** Settings → Appearance: the notch island and the bot dock (electron/ambient-main.mjs), on the desktop app only. */
export function AmbientRows() {
  const bridge = window.madaniDesktop?.ambient;
  const [state, setState] = useState<AmbientPrefs | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void bridge?.prefs().then((next) => { if (live) setState(next); }, () => {});
    return () => { live = false; };
  }, [bridge]);
  if (!bridge || !state?.available) return null;
  const change = (next: Parameters<typeof bridge.set>[0]) => {
    setFailed(false);
    setState({ ...state, ...next });
    void bridge.set(next).then(setState, () => { setFailed(true); void bridge.prefs().then(setState, () => {}); });
  };
  const problem = failed ? <div role="alert" className="text-danger">{t("settings.ambient.failed")}</div> : null;
  const island = state.platform === "darwin";
  return (
    <>
      {island && <SettingRow icon="laptop" title={t("settings.ambient.island.title")} subtitle={t("settings.ambient.island.subtitle")} message={problem}>
        <Switch checked={state.island} aria-label={t("settings.ambient.island.title")} onClick={() => change({ island: !state.island })} />
      </SettingRow>}
      {island && state.island && (
        <>
          <SettingRow title={t("settings.ambient.size.title")} subtitle={t("settings.ambient.size.subtitle")}>
            <SettingsSelect
              data-settings-select="island-size"
              value={state.size}
              aria-label={t("settings.ambient.size.title")}
              options={SIZES.map((size) => ({ value: size, label: t(`settings.ambient.size.${size}`) }))}
              // SAFETY: the options are SIZES, so the value is always one of them.
              onChange={(event) => change({ size: event.target.value as Size })}
            />
          </SettingRow>
          <IslandPreviews size={state.size} />
        </>
      )}
      <SettingRow icon="sparkle" title={t("settings.ambient.dock.title")} subtitle={t("settings.ambient.dock.subtitle")} message={island ? null : problem}>
        <Switch checked={state.dock} aria-label={t("settings.ambient.dock.title")} onClick={() => change({ dock: !state.dock })} />
      </SettingRow>
      {(state.island || state.dock) && state.displays.length > 1 && (
        <SettingRow title={t("settings.ambient.display.title")} subtitle={t("settings.ambient.display.subtitle")}>
          <SettingsSelect
            data-settings-select="ambient-display"
            value={state.display}
            aria-label={t("settings.ambient.display.title")}
            options={DISPLAYS.map((display) => ({ value: display, label: t(`settings.ambient.display.${display}`) }))}
            // SAFETY: the options are DISPLAYS.
            onChange={(event) => change({ display: event.target.value as AmbientPrefs["display"] })}
          />
        </SettingRow>
      )}
    </>
  );
}

/** The island as it sits now, drawn small: hugging the notch on a built-in display, a floating pill on another. */
function IslandPreviews({ size }: { size: Size }) {
  const { state } = useStore();
  const snapshot = useMemo(() => ambientSnapshot(state.bots, state.instances, turnLive, activeLocale()), [state.bots, state.instances]);
  const bot = state.bots.find((entry) => entry.id === [...snapshot.bots].sort((a, b) => b.at - a.at)[0]?.id) ?? state.bots[0];
  const emoji = MOOD_EMOJI[moodOf(snapshot.bots)];
  const s = ISLAND_SIZES[size];
  const k = PREVIEW_SCALE;
  const tile = Math.round(s.tile * k * 1.15);
  const notch = { width: Math.round((SAMPLE_NOTCH.width + 2 * s.side) * k), height: Math.round(SAMPLE_NOTCH.height * k) };
  const pill = { width: Math.round(s.pill * k), height: Math.round(s.pillHeight * k) };
  const mark = bot ? <BotAvatar bot={bot} size={tile} animated={false} trackPointer={false} personality={false} /> : <span style={{ width: tile }} />;
  const face = <span aria-hidden className="leading-none" style={{ fontSize: Math.round(tile * 0.9) }}>{emoji}</span>;
  const frame = "relative h-[84px] overflow-hidden rounded-[10px] border-[0.5px] border-transparent bg-inset";
  return (
    <div data-ambient-preview="" aria-hidden className="grid grid-cols-2 gap-3 px-2 pt-1 pb-2.5 max-sm:grid-cols-1">
      <figure className="m-0 flex flex-col items-center gap-2">
        <div className={`${frame} w-full`}>
          <div className="absolute left-1/2 top-0 -translate-x-1/2" style={{ width: notch.width, height: notch.height }}>
            <span className="absolute top-0 -left-2 size-2 bg-[radial-gradient(circle_farthest-side_at_0_100%,transparent_96%,#000_100%)]" />
            <span className="absolute top-0 -right-2 size-2 bg-[radial-gradient(circle_farthest-side_at_100%_100%,transparent_96%,#000_100%)]" />
            <div className="flex size-full items-center justify-between rounded-b-[10px] bg-black px-2">{mark}{face}</div>
          </div>
        </div>
        <figcaption className="text-[12px] leading-4 text-ink-secondary">{t("settings.ambient.preview.builtIn")}</figcaption>
      </figure>
      <figure className="m-0 flex flex-col items-center gap-2">
        <div className={`${frame} w-full`}>
          <div className="absolute left-1/2 top-2 flex -translate-x-1/2 items-center justify-between rounded-full bg-black" style={{ width: pill.width, height: pill.height, paddingInline: Math.round((pill.height - tile) / 2) + 2 }}>{mark}{face}</div>
        </div>
        <figcaption className="text-[12px] leading-4 text-ink-secondary">{t("settings.ambient.preview.external")}</figcaption>
      </figure>
    </div>
  );
}
