import { useState } from "react";
import { useStore } from "@/state/store";
import { WindowDragStrip } from "@/components/DesktopCapabilities";
import { t } from "@/lib/i18n";
import { AiCards } from "./onboarding/AiCards";
import { ConnectAiDialog } from "./onboarding/ConnectAi";
import { StepArt, StepFrame } from "./onboarding/FunnelSteps";

export function NoEngines() {
  const { refreshInstances } = useStore();
  const remoteClient = window.madaniDesktop?.remoteClient?.active === true;
  const [rechecking, setRechecking] = useState(false);
  const [more, setMore] = useState(false);
  const recheck = async () => {
    setRechecking(true);
    try {
      await refreshInstances();
    } finally {
      setRechecking(false);
    }
  };

  if (remoteClient) {
    return (
      <main className="relative flex h-full min-w-0 flex-1 items-center justify-center bg-app px-6">
        <WindowDragStrip />
        <div className="max-w-[520px] p-6 text-center">
          <h1 className="text-[20px] font-semibold text-ink">{t("noEngines.remoteTitle")}</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-secondary">
            {t("noEngines.remoteIntro")}
          </p>
          <button onClick={() => void recheck()} disabled={rechecking} className="mt-5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60">
            {rechecking ? t("common.checking") : t("common.checkAgain")}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main data-no-engines="" className="relative flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <WindowDragStrip />
      <StepFrame art={<StepArt art="plug" />} title={t("funnel.ai.title")} sub={t("funnel.ai.sub")} wide>
        <AiCards tested={null} onMore={() => setMore(true)} />
      </StepFrame>
      {more && <ConnectAiDialog tested={null} directory onClose={() => setMore(false)} />}
    </main>
  );
}
