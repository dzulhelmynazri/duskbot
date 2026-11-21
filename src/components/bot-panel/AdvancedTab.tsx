import { useEffect, useState } from "react";

import { useStore, type Bot } from "@/state/store";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { openBotSettings } from "@/lib/open-settings";
import { VoiceChatCard } from "./DetailsTab";
import { LibrarySection } from "./LibraryTab";
import { FilesSection, useFiles } from "../documents/FilesSection";
import { takePanelModalRequest, usePanelModalRequest, type SheetPage } from "./modals/panel-modal";
import { isSimplePage, type PageId, type SimplePageId } from "./page-registry";
import { createPortal } from "react-dom";
import { ChevronLeft } from "../../icons";
import { t } from "@/lib/i18n";
import { PanelSections } from "../ListRows";
import { SettingsPage } from "./SettingsPage";
import { PanelModal } from "./modals/PanelModals";
import { usePanelLink } from "./panel-link";
import { phoneApp } from "@/lib/store-app";

// a link opens Settings once: a panel drawn again for the same link (it reads the link as it mounts) must not reopen it
let openedForLink = -1;

/** Every native per-bot feature Grok's Details tab has no room for, in Grok's list language: what the bot made, its voice
 * chat, the bot's own rows (each opening Settings' Bots page on this bot, at that row's page) and its rare actions. A deep link to one of those pages lands in Settings there. */
export function AdvancedTab({ bot, derived, onOpen }: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  onOpen: (page: SimplePageId) => void;
}) {
  const { dispatch } = useStore();
  const request = usePanelModalRequest();
  const link = usePanelLink();
  const files = useFiles(bot, onOpen);
  // the phone has no Settings window: a page the profile draws itself opens there, any other over it, the same page
  // Settings draws
  const [phonePage, setPhonePage] = useState<SheetPage | null>(null);
  const openOnPhone = (page: SheetPage) => { if (isSimplePage(page as PageId)) onOpen(page as SimplePageId); else setPhonePage(page); };
  const openPage = (page: SheetPage) => phoneApp() ? openOnPhone(page) : dispatch(openBotSettings({ kind: "bot", id: bot.id, row: page }));

  useEffect(() => {
    if (!request) return;
    takePanelModalRequest(request);
    const linkNonce = link?.nonce ?? 0;
    if (linkNonce !== 0 && linkNonce === openedForLink) return;
    openedForLink = linkNonce;
    if (phoneApp()) openOnPhone(request.page);
    else dispatch(openBotSettings({ kind: "bot", id: bot.id, row: request.page }));
  }, [request, link, bot.id, dispatch]);

  return (
    <PanelSections data-panel-tabpanel="advanced">
      <FilesSection bot={bot} files={files} onOpen={onOpen} />
      <LibrarySection bot={bot} onOpen={onOpen} quietWhenEmpty={Boolean(files.documents?.length) || phoneApp()} />
      <VoiceChatCard bot={bot} patch={derived.patch} />
      <SettingsPage bot={bot} derived={derived} onOpen={openPage} />
      {phonePage && <PhonePage page={phonePage} bot={bot} derived={derived} onClose={() => setPhonePage(null)} />}
    </PanelSections>
  );
}

/** One of the bot's settings pages on the phone, over its profile, with a way back. */
function PhonePage({ page, bot, derived, onClose }: { page: SheetPage; bot: Bot; derived: ReturnType<typeof useBotSettingsDerived>; onClose: () => void }) {
  return createPortal(
    <div data-phone-bot-page={page} className="fixed inset-0 z-[60] flex flex-col bg-app pb-[var(--m-safe-bottom)] pt-[var(--m-safe-top)]">
      <div className="flex shrink-0 items-center px-4 pt-1">
        <button type="button" aria-label={t("mobile.sheet.back")} onClick={onClose} className="mobile-press flex size-11 items-center justify-center rounded-full bg-ink/[0.06] text-ink"><ChevronLeft size={20} /></button>
      </div>
      <PanelModal page={page} bot={bot} derived={derived} onClose={onClose} />
    </div>,
    document.querySelector(".madani-mobile") ?? document.body,
  );
}
