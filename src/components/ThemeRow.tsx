import { useSyncExternalStore } from "react";
import { t, tOptional } from "@/lib/i18n";
import { SKINS, THEME_SKINS, applySkinChoice, readSkinChoice, subscribeSkin, type SkinChoice } from "@/lib/skins";
import { SettingRow } from "./SettingsPrimitives";
import { SettingsSelect } from "./SettingsSelect";

const THEMES = [
  { choice: "system", label: "settings.simple.theme.system" },
  { choice: THEME_SKINS.light, label: "settings.theme.light" },
  { choice: THEME_SKINS.dark, label: "settings.theme.dark" },
] as const satisfies readonly { choice: SkinChoice; label: string }[];

/** the other looks, after Grok's three themes in the same select */
const LOOKS = SKINS.filter((skin) => !THEMES.some((theme) => theme.choice === skin.id));

export function useSkinChoice(): SkinChoice {
  return useSyncExternalStore(subscribeSkin, readSkinChoice, readSkinChoice);
}

const SWATCHES: Record<string, readonly [ground: string, accent: string]> = {
  system: ["#fcfcfc", "#121212"],
  grok: ["#fcfcfc", "#126fd4"],
  "grok-dark": ["#121212", "#116dd2"],
  midnight: ["#121212", "#1084fe"],
  atelier: ["#f5f1eb", "#a05f25"],
  foundry: ["#100e0b", "#d99a3e"],
  lagoon: ["#dfeceb", "#11736d"],
  graphite: ["#111214", "#4f75a2"],
  linen: ["#eceff3", "#355f8a"],
  madani: ["#121014", "#765683"],
  daylight: ["#fcfcfc", "#126fd4"],
  meadow: ["#ffffff", "#1a7a48"],
  pop: ["#fdf5ea", "#7f52f0"],
  halloween: ["#110d16", "#ff7f1f"],
};

/** A look's ground and accent, split on the diagonal. */
export function ThemeSwatch({ id }: { id: string }) {
  const [ground, accent] = SWATCHES[id] ?? SWATCHES.system!;
  return <span aria-hidden="true" data-theme-swatch={id} className="size-3.5 shrink-0 rounded-full shadow-[inset_0_0_0_0.5px_rgb(28_28_28/0.18)]" style={{ background: `linear-gradient(135deg, ${ground} 50%, ${accent} 50%)` }} />;
}

/** Grok's three themes, then the other looks, each with its swatch. */
export const themeOptions = () => [
  ...THEMES.map((theme) => ({ value: theme.choice, label: t(theme.label), preview: <ThemeSwatch id={theme.choice} /> })),
  ...LOOKS.map((skin) => ({ value: skin.id, label: skin.name, preview: <ThemeSwatch id={skin.id} /> })),
];

export function ThemeRow() {
  const choice = useSkinChoice();
  return (
    <SettingRow icon="theme" title={t("settings.theme.title")} subtitle={tOptional("settings.docs.theme.hint")}>
      <SettingsSelect
        data-settings-select="theme"
        value={choice}
        aria-label={t("settings.theme.title")}
        options={themeOptions()}
        onChange={(event) => {
          const next = [...THEMES.map((theme) => theme.choice), ...LOOKS.map((skin) => skin.id)].find((value) => value === event.target.value);
          if (next) applySkinChoice(next);
        }}
      />
    </SettingRow>
  );
}
