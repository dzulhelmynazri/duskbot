import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Bell, CalendarClock, Check, FileText, Globe, KeyRound, LayoutDashboard, LifeBuoy, Lock, LogOut, Mail, Mic, MonitorX, Palette, Plug, Plus, ShieldCheck, UserPlus, UserRound, Hand, Server, ZoomIn } from "../../icons";
import { accountDashboardUrl } from "@/lib/account-dashboard";
import { useGroupYou } from "@/components/GroupAvatar";
import { UserFace } from "@/components/UserAvatar";
import { trackUpsell, watchUpsell } from "@/lib/cloud-upsell";
import { t } from "@/lib/i18n";
import { effectiveLanguage, setLanguageChoice, useLanguageChoice, usePageLanguage } from "@/lib/language-preference";
import { applySkinChoice, readSkinChoice, subscribeSkin, THEME_SKINS } from "@/lib/skins";
import { localeChoices } from "@/locales";
import { useStore } from "@/state/store";
import { useConnections } from "../connection/connections";
import { usePlaces, type Place, type PlaceStatus } from "../connection/places";
import { haptic, setHapticsEnabled, useHapticsEnabled } from "../haptics";
import { readTextSize, setTextSize, subscribeTextSize, TEXT_SIZES } from "../text-scale";
import { dur, ease, spring } from "../motion";
import { useMobileAccount } from "../account/AccountGate";
import { chooseAccountOrigin, environmentName, PREVIEW_ORIGIN, PRODUCTION_ORIGIN } from "../account/environment";
import { LEGAL_LINKS, supportMail } from "../legal";
import { useAiConsent } from "../consent/AiConsent";
import { WorkingDots } from "@/components/WorkingIndicator";
import { SIMPLE_BUTTONS } from "@/components/SettingsPrimitives";
import { VoiceInputSettings } from "@/components/VoiceInputSettings";
import { usePlatform } from "../platform";
import { Sheet, SheetStack, StackPage } from "../Sheet";
import { NavStack } from "../NavStack";
import { NotificationsSheet } from "./NotificationsSheet";
import { NotificationSettings } from "./NotificationSettings";
import { RoutinesSheet } from "./RoutinesSheet";
import { ConnectorsSheet } from "./ConnectorsSheet";
import { VaultSheet } from "./VaultSheet";
import { DeleteAccountPage } from "./DeleteAccountPage";
import { ConfirmPage } from "./ConfirmPage";
import { placeKind } from "../connection/connection-notice";
import { removePlace } from "../account/sign-out";
import { phoneIdentity, type PhoneIdentity } from "../account/identity";
import { SettingsRow, SettingsSection, SettingsSwitch } from "./SettingsRow";
import { PixelArt } from "../Illustration";
import type { SheetPageProps } from "./registry";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";

/** The account rows Settings shows. The account dashboard sells plans, so the store apps never link to it (App Store
 * guideline 3.1.1, Play payments policy); a phone on an account (its session, or a madani cloud of it) signs out here, and
 * deletes the account with its session (App Store 5.1.1(v)). Log in leads only on a phone that links nothing; one with
 * only its own computers (they need no account) gets the madani cloud sign-in lower down, apart from who it is. */
export function accountRows(input: { native: boolean; identity: PhoneIdentity; offered?: boolean }): { dashboard: boolean; signOut: boolean; deleteAccount: boolean; signIn: boolean; cloudSignIn: boolean } {
  const { identity } = input;
  const onAccount = identity.kind === "account" || identity.kind === "cloud";
  return {
    dashboard: !input.native, signOut: onAccount, deleteAccount: identity.kind === "account" && identity.session,
    signIn: Boolean(input.offered) && identity.kind === "none", cloudSignIn: Boolean(input.offered) && identity.kind === "computer",
  };
}

