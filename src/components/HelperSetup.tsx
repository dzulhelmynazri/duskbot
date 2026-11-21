import { useState } from "react";
import { Calendar, Cloud, Download, Eye, Inbox, ListChecks, Mail, Reply, Smartphone, Sparkles, type GlyphIcon } from "../icons";

import { track } from "@/lib/analytics";
import { INTRO_CHIPS, type IntroAsk, type IntroChip } from "@/lib/default-bot";
import { t } from "@/lib/i18n";
import { phonePairingSettingsAction } from "@/lib/phone-pairing";
import type { LocaleKey } from "@/locales";
import { useStore, type Action } from "@/state/store";
import { ConnectAiDialog } from "./onboarding/ConnectAi";
import { useWelcomeAi } from "./onboarding/welcome-ai";

const CHIP = "inline-flex h-8 items-center gap-2 rounded-full border-[0.5px] border-transparent bg-card px-3 text-[14px] leading-5 text-ink transition-colors hover:bg-[color-mix(in_srgb,var(--color-ink)_4%,var(--color-card))]";

const CHIPS: Record<IntroChip, { label: LocaleKey; icon: GlyphIcon }> = {
  ai: { label: "helperIntro.chip.ai", icon: Sparkles },
  apps: { label: "helperIntro.chip.mail", icon: Mail },
  import: { label: "helperIntro.chip.skills", icon: Download },
  phone: { label: "helperIntro.chip.phone", icon: Smartphone },
  cloud: { label: "helperIntro.chip.cloud", icon: Cloud },
};

/** First jobs to hand Madani in one tap (introAsks picks three): each is sent as the person's first message. */
const ASKS: Record<IntroAsk, { label: LocaleKey; icon: GlyphIcon }> = {
  day: { label: "helperIntro.ask.day", icon: Eye },
  today: { label: "helperIntro.ask.today", icon: Calendar },
  inbox: { label: "helperIntro.ask.inbox", icon: Inbox },
  inboxNow: { label: "helperIntro.ask.inboxNow", icon: Reply },
  week: { label: "helperIntro.ask.week", icon: ListChecks },
};

/** Each chip opens the app's own flow for it; Connect an AI opens its dialog in place (IntroChips). */
export function chipAction(chip: Exclude<IntroChip, "ai">): Action {
  switch (chip) {
    case "apps": return { type: "togglePlugins", open: true, surface: "apps" };
    case "import": return { type: "toggleAppSettings", open: true, section: "import" };
    case "phone": return phonePairingSettingsAction();
    case "cloud": return { type: "openCloudAdd", source: "app_onboarding" };
  }
}

function IntroConnectAi({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  return <ConnectAiDialog tested={useWelcomeAi(state.instances, true)} onClose={onClose} />;
}

/** What is still missing, as chips under Madani's follow-up (Simple mode): at most INTRO_CHIPS. A tapped chip stays, so it
 * can be tapped again if its flow was closed. */
export function IntroChips({ chips, asks = [], onAsk }: { chips: readonly IntroChip[]; asks?: readonly IntroAsk[]; onAsk?: (text: string) => void }) {
  const { dispatch } = useStore();
  const [connecting, setConnecting] = useState(false);
  const shown = chips.slice(0, INTRO_CHIPS);
  const tap = (chip: IntroChip) => {
    if (chip === "ai") return setConnecting(true);
    if (chip === "cloud") track("onboarding_cloud", { action: "start_trial" });
    dispatch(chipAction(chip));
  };
  return (
    <>
      {(shown.length > 0 || onAsk) && (
        <div role="group" aria-label={t("helperIntro.setup")} data-helper-setup="" className="animate-msg-in mt-1 flex max-w-full flex-wrap gap-2">
          {onAsk && asks.map((ask) => ASKS[ask]).map(({ label, icon: Icon }) => (
            <button key={label} type="button" data-helper-ask={label} onClick={() => onAsk(t(label))} className={CHIP}>
              <Icon size={16} aria-hidden="true" className="text-ink-secondary" />{t(label)}
            </button>
          ))}
          {shown.map((chip) => {
            const { label, icon: Icon } = CHIPS[chip];
            return (
              <button key={chip} type="button" data-helper-step={chip} onClick={() => tap(chip)} className={CHIP}>
                <Icon size={16} aria-hidden="true" className="text-ink-secondary" />{t(label)}
              </button>
            );
          })}
        </div>
      )}
      {connecting && <IntroConnectAi onClose={() => setConnecting(false)} />}
    </>
  );
}
