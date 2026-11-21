import { useId, useRef, useState, type ReactNode } from "react";
import { useSettledReveal } from "./settled-reveal";
import { cn } from "@/lib/cn";
import { AnimatePresence } from "motion/react";
import { openSignIn } from "@/lib/sign-in-sheet";
import { importFirst, previousOpenAt } from "@/lib/import-first";
import { ChevronRight } from "../icons";
import { useStore, type AppSettingsSection } from "@/state/store";
import { ADVANCED_PAGES, type AdvancedPage } from "@/lib/open-settings";
import { t, tPreferred, tOptional } from "@/lib/i18n";
import { HELP_CENTER_URL, appVersion, openExternalLink } from "@/lib/app-links";
import { openFeedback } from "@/lib/feedback-sheet";
import { skillsLibraryEnabled } from "@/lib/feature-flags";
import { setColorUserBubbles, useColorUserBubbles } from "@/lib/user-bubble-preference";
import { resolveSkin } from "@/lib/skins";
import { setDressUp, useDressUp } from "@/lib/halloween-dress";
import type { LocaleKey } from "@/locales";
import { productName } from "../lib/brand";
import { AccountsSheet, useAccounts } from "./AccountMenu";
import { AboutDialog } from "./AboutDialog";
import { AppVersionRow } from "./AppVersionRow";
import { AdminOnly } from "./AdminOnly";
import { AmbientRows } from "./AmbientSettingsRows";
import { BotDefaultsRows } from "./SettingsBots";
import { ActivitySection } from "./ActivitySection";
import { ArchivedBotsPanel } from "./ArchivedBotsPanel";
import { AttachmentStorageSettings } from "./AttachmentStorageSettings";
import { AccessOverview } from "./bot-access/AccessOverview";
import { BuiltInBrowserRow, ServerSitesRow } from "./BrowserSettingsRows";
import { CloudPlanRow, useCloudPlan } from "./ProIntroduction";
import { buyOfferAllowed } from "@/lib/cloud-plan";
import { CloudUsageDetails, CloudUsageSummaryView, useCloudUsageSettings } from "./CloudUsageMeter";
import { CompanyBackupSettings } from "./CompanyBackupSettings";
import { DiagnosticsRow } from "./DiagnosticsRow";
import { UsageLogRow } from "./UsageLogRow";
import { EnginesSettings } from "./EnginesSettings";
import { ImportSettings } from "./ImportSettings";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";
import { LocalComputerSection } from "./LocalComputerSection";
import { ADD_PLACE_PAGE, CLOUD_SETUP_PAGE, PHONE_ADVANCED_PAGE, PLACE_INSTALL_PAGE, PRIVATE_SETUP_PAGE } from "./settings-page-ids";
import { AddPlacePage, isAddPlacePage } from "./AddPlaceSettings";
import { CloudDesktopKeys } from "./keys/KeysPage";
import { InstallOnVpsGroup, WorkspacesGroup } from "./WorkspacesSettings";
import { LoginsSettings } from "./LoginsSettings";
import { McpServersPanel } from "./McpServersPanel";
import { NotificationRows } from "./NotificationSettingsRows";
import { OpenAtLoginRow } from "./OpenAtLoginRow";
import { AppMenuEntryRow } from "./AppMenuEntryRow";
import { OrganizationSettings } from "./OrganizationSettings";
import { PeopleSection } from "./PeopleSection";
import { PlanUsageSummary } from "./PlanUsage";
import { BatteryCard } from "./usage/BatteryCard";
import { ProviderSummary } from "./usage/ProviderSummary";
import { UsageGraph } from "./usage/UsageGraph";
import { ProfileAvatar, ProfileFields } from "./ProfileSettings";
import { SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { PixelIcon } from "./ui/PixelIcon";
import { RoutineWakeRow } from "./routines/RoutineWakeRow";
import { Card as RowsCard, FormDialog, ItemRow, NavRow, SwitchRow, useSubPage } from "./ListRows";
import { DataSharingRows } from "./DataSharingRows";
import { SettingsSelect } from "./SettingsSelect";
import { personFace, useServerUpdateItem } from "./SidebarProfileMenu";
import { SkillsSection } from "./SkillsSection";
import { TalkShortcutRow } from "./TalkShortcutRow";
import { ThemeRow, useSkinChoice } from "./ThemeRow";
import { UsageSection } from "./UsageSection";
import { WorkspaceBackupSettings } from "./WorkspaceBackupSettings";
import { ModelDirectory } from "./models/ModelDirectory";
import { AiCards } from "./onboarding/AiCards";
import { reportsUsage, useEngineLimits } from "@/lib/limit-resets";
import {
  BotOrderRow, ExperimentalFeaturesRow, FollowUpRow, LanguageRow, QuickUpdatesRow, SendKeyRow, TalkingStyleRow,
} from "./AppSettingsRows";

export type Has = (id: AppSettingsSection) => boolean;
/** `desktopPairing` is this server's code for another computer, shown under Computer while the phone page (where it
 * otherwise lives, beside the phone's ways) is hidden. */
export type RemoteAccessCards = Record<"client" | "pairing" | "companion", ReactNode> & { desktopPairing?: ReactNode; elsewhere?: ReactNode };
export type Disclose = (id: string) => { id: string; open: boolean; onToggle: () => void };

/** The pages a pane's rows open, by the section a deep link names: a link to one lands on that page. */
export const SECTION_PAGES: Partial<Record<AppSettingsSection, { id: string; title: LocaleKey }>> = {
  import: { id: "import", title: "settings.import.rowTitle" },
  remote: { id: "elsewhere", title: "settings.simple.computer.elsewhere" },
  desktopWorkspaces: { id: "elsewhere", title: "settings.simple.computer.elsewhere" },
  botAccess: { id: "botAccess", title: "settings.section.botAccess" },
  activity: { id: "activity", title: "settings.section.activity" },
  connections: { id: "keys", title: "settings.section.connections" },
  cloudAccount: { id: "plan", title: "settings.section.cloudAccount" },
  skills: { id: "skills", title: "settings.section.skills" },
  organization: { id: "organization", title: "settings.section.organization" },
  people: { id: "people", title: "settings.section.people" },
  backups: { id: "backups", title: "settings.section.backups" },
};

/** A row that opens one of its pane's pages. */
function PageRow({ page, title, value, hint, ...rest }: { page: string; title: string; value?: ReactNode; hint?: ReactNode; "data-settings-open"?: string }) {
  const sub = useSubPage();
  return <NavRow {...rest} data-panel-page={page} title={title} value={value} hint={hint} onClick={() => sub.open(page, title)} />;
}

/** Grok's account card: the person's initials or photo, their name and the account they are signed in with, then Add
 * account and Sign Out as pills (or Add, for a name, where nobody signs in); the name opens a small form. */
export function AccountRows() {
  const { state } = useStore();
  const accounts = useAccounts();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const profile = state.config?.profile;
  const active = accounts.view?.active ?? null;
  const name = profile?.name?.trim() || active?.email?.split("@")[0] || "";
  const email = active?.email ?? profile?.email?.trim() ?? "";
  // the account signed in here lends its photo (or the avatar picked on it), as the sidebar shows
  const face = active ? personFace(profile, active) : null;
  const who = (
    <>
      <ProfileAvatar small profile={{ ...profile, name, email }} face={face} />
      <div className="min-w-0 flex-1 text-start">
        <div data-row-title="" className="truncate text-[13px] leading-[18px] text-ink">{name || t("settings.simple.account.noName")}</div>
        {email && <div data-row-hint="" className="truncate text-[12px] leading-4 text-ink-secondary">{email}</div>}
      </div>
    </>
  );
  return (
    <>
      {!active ? (
        // nobody signs in here: the whole row opens the name form, as a panel row does
        <button type="button" data-settings-account="" data-settings-open="profile" onClick={() => setEditing(true)}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg text-start outline-none hover:bg-ink/[0.035] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
          {who}
          <span data-panel-value="" className="shrink-0 text-[13px] leading-[18px] text-ink-secondary">{t(name ? "settings.simple.account.edit" : "settings.simple.account.add")}</span>
          <ChevronRight size={14} aria-hidden="true" className="-mr-0.5 shrink-0 text-ink-tertiary rtl:-scale-x-100" />
        </button>
      ) : (
        <div data-settings-account="" className="flex min-w-0 items-center gap-2.5">
          <button type="button" data-settings-open="profile" aria-label={t("settings.w6.group.aboutYou")} onClick={() => setEditing(true)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
            {who}
          </button>
          <div className="flex shrink-0 items-center gap-1.5">
            {window.madaniDesktop?.accounts && accounts.noRail && <button type="button" data-settings-open="add-account" className="ui-button" onClick={() => setAdding(true)}>{t("settings.grok.account.add")}</button>}
            {accounts.openSheet && <button type="button" data-settings-open="account" className="ui-button" onClick={() => accounts.openSheet?.()}>{t("settings.rows.account")}</button>}
            <button type="button" data-settings-open="sign-out" className="ui-button" onClick={() => accounts.signOut(active.id)}>{t("settings.grok.account.signOut")}</button>
          </div>
        </div>
      )}
      {/* signed out: sign in continues in the browser for its context (the account context redirect), never an in-app form */}
      {!active && window.madaniDesktop?.accounts && <NavRow data-settings-open="sign-in" title={t("accounts.signIn")} onClick={() => window.madaniDesktop?.cloudAccount?.continueInBrowser ? openSignIn() : setAdding(true)} />}
      <AnimatePresence>{editing && (
        <FormDialog key="profile" data-panel-modal="profile" title={t("settings.w6.group.aboutYou")} width={460} onClose={() => setEditing(false)}>
          <div data-settings-look="simple" className="-mx-2 flex flex-col"><ProfileFields face={face} /></div>
        </FormDialog>
      )}</AnimatePresence>
      {(adding || accounts.sheet) && (
        <AccountsSheet
          adding={adding ? "" : accounts.sheet?.email ?? null}
          note={adding ? null : accounts.sheet?.note ?? null}
          onClose={() => { setAdding(false); accounts.closeSheet(); }}
        />
      )}
      {accounts.signOutConfirm}
    </>
  );
}

/** Grok's Accent select. Here it decides whether your messages wear the bot's colour. */
export function AccentRow() {
  const bot = useColorUserBubbles();
  return (
    <SettingRow icon="droplet" title={t("settings.accent.title")} subtitle={tOptional("settings.docs.accent.hint")}>
      <SettingsSelect
        variant="segmented"
        value={bot ? "bot" : "neutral"}
        aria-label={t("settings.accent.title")}
        options={[{ value: "bot", label: t("settings.accent.bot") }, { value: "neutral", label: t("settings.accent.neutral") }]}
        onChange={(event) => setColorUserBubbles(event.target.value === "bot")}
      />
    </SettingRow>
  );
}

/** The Halloween look's bats and hats, while that look is on. */
function DressUpRow() {
  const dressed = useDressUp();
  if (resolveSkin(useSkinChoice()) !== "halloween") return null;
  return <SwitchRow title={t("settings.skin.dressUp.title")} checked={dressed} onChange={() => setDressUp(!dressed)} />;
}

export function GeneralPane({ has, remoteActive }: { has: Has; remoteActive: boolean }) {
  const { at } = useSubPage();
  const { state } = useStore();
  if (at === "import") return <AdminOnly><ImportSettings /></AdminOnly>;
  const lead = importFirst({ completedAt: state.config?.onboarding?.completedAt, lastOpenAt: previousOpenAt(), bots: state.bots?.length ?? 0 });
  const bring = has("import") && (
    <SettingsGroup label={tPreferred("settings.docs.bring", "settings.section.import")} block="import">
      <SettingsRows><ImportRow /></SettingsRows>
    </SettingsGroup>
  );
  return (
    <>
      {lead && bring}
      {!remoteActive && has("general") && (
        <SettingsGroup label={tPreferred("settings.docs.you", "settings.group.account")} block="general">
          <SettingsRows>
            <AccountRows />
          </SettingsRows>
        </SettingsGroup>
      )}
      <SettingsGroup label={tPreferred("settings.docs.look", "settings.section.appearance")} block="appearance" footnote={t("settings.docs.followsYou")}>
        <SettingsRows>
          <ThemeRow />
          <DressUpRow />
          <AccentRow />
          <TalkingStyleRow />
          <LanguageRow simple />
          <BotOrderRow />
          <AmbientRows />
        </SettingsRows>
      </SettingsGroup>
      {!remoteActive && (
        <SettingsGroup label={tPreferred("settings.docs.typing", "settings.simple.group.system")} block="system">
          <SettingsRows>
            <TalkShortcutRow />
            <SendKeyRow simple />
            <FollowUpRow simple />
            <QuickUpdatesRow />
            <OpenAtLoginRow simple />
            <AppMenuEntryRow />
          </SettingsRows>
        </SettingsGroup>
      )}
      <SettingsGroup label={tPreferred("settings.docs.notifications", "notifications.title")} block="notifications">
        <SettingsRows><NotificationRows /></SettingsRows>
      </SettingsGroup>
      {!remoteActive && (
        <SettingsGroup label={t("settings.dataSharing.title")} block="data-sharing">
          <SettingsRows><DataSharingRows /></SettingsRows>
        </SettingsGroup>
      )}
      {!lead && bring}
    </>
  );
}

/** The rarely needed rows, folded away under a quiet "advanced" line at the end of a pane. */
export function AdvancedFold({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return (
    <section data-settings-block="advanced-fold" className="flex flex-col gap-1.5">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} data-settings-fold=""
        className="group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-start outline-none hover:bg-ink/[0.035] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
        <span className="min-w-0 flex-1">
          <span data-row-title="" className="block text-ink">{t("settings.docs.advanced")}</span>
          <span data-row-hint="" className="block text-ink-secondary">{t("settings.docs.advancedHint")}</span>
        </span>
        <ChevronRight size={14} aria-hidden="true" className="-me-0.5 shrink-0 text-ink-tertiary transition-[rotate] duration-150 ease-out group-aria-expanded:rotate-90 motion-reduce:transition-none rtl:-scale-x-100" />
      </button>
      <div id={id} hidden={!open} className="flex flex-col gap-6">{children}</div>
    </section>
  );
}

/** Grok's Import row: what it brings and Start Import, which opens the import page. */
function ImportRow() {
  const sub = useSubPage();
  return (
    <SettingRow icon={<PixelIcon name="parcel" size={24} />} title={t("settings.import.rowTitle")} subtitle={t("settings.import.rowHint")}>
      <button type="button" data-panel-page="import" className="ui-button" onClick={() => sub.open("import", t("settings.import.rowTitle"))}>{t("settings.w6c.import.start")}</button>
    </SettingRow>
  );
}

/** Phone pairing and the paired devices' access, all on the pane: the code to scan or type first, then the phones. */
export function TextingPane({ has, remoteAccess }: { has: Has; remoteAccess: RemoteAccessCards }) {
  const { at } = useSubPage();
  const advanced = at === PHONE_ADVANCED_PAGE;
  if (!advanced && !has("companion")) return null;
  // one tree for the pane and its Advanced page: going there and back keeps the code, the phones and their reads as they
  // are, so the pane never loads (and moves) again
  return <PhonePaneBody advanced={advanced}><div hidden={advanced} className={advanced ? undefined : "contents"}>{remoteAccess.pairing}</div>{remoteAccess.companion}</PhonePaneBody>;
}

/** The phone pane's parts (the code, the phones, the computer's own link) each load on their own: the pane shows once
 * they have, so nothing appears and moves the rows under it on open. */
function PhonePaneBody({ advanced, children }: { advanced: boolean; children: ReactNode }) {
  const block = useRef<HTMLDivElement>(null);
  const shown = useSettledReveal(block);
  return <div ref={block} data-settings-block={advanced ? "companion-advanced" : "companion"} data-settled={shown ? "" : undefined} className={cn("flex flex-col gap-5", !shown && "invisible")}>{children}</div>;
}

export function ComputerPane({ has, remoteAccess, transfer, remoteActive = false }: { has: Has; remoteAccess: RemoteAccessCards; transfer?: ReactNode; remoteActive?: boolean }) {
  const sub = useSubPage();
  const { at } = sub;
  const [more, setMore] = useState(false);
  if (at === "computers" || at === PRIVATE_SETUP_PAGE) return <div data-settings-block="computer" className="flex flex-col gap-5"><AdminOnly><LocalComputerSection /></AdminOnly></div>;
  if (at === CLOUD_SETUP_PAGE) return <AdminOnly><CloudDesktopKeys /></AdminOnly>;
  if (isAddPlacePage(at)) return <AddPlacePage />;
  if (at === "elsewhere") return <div data-settings-block="remote" className="flex flex-col gap-5">{remoteAccess.elsewhere}</div>;
  const elsewhere = has("companion") || has("desktopWorkspaces");
  return (
    <>
      <WorkspacesGroup onAdd={() => sub.open(ADD_PLACE_PAGE, t("placeSetup.title"))} />
      {!remoteActive && <InstallOnVpsGroup onStart={() => sub.open(PLACE_INSTALL_PAGE, t("placeSetup.relay"))} />}
      <AdvancedFold open={more} onToggle={() => setMore(!more)}>
        {has("computer") && (
          <SettingsRows>
            <PageRow page="computers" title={t("settings.rows.desktops")} hint={t("settings.hint.desktops")} />
            {elsewhere && <PageRow page="elsewhere" title={t("settings.simple.computer.elsewhere")} hint={t("settings.hint.elsewhere")} />}
          </SettingsRows>
        )}
        <RoutineWakeRow />
        {has("computer") && (
          <SettingsGroup label={t("settings.grok.group.browser")} block="browser">
            <SettingsRows>
              <BuiltInBrowserRow />
              <ServerSitesRow />
            </SettingsRows>
          </SettingsGroup>
        )}
        {transfer}
      </AdvancedFold>
    </>
  );
}

export function PermissionsPane({ has }: { has: Has }) {
  const { at } = useSubPage();
  if (at === "botAccess") return <div data-settings-block="botAccess" className="contents"><AccessOverview /></div>;
  if (at === "activity") return <div data-settings-block="activity" className="contents"><ActivitySection /></div>;
  return (
    <RowsCard label={tPreferred("settings.docs.permissions", "settings.section.botAccess")} data-settings-block="permissions">
      {has("botAccess") && <PageRow page="botAccess" title={t("settings.section.botAccess")} hint={t("settings.hint.botAccess")} />}
      {has("activity") && <PageRow page="activity" title={t("settings.section.activity")} hint={t("settings.hint.activity")} />}
    </RowsCard>
  );
}

/** Grok's Vault: the logins bots sign in with, and 1Password. */
export function VaultPane() {
  return <LoginsSettings />;
}

const versionTitle = () => `${productName()} ${appVersion()}`;

function ServerUpdatesRow() {
  const entry = useServerUpdateItem(true);
  if (!entry) return null;
  const status = entry.phase === "idle" ? undefined : [entry.label, entry.item.subtitle].filter(Boolean).join(" ");
  const action = entry.phase === "available" ? t("settings.simple.updates.seeRelease")
    : entry.phase === "reload" ? t("settings.simple.updates.reload")
      : entry.phase === "checking" ? t("common.checking") : t("settings.updates.check");
  return <NavRow data-settings-open="server-update" title={versionTitle()} hint={status} value={action} drill={false} disabled={entry.item.disabled} onClick={entry.item.onSelect} />;
}

export function UpdatesPane() {
  const { at } = useSubPage();
  if (at === "diagnostics") return <SettingsRows><DiagnosticsRow simple /><UsageLogRow /></SettingsRows>;
  return (
    <>
      <SettingsGroup label={t("settings.grok.group.version")} block="updates">
        <SettingsRows>
          <AppVersionRow fallback={<ServerUpdatesRow />} />
        </SettingsRows>
      </SettingsGroup>
      <HelpGroup />
    </>
  );
}

function HelpGroup() {
  const [about, setAbout] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  return (
    <RowsCard label={t("settings.w6.group.help")} data-settings-block="about">
      <NavRow data-settings-open="about" title={t("settings.advanced.about.about")} onClick={() => setAbout(true)} />
      <NavRow data-settings-open="shortcuts" title={t("settings.advanced.about.shortcuts")} onClick={() => setShortcuts(true)} />
      <NavRow data-settings-open="help" title={t("settings.advanced.about.help")} external onClick={() => void openExternalLink(HELP_CENTER_URL)} />
      <NavRow data-settings-open="feedback" title={t("settings.advanced.about.feedback")} onClick={openFeedback} />
      <PageRow data-settings-open="diagnostics" page="diagnostics" title={t("settings.diagnostics.title")} hint={t("settings.hint.diagnostics")} />
      <AboutDialog open={about} onClose={() => setAbout(false)} />
      <KeyboardShortcutsModal open={shortcuts} onClose={() => setShortcuts(false)} />
    </RowsCard>
  );
}

export { ADVANCED_PAGES, type AdvancedPage } from "@/lib/open-settings";

const ADVANCED_TITLES: Record<AdvancedPage, LocaleKey> = {
  apps: "settings.w6.apps.title",
  team: "settings.w6.team.title",
  data: "settings.w6.data.title",
};

export const advancedTitle = (page: AdvancedPage) => t(ADVANCED_TITLES[page]);

const ADVANCED_HINTS: Record<AdvancedPage, LocaleKey> = {
  apps: "settings.hint.appsPage",
  team: "settings.hint.team",
  data: "settings.hint.data",
};

/** The first screen of Advanced: the rarer pages, and the archived bots while there are any. */
export function AdvancedIndex({ pages, remoteActive, onOpen }: { pages: readonly AdvancedPage[]; remoteActive: boolean; onOpen: (page: AdvancedPage) => void }) {
  const { state } = useStore();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const archived = remoteActive ? [] : state.bots.filter((bot) => bot.hidden && !bot.movedTo);
  return (
    <>
      <RowsCard label={t("settings.docs.everythingElse")} data-settings-block="advanced-pages">
        {ADVANCED_PAGES.filter((page) => pages.includes(page.id)).map((page) => (
          <NavRow key={page.id} data-settings-advanced={page.id} title={advancedTitle(page.id)} hint={t(ADVANCED_HINTS[page.id])} onClick={() => onOpen(page.id)} />
        ))}
        {archived.length > 0 && <NavRow data-settings-open="archived" title={t("settings.advanced.bots.archived")} hint={t("settings.hint.archived")} value={archived.length} onClick={() => setArchivedOpen(true)} />}
      </RowsCard>
      {archivedOpen && <ArchivedBotsPanel bots={archived} onClose={() => setArchivedOpen(false)} onRestored={() => {}} />}
    </>
  );
}

function AppsPage({ has }: { has: Has }) {
  const { state, dispatch } = useStore();
  const { at } = useSubPage();
  const skills = has("skills") && skillsLibraryEnabled(state.config);
  if (at === "mcp") return <div data-settings-block="mcp" className="contents"><AdminOnly><McpServersPanel embedded rows /></AdminOnly></div>;
  if (at === "skills") return <div data-settings-block="skills" className="contents"><SkillsSection /></div>;
  return (
    <>
      <RowsCard label={tPreferred("settings.docs.appsTools", "settings.w6.apps.title")} data-settings-block="apps">
        <NavRow data-settings-open="apps" title={t("settings.advanced.apps.connected.title")} hint={t("settings.hint.apps")} onClick={() => dispatch({ type: "togglePlugins", open: true, surface: "apps" })} />
        <PageRow page="mcp" title={t("settings.advanced.apps.mcp")} hint={t("settings.hint.mcp")} />
        {skills && <PageRow page="skills" title={t("settings.section.skills")} hint={t("settings.hint.skills")} />}
      </RowsCard>
      <SettingsGroup label={t("settings.apps.learning")} block="builder">
        <div data-settings-block="experimental" className="contents">
          <ExperimentalFeaturesRow />
        </div>
      </SettingsGroup>
    </>
  );
}

/** Grok's Usage & Billing pane: a card per engine limit, the Cloud's meters, then the breakdown and the plan as rows. */
export function UsagePane({ has, cloudAccount }: { has: Has; cloudAccount: ReactNode }) {
  const { at } = useSubPage();
  const { usage, upgrade, dialog } = useCloudUsageSettings();
  const plan = useCloudPlan();
  // while the plan row offers madani cloud, a second madani cloud row would only repeat it; a subscriber manages it there
  const subscribed = plan !== null && plan.view.kind !== "signed-out" && plan.view.kind !== "removed" && !buyOfferAllowed(plan.view);
  const limits = useEngineLimits().filter(reportsUsage);
  if (at === "breakdown") {
    return (
      <div className="flex flex-col gap-5">
        {!usage && <AdminOnly note="settings.adminOnly.usage"><PlanUsageSummary /></AdminOnly>}
        {usage && <CloudUsageDetails usage={usage} upgrade={upgrade} />}
        {has("usage") && <AdminOnly note="settings.adminOnly.usage"><UsageSection /></AdminOnly>}
      </div>
    );
  }
  if (at === "plan") return <div data-settings-block="cloudAccount" className="flex flex-col gap-5">{cloudAccount}</div>;
  return (
    <>
      <ProviderSummary limits={limits} />
      {has("usage") && <AdminOnly note="settings.adminOnly.usage"><BatteryCard version={0} /><UsageGraph /></AdminOnly>}
      {/* no limits yet: one quiet line in the same card as the breakdown, never a greyed-out row */}
      {((!limits.length && !usage) || usage || has("usage")) && (
        <RowsCard label={t("settings.docs.usageMore")} data-settings-block={!limits.length && !usage ? "usage" : undefined}>
          {!limits.length && !usage && <ItemRow title={t("settings.usage.empty.title")} hint={t("settings.s2.usage.emptyHint")} />}
          {(usage || has("usage")) && <PageRow page="breakdown" title={t("settings.usage.breakdown")} hint={t("settings.hint.breakdown")} />}
        </RowsCard>
      )}
      {usage && <div data-settings-block="cloudUsage" className="scroll-mt-4"><CloudUsageSummaryView usage={usage} upgrade={upgrade}>{dialog}</CloudUsageSummaryView></div>}
      {has("cloudAccount") && (
        <SettingsGroup label={t("settings.simple.billing.plan")} block="cloudAccount">
          <SettingsRows>
            <CloudPlanRow place="plan" usage={usage} upgrade={upgrade} />
            {subscribed && cloudAccount && <PageRow page="plan" title={t("settings.section.cloudAccount")} />}
          </SettingsRows>
        </SettingsGroup>
      )}
    </>
  );
}

function TeamPage({ has }: { has: Has }) {
  const { at } = useSubPage();
  if (at === "organization") return <div data-settings-block="organization" className="contents"><OrganizationSettings /></div>;
  if (at === "people") return <RowsCard data-settings-block="people"><PeopleSection /></RowsCard>;
  return (
    <RowsCard label={tPreferred("settings.docs.team", "settings.w6.team.title")} data-settings-block="team">
      {has("organization") && <PageRow page="organization" title={t("settings.section.organization")} hint={t("settings.hint.organization")} />}
      {has("people") && <PageRow page="people" title={t("settings.section.people")} hint={t("settings.hint.people")} />}
    </RowsCard>
  );
}

function DataPage({ has }: { has: Has }) {
  const { at } = useSubPage();
  if (at === "attachments") return <SettingsRows><AttachmentStorageSettings /></SettingsRows>;
  if (at === "backups") return <div data-settings-block="backups" className="flex flex-col gap-5"><AdminOnly><WorkspaceBackupSettings /><CompanyBackupSettings /></AdminOnly></div>;
  return (
    <>
      <SettingsGroup label={tPreferred("settings.docs.yourData", "settings.w6.data.title")} block="data">
        <SettingsRows>
          <PageRow page="attachments" title={t("settings.attachments.title")} hint={t("settings.hint.attachments")} />
          {has("backups") && <PageRow page="backups" title={t("settings.section.backups")} hint={t("settings.hint.backups")} />}
        </SettingsRows>
      </SettingsGroup>
    </>
  );
}

/** Models' top: the same grid of popular AIs as the first run and the Connect an AI dialog; its link goes to the
 * directory just under it. */
function ConnectAiCards() {
  const toDirectory = () => {
    const search = document.querySelector<HTMLInputElement>("[data-model-directory-search]");
    search?.scrollIntoView({ block: "center" });
    search?.focus({ preventScroll: true });
  };
  return (
    <RowsCard label={t("onboarding.meet.connectAi")} data-settings-block="connect-ai">
      <div className="p-2"><AiCards tested={null} onMore={toDirectory} /></div>
    </RowsCard>
  );
}

/** Model providers and their sign-ins and API keys: what every bot's model picker draws from. */
export function ModelsPane({ has, disclose, connections }: { has: Has; disclose: Disclose; connections: ReactNode }) {
  const { at } = useSubPage();
  if (at === "keys") return <div data-settings-block="connections" className="contents"><AdminOnly>{connections}</AdminOnly></div>;
  if (at) return <div data-settings-block="engines" className="contents"><AdminOnly><EnginesSettings simple more={disclose("ai-more")} /></AdminOnly></div>;
  return (
    <>
      {has("engines") && <AdminOnly><ConnectAiCards /></AdminOnly>}
      {has("engines") && <AdminOnly><ModelDirectory /></AdminOnly>}
      {has("engines") && <div data-settings-block="engines" className="flex scroll-mt-4 flex-col gap-5"><AdminOnly><EnginesSettings simple more={disclose("ai-more")} /></AdminOnly></div>}
      {has("connections") && (
        <RowsCard label={t("settings.rows.more")} data-settings-block="models-more">
          <PageRow page="keys" title={t("settings.section.connections")} hint={t("settings.hint.keys")} />
        </RowsCard>
      )}
      {has("bots") && <BotDefaultsRows />}
    </>
  );
}

export function AdvancedPageView({ page, has }: {
  page: AdvancedPage;
  has: Has;
  /** kept for callers */
  remoteActive?: boolean;
  /** kept for callers; People shows its list straight away now */
  peopleOpen?: boolean;
}) {
  switch (page) {
    case "apps": return <AppsPage has={has} />;
    case "team": return <TeamPage has={has} />;
    case "data": return <DataPage has={has} />;
  }
}
