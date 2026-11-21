import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence, useIsPresent } from "motion/react";
import { useStore, type AppSettingsSection } from "@/state/store";
import { t } from "@/lib/i18n";
import { trailNavigation } from "@/lib/trail";
import { cn } from "@/lib/cn";
import { scrollWithin } from "@/lib/scroll-within";
import { useMediaQuery } from "@/lib/use-media-query";
import { REDUCED, SHEET_EXIT, sheetLeave, WIPE } from "@/lib/motion-presets";
import { MotionDiv, useMotionReduced } from "./ui/SheetMotion";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { currentPhonePairingTarget, phonePairingSettingsAction } from "@/lib/phone-pairing";
import { phoneAppEnabled } from "@/lib/feature-flags";
import { AdminOnly } from "./AdminOnly";
import { SlackWorkspaceCard } from "./slack/SlackWorkspaceCard";
import { KeysPage } from "./keys/KeysPage";
import { useKeyFocus } from "./keys/key-focus";
import { CompanionSection } from "./CompanionSection";
import { ServerPairingCard } from "./ServerPairingCard";
import { MobilePairingCard, type PhoneParts } from "./MobilePairingCard";
import { RemoteComputerSection } from "./RemoteComputerSection";
import { CloudAccountSettings } from "./CloudAccountSettings";
import { TransferSettings } from "./vps-link/TransferSettings";
import { vpsLinkAvailable } from "@/lib/vps-link";
import { Icon } from "./Icon";
import { SettingGlyph, type SettingGlyphName } from "./ui/SettingGlyph";
import { SIMPLE_BUTTONS } from "./SettingsPrimitives";
import { PaneHeader, PanelSections, SubPageContext, WipeStack, type SubPage } from "./ListRows";
import {
  AdvancedIndex, AdvancedPageView, SECTION_PAGES, ComputerPane, GeneralPane, ModelsPane, PermissionsPane, TextingPane, UpdatesPane, UsagePane, VaultPane,
  advancedTitle, type AdvancedPage, type Disclose, type RemoteAccessCards,
} from "./SettingsPanes";
import { ADVANCED_PAGES, SETTINGS_PANES, consumeBotTarget, settingsLocation, useBotTarget, type SettingsPane } from "@/lib/open-settings";
import type { LocaleKey } from "@/locales";
import { VaultNewItem } from "./LoginsSettings";
import { VoiceInputSettings } from "./VoiceInputSettings";
import { BotsPane, chooseBotsScope, scopeOf, targetPage } from "./SettingsBots";
import "../styles/settings.css";


export { openBotSettings, openSettings, settingsLocation, SETTINGS_PANES, type SettingsLocation, type SettingsPane } from "@/lib/open-settings";

const REMOTE_SECTIONS: readonly AppSettingsSection[] = ["appearance", "companion", "desktopWorkspaces", "looks", "voice"];

const RAIL_GLYPH: Record<SettingsPane, SettingGlyphName> = {
  general: "gear", voice: "mic", texting: "bubble", computer: "laptop", permissions: "shield", vault: "key",
  models: "sparkle", bots: "team", usage: "chart", updates: "download", advanced: "sliders",
};

const RAIL_GROUPS: ReadonlyArray<{ id: string; labelKey: LocaleKey; panes: readonly SettingsPane[] }> = [
  { id: "you", labelKey: "settings.rail.you", panes: ["general", "voice"] },
  { id: "bots", labelKey: "settings.rail.yourBots", panes: ["computer", "texting", "permissions", "vault", "models", "bots"] },
  { id: "app", labelKey: "settings.rail.thisApp", panes: ["usage", "updates", "advanced"] },
];

export function revealSettingsBlock(
  scroller: Parameters<typeof scrollWithin>[0] & { querySelector: (selector: string) => Parameters<typeof scrollWithin>[1] | null },
  section: AppSettingsSection,
  lead: boolean,
): void {
  const block = lead ? null : scroller.querySelector(`[data-settings-block="${section}"]`);
  if (!block) { scroller.scrollTop = 0; return; }
  // a block that already shows whole from the top stays where it is: scrolling it up would slice the rows above it
  const top = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  if (top + (block.offsetHeight ?? 0) <= scroller.clientHeight) scroller.scrollTop = 0;
  else scrollWithin(scroller, block);
}