/** A label a person would recognise for where these bots live: never an address like 127.0.0.1:5331 or a URL. */
export function readableWorkspace(label: string | null | undefined): string | null {
  const value = label?.trim();
  if (!value) return null;
  if (/:\/\//.test(value) || /^\[?[0-9a-f:.]+\]?(:\d+)?$/i.test(value) || /^[\w.-]+:\d+$/.test(value) || /^localhost$/i.test(value)) return null;
  return value;
}

/** The header's two lines: the person's name, then the account's email, the madani cloud, or the computer they're linked to. */
export function settingsIdentity(input: { name?: string | null; identity: PhoneIdentity }): { title: string; subtitle: string } {
  const { identity } = input;
  const email = identity.kind === "account" ? identity.email.trim() : "";
  const title = input.name?.trim() || email.split("@")[0] || t("mobile.settings.you");
  const subtitle = email
    || (identity.kind === "cloud" ? readableWorkspace(identity.name) ?? t("mobile.settings.cloudLinked") : "")
    || (identity.kind === "computer" ? t("mobile.settings.connectedTo", { name: readableWorkspace(identity.name) ?? t("mobile.connection.yourComputer") }) : "")
    || t("mobile.settings.onComputer");
  return { title, subtitle };
}

/** madani cloud, as its own quiet card under the settings, only where the dashboard may be linked and the phone is not
 * already talking to a cloud */
function CloudCard({ onOpen }: { onOpen: () => void }) {
  const shown = useRef(false);
  useEffect(() => { if (!shown.current) { shown.current = true; trackUpsell("shown", "app_mobile"); } }, []);
  useEffect(() => watchUpsell("app_mobile"), []);
  return (
    <button type="button" onClick={() => { trackUpsell("click", "app_mobile"); onOpen(); }} className="mobile-press mx-4 mt-9 flex w-[calc(100%-32px)] items-center gap-4 rounded-[16px] bg-menu px-4 py-4 text-left">
      <PixelArt name="server" size={44} />
      <span className="min-w-0 flex-1">
        <span className="block text-balance text-[16px] font-semibold text-ink">{t("cloudUpsell.mobile")}</span>
        <span className="mt-0.5 block text-[14px] font-medium leading-5 text-ink-secondary">{t("cloudUpsell.mobileDetail")}</span>
      </span>
    </button>
  );
}

type SettingsPage = "language" | "textSize" | "voice" | "notifications" | "routines" | "connectors" | "vault" | "delete" | "signOut" | "removeComputer";

/** the computer on screen when it was paired with its own QR or code, which the account's sign-out never removes */
export function shownComputer(connections: readonly MobileConnectionRecord[], activeId: string | null): MobileConnectionRecord | null {
  const shown = connections.find((connection) => connection.id === activeId);
  return shown && placeKind(shown) === "computer" ? shown : null;
}
const SETTINGS_PAGES: readonly string[] = ["language", "textSize", "voice", "notifications", "routines", "connectors", "vault"];

/** Settings is a stack inside one sheet, as iOS Settings: the grouped list, and each page pushed over it with the
 * system's slide and edge swipe back. Notifications, routines, apps and the vault are the same pages the rest of the
 * app opens as sheets, drawn here as pages, so nothing in Settings leaves it. */
export const SettingsSheet: ComponentType<SheetPageProps<"settings">> = ({ sheet, open, onClose, onOpenSheet, onOpenChat }) => {
  const account = useMobileAccount();
  const platform = usePlatform();
  const { connections, activeId } = useConnections();
  const computer = shownComputer(connections, activeId);
  const computerName = readableWorkspace(computer?.label) ?? t("mobile.connection.yourComputer");
  const keepsComputers = connections.some((connection) => placeKind(connection) === "computer");
  const identity = phoneIdentity({ account: account?.account, connections, activeId });
  const signsOut = identity.kind === "account" || identity.kind === "cloud";
  const [page, setPage] = useState<SettingsPage | null>(SETTINGS_PAGES.includes(sheet.page ?? "") ? sheet.page as SettingsPage : null);
  const pop = useCallback(() => setPage(null), []);
  const stack = useMemo(() => ({ back: pop }), [pop]);
  const pageProps = { open: true, onClose: pop, onOpenSheet, onOpenChat };
  const shown = page === "notifications" ? <NotificationsSheet sheet={{ kind: "notifications" }} {...pageProps} />
    : page === "routines" ? <RoutinesSheet sheet={{ kind: "routines" }} {...pageProps} />
    : page === "connectors" ? <ConnectorsSheet sheet={{ kind: "connectors" }} {...pageProps} />
    : page === "vault" ? <VaultSheet sheet={{ kind: "vault" }} {...pageProps} />
    : page === "language" ? <LanguagePage />
    : page === "textSize" ? <TextSizePage />
    : page === "delete" && account?.account ? <DeleteAccountPage email={account.account.email} onDelete={account.deleteAccount} onCancel={pop} onDone={() => window.location.reload()} />
    : page === "signOut" && account && signsOut ? <ConfirmPage title={t("accountGate.signOut")}
      heading={account.accounts.length > 1 && account.account ? t("mobile.settings.signOutAccountTitle", { email: account.account.email }) : t("mobile.settings.signOutTitle")}
      body={t(account.accounts.length > 1 ? "mobile.settings.signOutAccountBody" : keepsComputers ? "mobile.settings.signOutKeepsComputers" : "mobile.settings.signOutBody")}
      action={t("accountGate.signOut")} onConfirm={account.signOutOfPhone} onCancel={pop} />
    : page === "removeComputer" && computer ? <ConfirmPage title={t("mobile.settings.removeComputer")} heading={t("mobile.settings.removeComputerTitle", { name: computerName })}
      body={t("mobile.settings.removeComputerBody", { name: computerName })} action={t("mobile.settings.removeComputerAction")}
      onConfirm={async () => { await removePlace(platform, computer.id); window.location.reload(); }} onCancel={pop} />
    : page === "voice" ? <Sheet open onClose={pop} title={t("settings.voice.title")}><div data-settings-look="simple" className={`flex flex-col gap-6 px-4 pt-2 ${SIMPLE_BUTTONS}`}><VoiceInputSettings /></div></Sheet>
    : null;
  return (
    <Sheet open={open} onClose={onClose} full flush label={t("mobile.settings.title")} bodyClassName="overflow-hidden pb-0">
      <NavStack
        base={<StackPage open title={t("mobile.settings.title")} onClose={onClose}><SettingsList onClose={onClose} push={setPage} /></StackPage>}
        page={shown && <SheetStack value={stack}>{shown}</SheetStack>}
        pageKey={page}
        onBack={pop}
      />
    </Sheet>
  );
};

function SettingsList({ onClose, push }: { onClose: () => void; push: (page: SettingsPage) => void }) {
  const { state } = useStore();
  const { connections, activeId, switchTo } = useConnections();
  const you = useGroupYou();
  const platform = usePlatform();
  const account = useMobileAccount();
  const hapticsEnabled = useHapticsEnabled();
  const textSize = useSyncExternalStore(subscribeTextSize, readTextSize, () => "system" as const);
  const skin = useSyncExternalStore(subscribeSkin, readSkinChoice, () => "system");
  const language = effectiveLanguage(useLanguageChoice(), state.config?.language);
  usePageLanguage(language);
  const { places, expected, open: openPlace } = usePlaces(state.connected === true);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appearanceId = useId();
  const computer = shownComputer(connections, activeId);
  const who = phoneIdentity({ account: account?.account, connections, activeId });
  const email = who.kind === "account" ? who.email : undefined;
  const face = account?.account ?? you?.face ?? null;
  const identity = settingsIdentity({ name: state.config?.profile?.name, identity: who });
  const rows = accountRows({ native: platform.native, identity: who, offered: account?.offered });
  const consent = useAiConsent();
  const unread = state.notifications.filter((entry) => !entry.read).length;
  const environment = account ? environmentName(account.origin) : null;
  // seven taps on the version show the servers row, for testing a store build against the preview stack
  const taps = useRef<number[]>([]);
  const [serversShown, setServersShown] = useState(false);
  const [switching, setSwitching] = useState(false);
  const tapVersion = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((at) => now - at < 3_000), now];
    if (taps.current.length >= 7) { setServersShown(true); haptic("pick"); }
  };
  const switchServers = () => {
    if (!switching) { setSwitching(true); return; }
    chooseAccountOrigin(account?.origin === PREVIEW_ORIGIN ? PRODUCTION_ORIGIN : PREVIEW_ORIGIN);
    void (account?.signOutEverywhere() ?? Promise.resolve()).finally(() => window.location.reload());
  };

  const otherAccounts = account?.accounts.filter((one) => one.id !== account.account?.id) ?? [];
  const useAccount = async (id: string) => {
    haptic("pick");
    if (!(await account?.switchAccount(id))) { haptic("error"); setError(t("mobile.settings.workspaceError")); return; }
    const linked = [...connections].sort((a, b) => b.lastUsedAt - a.lastUsedAt).find((one) => one.account?.id === id);
    if (linked) { await switchTo(linked.id); return; }
    onClose();
    window.dispatchEvent(new Event("madani:sign-in"));
  };

  const choosePlace = async (place: Place) => {
    if (opening || place.active) return;
    haptic("pick");
    setOpening(place.key);
    setError(null);
    try {
      const outcome = await openPlace(place);
      if (outcome === "paired") onClose();
      else if (outcome !== "switched") { haptic("error"); setError(outcome === "asleep" || outcome === "unavailable" ? t("mobile.settings.placeAsleepError", { name: place.name }) : t("mobile.settings.workspaceError")); }
    } catch {
      haptic("error");
      setError(t("mobile.settings.workspaceError"));
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="pb-6">
      <SettingsSection card>
        <div className="flex w-full items-center gap-4 px-4 py-3.5">
          <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink/[0.07] text-[20px] font-semibold text-ink">
            {face ? <UserFace account={face} size={56} className="size-full" /> : you?.initials ?? <UserRound aria-hidden size={24} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[19px] font-semibold leading-6 tracking-[-0.01em] text-ink">{identity.title}</span>
            <span data-settings-identity className="block truncate text-[14px] text-ink-secondary">{identity.subtitle}</span>
          </span>
        </div>
        {rows.dashboard && <SettingsRow icon={<LayoutDashboard />} label={t("mobile.settings.accountDashboard")} onClick={() => void accountDashboardUrl().then((url) => platform.openExternal(url))} />}
        {rows.signIn && <SettingsRow icon={<UserRound />} label={t("mobile.entry.signIn")} detail={t("mobile.settings.signInDetail")} onClick={() => { onClose(); window.dispatchEvent(new Event("madani:sign-in")); }} />}
        {otherAccounts.map((other) => (
          <SettingsRow key={other.id} icon={<UserFace account={other} size={24} className="size-6 rounded-full" />} label={other.email} detail={t("mobile.settings.otherAccount")} onClick={() => void useAccount(other.id)} />
        ))}
        {account?.account && account.offered && <SettingsRow icon={<UserPlus />} label={t("mobile.settings.addAccount")} onClick={() => { haptic("pick"); onClose(); window.dispatchEvent(new Event("madani:add-account")); }} />}
      </SettingsSection>

      <SettingsSection card title={t("mobile.settings.workspaces")} hint={error ? <span role="alert" className="text-danger">{error}</span> : email ? t("mobile.settings.workspacesHint") : undefined}>
        {(places === null || places.length > 0) && <PlacesList places={places} expected={expected} opening={opening} onChoose={(place) => { void choosePlace(place); }} />}
        <SettingsRow icon={<Plus />} label={t("mobile.settings.addPlace")} onClick={() => { haptic("pick"); onClose(); window.dispatchEvent(new Event("madani:add-place")); }} />
      </SettingsSection>

      <SettingsSection card>
        <SettingsRow icon={<Bell />} label={t("mobile.settings.notifications")} value={unread || undefined} onClick={() => push("notifications")} />
        <NotificationSettings />
      </SettingsSection>

      <SettingsSection card title={t("mobile.settings.phone")}>
        <div role="group" aria-label={t("mobile.settings.appearance")} className="flex items-center gap-3 px-4 py-2">
          <Palette aria-hidden className="size-5 shrink-0 text-ink-secondary" />
          <div className="flex flex-1 rounded-full bg-ink/[0.06] p-1">
            {([{ choice: "system", label: t("mobile.settings.system") }, { choice: THEME_SKINS.light, label: t("mobile.settings.light") }, { choice: THEME_SKINS.dark, label: t("mobile.settings.dark") }] as const).map(({ choice, label }) => (
              <button key={choice} type="button" aria-pressed={skin === choice} onClick={() => { haptic("segment"); applySkinChoice(choice); }} className="mobile-press relative flex min-h-10 flex-1 items-center justify-center rounded-full px-2 text-[15px] font-semibold">
                {skin === choice && <motion.span aria-hidden layoutId={`${appearanceId}-selection`} className="absolute inset-0 rounded-full bg-app shadow-sm [:root[data-skin=grok-dark]_&]:bg-ink/[0.16]" transition={spring.settle} />}
                <span className={skin === choice ? "relative text-ink" : "relative text-ink-secondary"}>{label}</span>
              </button>
            ))}
          </div>
        </div>
        <SettingsSwitch icon={<Hand />} label={t("mobile.settings.haptics")} checked={hapticsEnabled} onChange={(enabled) => { setHapticsEnabled(enabled); haptic("toggle"); }} />
        <SettingsRow icon={<Mic />} label={t("settings.voice.title")} onClick={() => push("voice")} />
        <SettingsRow icon={<ZoomIn />} label={t("mobile.settings.textSize")} value={t(`mobile.settings.textSize.${textSize}`)} onClick={() => push("textSize")} />
        <SettingsRow icon={<Globe />} label={t("mobile.settings.language")} value={localeChoices.find((choice) => choice.code === language)?.label ?? t("mobile.settings.system")} onClick={() => push("language")} />
      </SettingsSection>

      <SettingsSection card title={t("mobile.settings.bots")}>
        <SettingsRow icon={<CalendarClock />} label={t("mobile.settings.routines")} onClick={() => push("routines")} />
        <SettingsRow icon={<Plug />} label={t("mobile.settings.connectors")} onClick={() => push("connectors")} />
        <SettingsRow icon={<KeyRound />} label={t("mobile.settings.vault")} onClick={() => push("vault")} />
      </SettingsSection>

      {consent && (
        <SettingsSection card title={t("mobile.settings.privacyTitle")}>
          <SettingsRow icon={<ShieldCheck />} label={t("mobile.settings.aiSharing")} value={t(consent.covered ? "mobile.settings.aiSharingOn" : "mobile.settings.aiSharingOff")} onClick={() => { onClose(); consent.open(); }} />
        </SettingsSection>
      )}

      <SettingsSection card title={t("mobile.settings.about")}>
        <SettingsRow icon={<LifeBuoy />} label={t("mobile.settings.help")} onClick={() => void platform.openExternal(LEGAL_LINKS.help)} />
        <SettingsRow icon={<Mail />} label={t("mobile.settings.contact")} onClick={() => void platform.openExternal(supportMail(t("mobile.settings.contactSubject")))} />
        <SettingsRow icon={<Lock />} label={t("mobile.settings.privacy")} onClick={() => void platform.openExternal(LEGAL_LINKS.privacy)} />
        <SettingsRow icon={<FileText />} label={t("mobile.settings.terms")} onClick={() => void platform.openExternal(LEGAL_LINKS.terms)} />
      </SettingsSection>
      {(serversShown || environment) && platform.native && (
        <SettingsSection card>
          <SettingsRow icon={<Server />} label={t("mobile.settings.servers")} detail={t(switching ? "mobile.settings.serversConfirm" : "mobile.settings.serversHint")}
            value={environment ?? "madani.bot"} onClick={switchServers} />
        </SettingsSection>
      )}
      {rows.cloudSignIn && (
        <SettingsSection card>
          <SettingsRow icon={<UserRound />} label={t("mobile.settings.cloudSignIn")} detail={t("mobile.settings.signInDetail")} onClick={() => { onClose(); window.dispatchEvent(new Event("madani:sign-in")); }} />
        </SettingsSection>
      )}
      {(rows.signOut || computer) && (
        <SettingsSection card>
          {computer && <SettingsRow icon={<MonitorX />} label={t("mobile.settings.removeComputer")} chevron={false} onClick={() => { haptic("tap"); push("removeComputer"); }} />}
          {rows.signOut && <SettingsRow icon={<LogOut />} label={t("accountGate.signOut")} chevron={false} onClick={() => { haptic("tap"); push("signOut"); }} />}
        </SettingsSection>
      )}
      {rows.dashboard && !state.config?.cloudHome && <CloudCard onOpen={() => void accountDashboardUrl().then((url) => platform.openExternal(url))} />}
      {rows.deleteAccount && (
        <button type="button" data-settings-delete-account onClick={() => { haptic("tap"); push("delete"); }} className="mx-auto mt-4 block min-h-11 px-4 text-center text-[13px] text-danger">
          {t("mobile.settings.deleteAccount")}
        </button>
      )}
      <button type="button" onClick={tapVersion} className="mx-auto mt-6 block min-h-11 px-4 text-center text-[13px] text-ink-tertiary">
        {environment ? t("mobile.settings.versionOn", { version: platform.appVersion, environment }) : t("mobile.settings.version", { version: platform.appVersion })}
      </button>
    </div>
  );
}

function TextSizePage() {
  const size = useSyncExternalStore(subscribeTextSize, readTextSize, () => "system" as const);
  return (
    <Sheet open onClose={() => {}} title={t("mobile.settings.textSize")}>
      <p data-text-size-sample="" className="mx-4 mb-4 rounded-[19px] bg-ink/[0.05] px-[14px] py-2 text-[17px] font-[450] leading-[22px] text-ink">{t("mobile.settings.textSize.sample")}</p>
      <SettingsSection card>
        {TEXT_SIZES.map((choice) => (
          <button key={choice} type="button" aria-pressed={size === choice} onClick={() => { haptic("pick"); setTextSize(choice); }} className="mobile-row flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left text-[16px] font-medium text-ink">
            <span className="min-w-0 flex-1">{t(`mobile.settings.textSize.${choice}`)}</span>
            {size === choice && <Check aria-hidden size={20} />}
          </button>
        ))}
      </SettingsSection>
    </Sheet>
  );
}

function LanguagePage() {
  const { state } = useStore();
  const language = effectiveLanguage(useLanguageChoice(), state.config?.language);
  return (
    <Sheet open onClose={() => {}} title={t("mobile.settings.language")}>
      <SettingsSection card>
        {[{ code: "", label: t("mobile.settings.system") }, ...localeChoices].map(({ code, label }) => (
          <button key={code} type="button" aria-pressed={language === code} onClick={() => { haptic("pick"); setLanguageChoice(code); }} className="mobile-row flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left text-[16px] font-medium text-ink">
            <span className="min-w-0 flex-1">{label}</span>
            {language === code && <Check aria-hidden size={20} />}
          </button>
        ))}
      </SettingsSection>
    </Sheet>
  );
}

const DOT: Record<PlaceStatus, string> = { online: "bg-success", asleep: "bg-ink/[0.32]", offline: "border-[1.5px] border-ink/[0.4] bg-transparent" };
const ROW = "flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left";

/** Every place on the account, each a status dot and its name. Until the list is in, skeleton rows of the same height
 * hold its place; the rows then fade in over them, so nothing below moves. */
function PlacesList({ places, expected, opening, onChoose }: { places: Place[] | null; expected: number; opening: string | null; onChoose: (place: Place) => void }) {
  const reduced = useReducedMotion();
  const drawnAtOnce = useRef(places !== null);
  if (!places) return (
    <div role="status" aria-label={t("mobile.settings.placesLoading")}>
      {Array.from({ length: Math.max(expected, 1) }, (_, index) => (
        <div key={index} aria-hidden className={ROW}>
          <span className="size-2.5 shrink-0 rounded-full bg-ink/[0.08]" />
          <span className="h-4 rounded-full bg-ink/[0.06]" style={{ width: `${[46, 34, 40][index % 3]}%` }} />
        </div>
      ))}
    </div>
  );
  return (
    <motion.ul initial={drawnAtOnce.current ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : dur.base, ease: ease.out }}>
      {places.map((place) => <li key={place.key}><PlaceRow place={place} working={opening === place.key} disabled={Boolean(opening)} onChoose={() => onChoose(place)} /></li>)}
    </motion.ul>
  );
}

const STATUS_LABEL = { online: "mobile.settings.placeOnline", asleep: "mobile.settings.placeAsleep", offline: "mobile.settings.placeOffline" } as const;

function PlaceRow({ place, working, disabled, onChoose }: { place: Place; working: boolean; disabled: boolean; onChoose: () => void }) {
  const content = <>
    <span aria-hidden data-place-status={place.status} className={`size-2.5 shrink-0 rounded-full transition-colors duration-200 ${DOT[place.status]}`} />
    <span className={`min-w-0 flex-1 truncate text-[16px] text-ink ${place.active ? "font-semibold" : "font-medium"}`}>{place.name}</span>
    {working ? <WorkingDots size={3} /> : <span className="shrink-0 text-[15px] text-ink-secondary">{t(STATUS_LABEL[place.status])}</span>}
  </>;
  if (place.active) return <div data-testid="mobile-place" aria-current="true" className={ROW}>{content}</div>;
  return <button type="button" data-testid="mobile-place" disabled={disabled} aria-busy={working || undefined} onClick={onChoose} className={`mobile-row ${ROW} disabled:opacity-100`}>{content}</button>;
}
