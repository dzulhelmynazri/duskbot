import { useState } from "react";
import { t } from "@/lib/i18n";
import { botEngine, signedOutWithoutBackup } from "@/lib/failed-turn";
import { useStore, type Bot, type ConfigStatus, type InstanceInfo } from "@/state/store";
import { freeFallback } from "../../shared/ai-ranking";
import { engineReady } from "./EngineLibrary";
import { ConnectAiDialog } from "./onboarding/ConnectAi";
import { NOTICE_LINE } from "./ChatErrorBanner";
import { useDesktopCapabilities } from "./DesktopCapabilities";

export function aiRunsOnServer(config: ConfigStatus | null | undefined, capabilities: ReturnType<typeof useDesktopCapabilities>["capabilities"]): boolean {
  return window.madaniDesktop?.remoteClient?.active === true || config?.cloudHome === true || capabilities.localComputer?.reasonCode === "remote-server";
}

/** The bot answers with OpenCode's free model: what a newcomer's bots get until an AI of their own is connected. */
export function freeBackupAnswering(bot: Bot, instances: readonly InstanceInfo[]): InstanceInfo | undefined {
  const engine = botEngine(bot, [...instances]);
  return engine && freeFallback(engine) && engineReady(engine) ? engine : undefined;
}

/** grok's prompt notice before a send that could only fail: the bot's AI is signed out and no backup would answer. Once
 * the person has written, it also says when a free backup model is the one answering, with a way to connect their own. */
export function ComposerSignInNotice({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const [connecting, setConnecting] = useState(false);
  const engine = signedOutWithoutBackup(bot, state.instances, state.config?.automaticRecovery);
  const backup = !engine && bot.messages?.some((message) => message.role === "user") ? freeBackupAnswering(bot, state.instances) : undefined;
  if (backup) {
    return (
      <div className="w-full px-5" data-free-backup-notice="">
        <div role="status" className={`mb-2 ${NOTICE_LINE} text-ink-secondary`}>
          <span dir="auto" className="min-w-0">{t("composer.freeBackup", { engine: backup.displayName })}</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={() => setConnecting(true)}
            className="shrink-0 cursor-pointer rounded-sm font-medium text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
            {t("composer.freeBackup.connect")}
          </button>
        </div>
        {connecting && <ConnectAiDialog tested={null} onClose={() => setConnecting(false)} />}
      </div>
    );
  }
  if (!engine) return null;
  const line = t(aiRunsOnServer(state.config, capabilities) ? "failedReply.signedOutServer" : "failedReply.signedOutHere", { engine: engine.displayName });
  return (
    <div className="w-full px-5" data-sign-in-notice="">
      <div role="status" className={`mb-2 ${NOTICE_LINE} text-ink-secondary`}>
        <span dir="auto" className="min-w-0">{line}</span>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}
          className="shrink-0 cursor-pointer rounded-sm font-medium text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
          {t("chat.notice.signIn")}
        </button>
      </div>
    </div>
  );
}