/** Grok's scroll thumb, drawn by its own small component so a scroll re-renders two divs, not the pane. */
function ScrollThumb({ scroller, watch }: { scroller: RefObject<HTMLDivElement | null>; watch: string }) {
  const thumb = useScrollThumb(scroller, watch);
  if (!thumb) return null;
  return (
    <div role="presentation" className="settings-scrollbar" data-scrolling={thumb.scrolling ? "" : undefined}>
      <div style={{ top: thumb.top, height: thumb.height }} />
    </div>
  );
}

function useScrollThumb(scroller: RefObject<HTMLDivElement | null>, key: string) {
  const [thumb, setThumb] = useState<{ top: number; height: number; scrolling: boolean } | null>(null);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = (scrolling: boolean) => {
      const { scrollHeight, clientHeight, scrollTop } = element;
      if (scrollHeight <= clientHeight + 1) { setThumb(null); return; }
      const track = clientHeight - 6;
      const height = Math.max(20, (clientHeight / scrollHeight) * track);
      setThumb({ top: (scrollTop / (scrollHeight - clientHeight)) * (track - height), height, scrolling });
    };
    const onScroll = () => {
      measure(true);
      clearTimeout(timer);
      timer = setTimeout(() => measure(false), 800);
    };
    measure(false);
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure(false));
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      clearTimeout(timer);
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [scroller, key]);
  return thumb;
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const present = useIsPresent();
  const remoteActive = window.madaniDesktop?.remoteClient?.active === true;
  const ownerOrAdmin = useOwnerOrAdmin();
  const cloudHome = state.config?.cloudHome === true;

  const offered: Record<AppSettingsSection, boolean> = {
    general: true, appearance: true, texting: true, companion: true, remote: true, computer: true, logins: true, updates: true,
    advanced: true, apps: true, looks: true, bots: true, data: true, builder: true, about: true, engines: true, connections: true,
    skills: true, usage: true, backups: true, import: true, experimental: true, voice: true, transfer: vpsLinkAvailable(),
    desktopWorkspaces: Boolean(window.madaniDesktop?.environments),
    organization: Boolean(window.madaniDesktop?.organization),
    cloudAccount: Boolean(window.madaniDesktop?.cloudAccount || (window.madaniDesktop?.cloudPlan && cloudHome)),
    people: !window.madaniDesktop && !cloudHome,
    activity: !window.madaniDesktop && ownerOrAdmin === true,
    botAccess: Boolean(state.config?.team) && ownerOrAdmin === true,
    permissions: false,
  };
  offered.permissions = offered.botAccess || offered.activity;
  const has = (id: AppSettingsSection) => offered[id] && (!remoteActive || REMOTE_SECTIONS.includes(id));

  const paneShown = (pane: SettingsPane) => (pane !== "texting" || phoneAppEnabled()) && (!remoteActive || pane === "general" || pane === "voice" || pane === "texting" || pane === "computer");
  const panes = SETTINGS_PANES.filter((pane) => paneShown(pane.id) && pane.sections.some(has));
  const advancedPages = ADVANCED_PAGES.filter((page) => page.sections.some(has)).map((page) => page.id);

  // moving between panes and pages stays inside Settings: a store update would re-render the whole app under the sheet
  // on every click. The next request from outside (a link, a menu) wins again.
  const [localNav, setLocalNav] = useState<{ request: number; section: AppSettingsSection } | null>(null);
  const requested = localNav && localNav.request === state.appSettingsRequest ? localNav.section : state.appSettingsSection;
  const at = settingsLocation(has(requested) ? requested : remoteActive && requested === "remote" ? "companion" : "general");
  const pane = panes.some((entry) => entry.id === at.pane) ? at.pane : "general";
  // the Bots pane has no rail row of its own, but a bot's page opened from its panel shows it, selected, so the rail
  // still says where the sheet is
  const railPanes = panes.filter((entry) => entry.rail !== false || entry.id === pane);
  const page = pane === "advanced" && at.page && advancedPages.includes(at.page) ? at.page : undefined;
  const paneEntry = SETTINGS_PANES.find((entry) => entry.id === pane)!;
  useEffect(() => { trailNavigation("settings", { pane, page, section: requested }); }, [pane, page, requested]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // the sheet opens raw on its first pane; every later pane eases in
  const openedOn = useRef(pane);
  const paneSwapped = pane !== openedOn.current;

  // a pane's own pages (and Advanced features' pages) slide in over its list with Grok's wipe; another pane swaps at once
  const paneKey = `${pane}:${page ?? ""}`;
  const botTarget = useBotTarget();
  const botPages = (): SubPage[] => {
    const bot = botTarget?.kind === "bot" ? state.bots.find((entry) => entry.id === botTarget.id) : undefined;
    const top = targetPage(botTarget, bot);
    return top ? [top] : [];
  };
  const linkedPage = (section: AppSettingsSection): SubPage[] => {
    if (section === "bots") return botPages();
    const target = SECTION_PAGES[section];
    const place = settingsLocation(section);
    const home = place.page ? ADVANCED_PAGES.find((entry) => entry.id === place.page)?.sections : SETTINGS_PANES.find((entry) => entry.id === place.pane)?.sections;
    // the rail and Advanced's rows open a pane or page by its first section: that is its list, not one of its pages
    if (!target || !has(section) || home?.find(has) === section) return [];
    return [{ id: target.id, title: t(target.title) }];
  };
  const [sub, setSub] = useState<{ key: string; stack: SubPage[] }>(() => ({ key: paneKey, stack: linkedPage(requested) }));
  // on a phone Settings opens on its list of panes, unless it was asked for a particular place
  const phone = useMediaQuery(PHONE_SETTINGS);
  const [phoneList, setPhoneList] = useState(() => requested === "general");
  // a link to a section that lives on a pane's page lands on that page
  const [linked, setLinked] = useState(requested);
  if (linked !== requested) {
    setLinked(requested);
    setSub({ key: paneKey, stack: linkedPage(requested) });
    setPhoneList(false);
  }
  // a bot or group chat asked for from its panel: the Bots pane on it, at its row's page
  const [seenBot, setSeenBot] = useState(0);
  if (botTarget && botTarget.nonce !== seenBot) {
    setSeenBot(botTarget.nonce);
    chooseBotsScope(scopeOf(botTarget));
    if (pane === "bots") setSub({ key: paneKey, stack: botPages() });
  }
  useEffect(() => {
    if (botTarget) consumeBotTarget();
  }, [botTarget]);
  const stack = sub.key === paneKey ? sub.stack : [];

  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const keyFocus = useKeyFocus();
  const disclose: Disclose = (id) => {
    const open = folds[id] ?? false;
    return { id, open, onToggle: () => setFolds((current) => ({ ...current, [id]: !open })) };
  };

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const lead = paneEntry.sections.find(has) === requested || (page !== undefined && ADVANCED_PAGES.find((entry) => entry.id === page)?.sections.find(has) === requested)
      || SECTION_PAGES[requested] !== undefined;
    revealSettingsBlock(scroller, requested === "remote" ? "remote" : requested, lead && !keyFocus);
  }, [requested, pane, page, paneEntry, keyFocus]);

  const close = () => dispatch({ type: "toggleAppSettings", open: false });
  const go = (section: AppSettingsSection) => {
    setPhoneList(false);
    setLocalNav({ request: state.appSettingsRequest, section });
  };
  const reduced = useMotionReduced();

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();
    // a form dialog a row opens is portaled to the body, so a modal over the sheet counts too
    const nested = () => Boolean(dialog && ([...dialog.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
      .some((child) => child !== dialog && child.getClientRects().length)
      || [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some((other) => !other.contains(dialog) && !dialog.contains(other) && other.getClientRects().length)));
    const onKey = (event: KeyboardEvent) => {
      // a child editor or menu owns Escape and its focus trap, including while saving
      if (event.defaultPrevented || nested()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'),
      ).filter((element) => element.checkVisibility());
      if (focusable.length === 0) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !dialog.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  const phoneFocus = state.appSettingsPhonePairing;
  const computerPairs = currentPhonePairingTarget(cloudHome) === "computer";
  const remoteAccess: RemoteAccessCards = {
    client: <RemoteComputerSection hideWhenUnavailable />,
    // Security: the server decides who may pair (an owner or admin session), not this gate.
    pairing: <PhoneLinking remote={remoteActive} cloudHome={cloudHome} email={state.config?.profile?.email}>{(phone) => <ServerPairingCard phone={phone} cloudHome={cloudHome} focusRequest={computerPairs ? 0 : phoneFocus} team={state.config?.team?.name} teamPhoneBlocked={state.config?.managedPolicy?.remoteAccess === false ? t("policy.teamRemoteBlocked", { organization: state.config.managedPolicy.organizationName }) : null} simple />}</PhoneLinking>,
    desktopPairing: phoneAppEnabled() || state.config?.team ? null : <ServerPairingCard phone={null} cloudHome={cloudHome} simple />,
    elsewhere: <ServerPairingCard phone={null} cloudHome={cloudHome} elsewhere={{ connect: <RemoteComputerSection hideWhenUnavailable simple /> }} />,
    companion: remoteActive ? null : <CompanionSection profileEmail={state.config?.profile?.email} focusRequest={computerPairs ? phoneFocus : 0} />,
  };
  const cloudAccount = has("cloudAccount") && !remoteActive
    ? <CloudAccountSettings linkRequest={state.appSettingsCloudLink} cloudHome={cloudHome} teamHome={state.config?.team}
      onConnectPhone={phoneAppEnabled() ? () => dispatch(phonePairingSettingsAction()) : undefined}
      onSignIn={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} />
    : null;

  const renderBody = (at: AdvancedPage | undefined) => {
    switch (pane) {
      case "general": return <GeneralPane has={has} remoteActive={remoteActive} />;
      case "voice": return <VoiceInputSettings />;
      case "texting": return <TextingPane has={has} remoteAccess={remoteAccess} />;
      case "computer": return <ComputerPane has={has} remoteActive={remoteActive} remoteAccess={remoteAccess} transfer={has("transfer") ? <TransferSettings /> : null} />;
      case "permissions": return <PermissionsPane has={has} />;
      case "vault": return <VaultPane />;
      case "models": return <ModelsPane has={has} disclose={disclose} connections={<AdminOnly><KeysPage /><SlackWorkspaceCard /></AdminOnly>} />;
      case "bots": return <BotsPane />;
      case "usage": return <UsagePane has={has} cloudAccount={cloudAccount} />;
      case "updates": return <UpdatesPane />;
      case "advanced": return at
        ? <AdvancedPageView page={at} has={has} remoteActive={remoteActive} peopleOpen={requested === "people"} />
        : <AdvancedIndex pages={advancedPages} remoteActive={remoteActive} onOpen={(next) => go(ADVANCED_PAGES.find((entry) => entry.id === next)!.sections.find(has)!)} />;
    }
  };

  const headingId = `settings-panel-${pane}-heading`;
  // one pane's header and scrolling body; the outgoing copy of a wipe is drawn without ids, refs or focus
  const layer = (key: string, live: boolean) => {
    const { at, pages } = JSON.parse(key) as { at: AdvancedPage | null; pages: SubPage[] };
    const top = pages.at(-1);
    const nav = {
      at: top?.id,
      stack: pages,
      open: (id: string, title: string) => setSub({ key: paneKey, stack: [...pages, { id, title }] }),
      back: () => setSub({ key: paneKey, stack: pages.slice(0, -1) }),
    };
    // a bot's page opened from its panel goes back to the panel, not to a second list of the bot's settings
    const onBack = top && pane === "bots" && pages.length === 1 ? close : top ? nav.back : at ? () => go("advanced") : phone ? () => setPhoneList(true) : undefined;
    return (
      <>
        <PaneHeader
          title={top?.title ?? (at ? advancedTitle(at) : t(paneEntry.labelKey))}
          headingId={live ? headingId : undefined}
          onBack={onBack}
          backLabel={!top && at ? t("settings.advanced.back") : !top && phone ? t("settings.title") : undefined}
        >
          {pane === "vault" && !top && <div data-settings-header-actions=""><VaultNewItem /></div>}
        </PaneHeader>
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div ref={live ? scrollRef : undefined} data-wipe-scroll="" data-settings-scroll={live ? "" : undefined} className="settings-scroll">
            <div className={cn("settings-pane", SIMPLE_BUTTONS, "[&_.uppercase]:normal-case [&_.uppercase]:tracking-normal")}>
              <SubPageContext.Provider value={nav}><PanelSections className="contents">{renderBody(at ?? undefined)}</PanelSections></SubPageContext.Provider>
            </div>
          </div>
          {live && <ScrollThumb scroller={scrollRef} watch={`${paneKey}:${pages.length}`} />}
        </div>
      </>
    );
  };

  const listShown = phone && phoneList;
  const nav = (
    <nav aria-label={t("settings.grok.navAria")} className="settings-nav">
      <div className="settings-phone-head">
        <h2 className="settings-phone-title">{t("settings.title")}</h2>
        <button type="button" onClick={close} aria-label={t("settings.grok.close")} className="settings-phone-close">
          <Icon name="close" size={18} />
        </button>
      </div>
      {RAIL_GROUPS.map((group) => {
        const entries = group.panes.flatMap((id) => railPanes.filter((entry) => entry.id === id));
        if (!entries.length) return null;
        return (
          <div key={group.id} role="group" aria-label={t(group.labelKey)} data-settings-rail-group={group.id} className="settings-nav-group">
            <p aria-hidden="true" className="settings-nav-label">{t(group.labelKey)}</p>
            <div className="settings-nav-list">
              {entries.map((entry) => {
                const current = entry.id === pane && !phone;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    data-settings-page={entry.id}
                    aria-current={current ? "page" : undefined}
                    aria-controls={current ? `settings-panel-${entry.id}` : undefined}
                    onClick={() => go(entry.sections.find(has)!)}
                    className="settings-nav-item"
                  >
                    <SettingGlyph name={RAIL_GLYPH[entry.id]} size={phone ? 24 : 18} className="-mx-px" mono />
                    <span>{t(entry.labelKey)}</span>
                    <Icon name="chevron-right" size={14} className="settings-nav-chevron" />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
  const panel = (
    <section id={`settings-panel-${pane}`} aria-labelledby={headingId} className="settings-panel">
      <button type="button" onClick={close} aria-label={t("settings.grok.close")} className="settings-close">
        <Icon name="close" size={14} />
      </button>
      {/* a pane switch is one short fade and rise of the new pane; the rail's highlight and the sheet stay raw */}
      <div key={pane} className={cn("flex min-h-0 flex-1 flex-col", paneSwapped && !phone && "settings-pane-swap")}>
        <WipeStack at={JSON.stringify({ at: page ?? null, pages: stack })} depth={(page ? 1 : 0) + stack.length} group={pane} layer={layer} />
      </div>
    </section>
  );
  // on a phone the list and a pane are one screen each: a pane pushes in from the end, the list comes back from the start
  const phoneView = (view: "list" | "pane") => (
    <MotionDiv
      key={view}
      custom={view === "pane" ? 1 : -1}
      variants={reduced ? PHONE_FADE : PHONE_PUSH}
      initial="enter"
      animate="center"
      exit="exit"
      className="settings-phone-view"
    >
      {view === "list" ? nav : panel}
    </MotionDiv>
  );

  return (
    <div
      className="settings-scrim"
      data-settings-sheet
      data-settings-look="simple"
      data-leaving={present ? undefined : ""}
      inert={!present}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <MotionDiv
        aria-hidden="true"
        className="settings-backdrop"
        initial={false}
        exit={{ opacity: 0, transition: SHEET_EXIT }}
        onMouseDown={close}
      />
      <MotionDiv
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        tabIndex={-1}
        data-phone-view={phone ? (listShown ? "list" : "pane") : undefined}
        className="settings-dialog"
        // the sheet opens with the app's one dialog motion (overlays.css) and fades out on close; on a phone its drill-in slides
        initial={false}
        exit={sheetLeave()}
      >
        <div className="settings-layout">
          {phone ? (
            <AnimatePresence initial={false} custom={listShown ? -1 : 1}>
              {phoneView(listShown ? "list" : "pane")}
            </AnimatePresence>
          ) : <>{nav}{panel}</>}
        </div>
      </MotionDiv>
    </div>
  );
}

/** Linking a phone; the caller lays out the pieces. */
function PhoneLinking({ remote, cloudHome, email, children }: { remote: boolean; cloudHome: boolean; email?: string; children: (phone: PhoneParts | null) => ReactNode }) {
  return <MobilePairingCard remote={remote} cloudHome={cloudHome} email={email}>{children}</MobilePairingCard>;
}

const PHONE_SETTINGS = "(max-width: 639.98px)";

const PHONE_PUSH = {
  enter: (direction: number) => ({ x: direction > 0 ? WIPE.pushFrom : WIPE.popFrom, zIndex: direction > 0 ? 1 : 0 }),
  center: { x: "0%", transition: { duration: WIPE.duration + 0.06, ease: WIPE.ease } },
  exit: (direction: number) => (direction > 0
    ? { x: WIPE.popFrom, zIndex: 0, transition: { duration: WIPE.duration + 0.06, ease: WIPE.ease } }
    : { x: WIPE.pushFrom, zIndex: 1, transition: { duration: WIPE.duration + 0.06, ease: WIPE.ease } }),
};

const PHONE_FADE = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: REDUCED },
  exit: { opacity: 0, transition: REDUCED },
};
