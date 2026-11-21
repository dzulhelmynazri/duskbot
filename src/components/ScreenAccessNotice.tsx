import { useState, useSyncExternalStore } from "react";
import { AnimatePresence } from "motion/react";
import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { macPermissionsBridge } from "@/lib/mac-permissions";
import { missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import type { Bot } from "@/state/store";
import { CARD_ACTION, ChatErrorCard } from "./ChatErrorBanner";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MacPermissionsDialog } from "./onboarding/PermissionsStep";

// when a bot last asked for screen control in each conversation, for this run of the app
const askedAt = new Map<string, number>();
// the ask each conversation's notice was closed for: a newer ask shows it again
const closedAt = new Map<string, number>();
const subscribers = new Set<() => void>();
let listening = false;

function changed() { for (const notify of subscribers) notify(); }

/** A bot called request_screen_access in this conversation (the server's live frame). */
export function noteScreenAccessAsked(threadId: string, at = Date.now()): void {
  askedAt.set(threadId, at);
  changed();
}

function subscribe(notify: () => void) {
  if (!listening && typeof window !== "undefined") {
    listening = true;
    listenLiveFrames({ onFrame: (frame) => {
      const ask = frame as { kind: string; threadId?: unknown };
      if (ask.kind === "screen-access" && typeof ask.threadId === "string") noteScreenAccessAsked(ask.threadId);
    } });
  }
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

/** The open ask in this conversation, or 0 when there is none or its notice was closed. */
function openAsk(threadId: string | undefined): number {
  const at = threadId ? askedAt.get(threadId) ?? 0 : 0;
  return at && closedAt.get(threadId!) !== at ? at : 0;
}

function useOpenAsk(threadId: string | undefined): number {
  return useSyncExternalStore(subscribe, () => openAsk(threadId), () => 0);
}

/** True while this Mac's screen control waits for a macOS permission, in the desktop app that can ask for it. */
export function useScreenAccessMissing(): boolean {
  const { capabilities, ready } = useDesktopCapabilities();
  const local = capabilities.localComputer;
  return ready && capabilities.host?.platform === "darwin" && local?.available === false && local.reasonCode !== "remote-server" &&
    missingMacCuaPermissions(local.message).length > 0 && macPermissionsBridge() !== null;
}

/** The card's one action: the guided permissions, then a fresh look at the computer helper. */
export function ScreenAccessCard({ onDismiss }: { onDismiss: () => void }) {
  const [asking, setAsking] = useState(false);
  const bridge = macPermissionsBridge();
  const recheck = () => { void window.madaniDesktop?.localControl?.retry?.().catch(() => {}); };
  return (
    <div className="mb-2 w-full px-5" data-screen-access="">
      <ChatErrorCard tone="info" icon="offline" title={t("screenAccess.title")} onDismiss={onDismiss}
        actions={bridge && <button type="button" data-screen-access-allow="" onClick={() => setAsking(true)} className={CARD_ACTION}>{t("screenAccess.allow")}</button>} />
      <AnimatePresence>{asking && bridge && <MacPermissionsDialog key="mac-permissions-dialog" bridge={bridge} onClose={() => { setAsking(false); recheck(); }} onAllowed={recheck}
        relaunch={typeof window.madaniDesktop?.relaunch === "function" ? () => void window.madaniDesktop!.relaunch!() : null} />}</AnimatePresence>
    </div>
  );
}

/** Above the composer once the bot asked for screen control in this conversation, while macOS still withholds it: gone the
 * moment it is allowed. The bot still chats and browses either way. */
export function ScreenAccessNotice({ bot }: { bot: Pick<Bot, "id" | "threadId"> }) {
  const missing = useScreenAccessMissing();
  const asked = useOpenAsk(bot.threadId);
  if (!missing || !asked || !bot.threadId) return null;
  const threadId = bot.threadId;
  return <ScreenAccessCard onDismiss={() => { closedAt.set(threadId, asked); changed(); }} />;
}
