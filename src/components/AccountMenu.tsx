import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { DialogScrimLayer, DialogSheet } from "./ui/SheetMotion";
import { ContinueInBrowserSheet } from "./SignInSheet";
import { continueInBrowser } from "@/lib/account-intent";
import { Check, LogOut, Pencil, Plus, X } from "../icons";
import type { AccountFace, AccountPlanLine, AccountRow, AccountsView, AccountSwitchResult, RailOpenResult } from "../../electron/cloud-account.mjs";
import { cn } from "@/lib/cn";
import type { CloudSignInPhase } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { cloudPlanLabel } from "@/lib/cloud-plan";
import { usePlaces } from "@/lib/places";
import { AvatarPicker } from "./AvatarPicker";
import { UserFace } from "./UserAvatar";
import { CLOSE, Heading, PRIMARY, QUIET, SCREEN, SHEET } from "./cloud-buy/parts";
import { codeDigits, SignInScreen } from "./cloud-buy/SignInScreen";
import { ConfirmDialog } from "./ConfirmDialog";
import { PixelIcon } from "./ui/PixelIcon";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

export interface AccountsAccess {
  /** This app's own page: who is signed in. Any other page has none. */
  view: AccountsView | null;
  /** Another page: main opens the sheet on the rail's page for it. */
  openSheet: (() => void) | null;
  /** No rail stands beside this page, so its ＋ can't be where another account is added. */
  noRail: boolean;
  signOut(id: string): void;
  add(email?: string): void;
  /** Opens the avatar picker for the account in use, where this app can save one. */
  editAvatar?: () => void;
  /** A Cloud of the person's own: the account in use (address, face and plan). Null anywhere else. */
  face?: AccountFace | null;
}

/** What a click or sign-out that didn't go through says; null when it went through. */
export function switchNote(result: Pick<RailOpenResult | AccountSwitchResult, "outcome">): string | null {
  switch (result.outcome) {
    case "moving": return t("accounts.moving");
    case "gone": return t("accounts.gone");
    case "failed": return t("accounts.failed");
    default: return null;
  }
}

/** Signing out of madani cloud asks first, over whatever is open (the accounts sheet sits at z-[60]): what happens, in one line. */
export function CloudSignOutConfirm({ open, pending = false, onCancel, onConfirm }: { open: boolean; pending?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <ConfirmDialog open={open} art={<PixelIcon name="cloud" size={28} />} title={t("accounts.signOutConfirmTitle")}
    body={t("accounts.signOutConfirmBody")} confirmLabel={t("accounts.signOut")} tone="neutral" pending={pending} layer="z-[70]"
    onCancel={onCancel} onConfirm={onConfirm} />;
}

/** Who is signed in on this device, on this app's own page; on any other page, only whether main offers the sheet. `signOut`
 * asks first: render `signOutConfirm` wherever the hook is used. */
export function useAccounts(): AccountsAccess & { sheet: { email: string | null; note: string | null } | null; closeSheet(): void; signOutConfirm: ReactNode; picking: boolean; closeAvatar(): void } {
  const bridge = window.madaniDesktop?.remoteClient?.active ? undefined : window.madaniDesktop?.accounts;
  const remote = window.madaniDesktop?.accountSheet;
  const own = window.madaniDesktop?.app?.ownPage === true && Boolean(bridge);
  const places = usePlaces();
  const [view, setView] = useState<AccountsView | null>(null);
  const [offered, setOffered] = useState(false);
  const [sheet, setSheet] = useState<{ email: string | null; note: string | null } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [face, setFace] = useState<AccountFace | null>(null);
  useEffect(() => {
    if (!own) return;
    const read = () => { void bridge!.list().then(setView).catch(() => {}); };
    read();
    return bridge!.onChanged(read);
  }, [own, bridge]);
  useEffect(() => {
    if (own || !remote) return;
    let alive = true;
    void remote.offered().then((yes) => { if (alive) setOffered(yes === true); }).catch(() => {});
    void remote.face?.().then((next) => { if (alive) setFace(next ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [own, remote]);
  return {
    view: own ? view : null,
    openSheet: !own && offered && remote ? () => { void remote.open().catch(() => {}); } : null,
    face: own ? null : face,
    noRail: !places.beside && !places.places.length,
    signOut: (id) => setAsking(id),
    add: (email) => setSheet({ email: email ?? "", note: null }),
    ...(own && bridge?.setAvatar ? { editAvatar: () => setPicking(true) } : {}),
    picking: own && picking,
    closeAvatar: () => setPicking(false),
    sheet,
    closeSheet: () => setSheet(null),
    signOutConfirm: <CloudSignOutConfirm open={asking !== null} onCancel={() => setAsking(null)} onConfirm={() => {
      const id = asking;
      setAsking(null);
      if (id) void bridge?.signOut(id).then((result) => { setView(result.view); const note = switchNote(result); if (note) setSheet({ email: null, note }); }).catch(() => setSheet({ email: null, note: t("accounts.failed") }));
    }} />,
  };
}

// one read and one subscription for every face on the page that shows the account in use
let activeRow: AccountRow | null = null;
const activeListeners = new Set<() => void>();
let activeStop: (() => void) | null = null;
function subscribeActive(listener: () => void) {
  activeListeners.add(listener);
  const bridge = window.madaniDesktop?.remoteClient?.active ? undefined : window.madaniDesktop?.accounts;
  if (!activeStop && bridge && window.madaniDesktop?.app?.ownPage === true) {
    const read = () => { void bridge.list().then((view) => { activeRow = view.active; for (const tell of activeListeners) tell(); }).catch(() => {}); };
    read();
    activeStop = bridge.onChanged(read);
  }
  return () => {
    activeListeners.delete(listener);
    if (!activeListeners.size) { activeStop?.(); activeStop = null; }
  };
}
/** The madani cloud account in use on this app's own page, for its face; null anywhere else or signed out. */
export function useActiveAccount(): AccountRow | null {
  return useSyncExternalStore(subscribeActive, () => activeRow, () => null);
}

/** The You menu's row for the madani cloud page, on this app's own page: Sign in while nobody is signed in here, so whoever was
 * told to sign in finds the words. Any other page knows nothing of who is signed in. */
export function cloudRowLabel(view: AccountsView | null): string {
  return t(view && !view.active ? "accounts.signIn" : "settings.section.cloudAccount");
}

/** The You menu's last rows: who is signed in here and Sign out. The other accounts are on the rail, and so is Add another account,
 * in its ＋; with no rail beside this page (nothing to list but This computer, or the person hid it) it is here. On another page,
 * one Sign out row that opens the sheet, with no address. Signed out: nothing, as Settings has the sign-in. */
export function accountMenuItems({ view, openSheet, noRail, signOut, add, editAvatar }: AccountsAccess): SidebarMenuItem[] {
  if (openSheet) return [{ key: "accounts-sheet", label: t("accounts.signOut"), icon: <LogOut size={18} />, onSelect: openSheet }];
  const active = view?.active;
  if (!active) return [];
  return [
    { key: "accounts-active", heading: t("accounts.heading"), label: active.email, title: active.email, checked: true, icon: <Check size={18} />, disabled: !active.signIn, ...(active.signIn ? { subtitle: t("accounts.needsSignIn") } : {}), onSelect: () => { if (active.signIn) add(active.email); } },
    ...(editAvatar && !active.signIn ? [{ key: "accounts-avatar", label: t("accounts.avatar.change"), icon: <UserFace account={active} size={18} />, onSelect: editAvatar }] : []),
    ...(noRail ? [{ key: "accounts-add", label: t("accounts.add"), icon: <Plus size={18} />, onSelect: () => add() }] : []),
    { key: "accounts-sign-out", label: t("accounts.signOut"), icon: <LogOut size={18} />, onSelect: () => signOut(active.id) },
  ];
}

const EMAIL_STEP: CloudSignInPhase = { step: "email", intent: false, problem: null };

/** Add another account in place: the emailed code, or the browser for single sign-on and two-step. The account in use goes
 * on until this succeeds; the code's attempt and the token stay in main. */
function AddAccount({ start, onDone, onBack }: { start: string; onDone: (note: string | null) => void; onBack: () => void }) {
  const bridge = window.madaniDesktop?.accounts;
  const [phase, setPhase] = useState<CloudSignInPhase>(EMAIL_STEP);
  const [email, setEmail] = useState(start);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => () => { void bridge?.addCancel().catch(() => {}); }, [bridge]);
  const send = () => {
    if (busy || !bridge) return;
    setBusy(true);
    void bridge.addStart(email).then((result) => {
      if (result.outcome === "sent") { setPhase({ step: "code", intent: false, email: result.email, resendAt: result.resendAt, problem: null, triesLeft: null, ...(result.signupOpen === false ? { signupOpen: false } : {}) }); setCode(""); }
      else setPhase({ step: "email", intent: false, problem: result.outcome });
    }, () => setPhase({ step: "email", intent: false, problem: "failed" })).finally(() => setBusy(false));
  };
  const verify = (digits: string) => {
    if (!bridge || phase.step !== "code") return;
    const at = phase;
    setBusy(true);
    void bridge.addVerify(digits).then((result) => {
      if (result.outcome === "switched") onDone(null);
      else if (result.outcome === "added") onDone(t("accounts.added", { email: result.email ?? email }));
      else if (result.outcome === "already") onDone(t("accounts.already", { email: result.email ?? email }));
      else { setCode(""); setPhase({ ...at, problem: result.outcome, triesLeft: result.outcome === "wrong-code" ? result.triesLeft : null }); }
    }, () => setPhase({ ...at, problem: "failed", triesLeft: null })).finally(() => setBusy(false));
  };
  // The browser's way ends in main, which says how once the list changes: the account in use now, kept for after a move, or the
  // one in use already. Nothing else tells the sheet, and it would wait on "Finish signing in" for ever.
  useEffect(() => {
    if (!browser || !bridge) return;
    const look = () => { void bridge.addResult().then((result) => {
      if (!result) return;
      if (result.outcome === "switched") onDone(null);
      else if (result.outcome === "added") onDone(t("accounts.added", { email: result.email ?? email }));
      else if (result.outcome === "already") onDone(t("accounts.already", { email: result.email ?? email }));
      else { setBrowser(false); setPhase({ step: "email", intent: false, problem: "failed" }); }
    }).catch(() => {}); };
    look();
    return bridge.onChanged(look);
  }, [browser, bridge, onDone, email]);
  if (browser) return <div data-accounts-browser className={SCREEN}>
    <Heading title={t("accounts.browserTitle")} sub={t("accounts.browserBody")} />
    <button type="button" className={QUIET} onClick={() => { void bridge?.addReopen().catch(() => {}); }}>{t("accounts.browserOpen")}</button>
  </div>;
  return <SignInScreen phase={phase} email={email} code={code} profileEmail={null} busy={busy} now={now} onBack={onBack} onEmail={setEmail} onSend={send}
    heading={t("accountGate.title")} backLabel={t("common.back")}
    onChangeEmail={() => { setPhase(EMAIL_STEP); void bridge?.addCancel().catch(() => {}); }}
    onCode={(value) => { const digits = codeDigits(value); setCode(digits); if (digits.length === 8 && !busy) verify(digits); }}
    onResend={send} onBrowser={() => { setBusy(true); void bridge?.addBrowser().then((result) => { if (result.outcome === "browser") setBrowser(true); else setPhase({ step: "email", intent: false, problem: "failed" }); }, () => setPhase({ step: "email", intent: false, problem: "failed" })).finally(() => setBusy(false)); }} />;
}

/** Over any place's page, on the rail's own page, or over this computer's: who is signed in here and Sign out, or a plain line
 * (`note`). `adding`: the sign-in, for this address when it has one: Add another account, or a saved account whose sign-in ended. */
export function AccountsSheet({ onClose, adding = null, note: given = null }: { onClose: () => void; adding?: string | null; note?: string | null }) {
  const bridge = window.madaniDesktop?.accounts;
  const [view, setView] = useState<AccountsView | null>(null);
  const [note, setNote] = useState<string | null>(given);
  const [add, setAdd] = useState<string | null>(adding);
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    // nobody signed in here: the sheet is the sign-in itself, never a pointer to somewhere else
    const read = () => { void bridge.list().then(setView).catch(() => setNote(t("accounts.failed"))); };
    read();
    return bridge.onChanged(read);
  }, [bridge]);
  const signOut = (id: string) => {
    setAsking(null);
    setNote(null);
    void bridge?.signOut(id).then((result) => {
      setView(result.view);
      const said = switchNote(result);
      if (said) setNote(said); else onClose();
    }, () => setNote(t("accounts.failed")));
  };
  const active = view?.active ?? null;
  // nobody signed in here: the sign-in continues in the browser at once, never a pointer to somewhere else
  if (view && !active && !given && add === null && window.madaniDesktop?.cloudAccount?.continueInBrowser) return <SignInInBrowser onClose={onClose} />;
  return <DialogScrimLayer className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <DialogSheet role="dialog" aria-modal="true" aria-labelledby="cloud-add-title" data-accounts-sheet className={cn(SHEET, "relative w-full max-w-[420px]")}>
      <button type="button" onClick={onClose} aria-label={t("accounts.close")} className={cn(CLOSE, "absolute end-4 top-4 z-10")}><X size={16} /></button>
      {add !== null
        ? <AddAccount start={add} onBack={() => (adding !== null ? onClose() : setAdd(null))} onDone={(said) => { setAdd(null); if (said) setNote(said); else onClose(); }} />
        : <div className={SCREEN}>
          <Heading title={t("accounts.title")} />
          {active && !given && <AccountCard account={active} />}
          {note && <p role="status" data-accounts-note className="text-[13px] leading-5 text-ink-secondary">{note}</p>}
          {active && !given && <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" data-accounts-sign-out className={QUIET} onClick={() => setAsking(active.id)}>{t("accounts.signOut")}</button>
            <button type="button" data-accounts-manage className={PRIMARY} onClick={() => { setNote(null); void manageAccount().catch(() => setNote(t("accounts.failed"))); }}>{t("accounts.manageAccount")}</button>
          </div>}
        </div>}
    </DialogSheet>
    <CloudSignOutConfirm open={asking !== null} onCancel={() => setAsking(null)} onConfirm={() => { if (asking) signOut(asking); }} />
  </DialogScrimLayer>;
}

/** The account's own page on the dashboard, signed in through the account handoff; the dashboard's home where that page
 * can't be asked for. */
async function manageAccount(): Promise<void> {
  const cloud = window.madaniDesktop?.cloudAccount;
  if (!cloud) throw new Error("no account bridge");
  await cloud.openDashboard();
}

/** What the account card says of the plan: Free, or madani cloud with its plan. Renewal dates live on the billing page. */
export function accountPlanText(plan: AccountPlanLine | undefined): string | null {
  if (!plan) return null;
  if (plan.status === "free") return t("accounts.card.free");
  const name = cloudPlanLabel(plan.tier);
  if (plan.status === "inactive") return t("accounts.card.inactive", { plan: name });
  return t(plan.trial ? "accounts.card.trial" : "accounts.card.plan", { plan: name });
}

/** Who is signed in: avatar, name, address and plan on one tonal card, no border. The avatar opens the picker while the
 * sign-in is good. */
function AccountCard({ account }: { account: AccountRow }) {
  const plan = accountPlanText(account.plan);
  const paid = account.plan?.status === "active";
  const [picking, setPicking] = useState(false);
  const faceRef = useRef<HTMLButtonElement>(null);
  const editable = Boolean(window.madaniDesktop?.accounts?.setAvatar) && !account.signIn;
  const face = <UserFace account={account} size={52} className="inset-ring inset-ring-ink/[0.08]" />;
  return <div data-accounts-active className="flex items-center gap-3.5 rounded-2xl bg-ink/[0.04] p-4">
    {editable
      ? <button ref={faceRef} type="button" data-accounts-avatar="" aria-label={t("accounts.avatar.change")} aria-haspopup="dialog" aria-expanded={picking}
        className="group/face relative shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => setPicking((open) => !open)}>
        {face}
        <span aria-hidden className="absolute -bottom-0.5 -end-0.5 flex size-5 items-center justify-center rounded-full bg-menu text-ink-secondary shadow-(--shadow-popover) transition-colors duration-150 ease-out group-hover/face:text-ink motion-reduce:transition-none">
          <Pencil size={11} />
        </span>
      </button>
      : face}
    {picking && <AvatarPicker account={account} anchor={faceRef.current} onClose={() => setPicking(false)} />}
    <div className="flex min-w-0 flex-1 flex-col">
      {account.name && <p dir="auto" className="truncate text-[15px] font-semibold leading-5 text-ink" title={account.name}>{account.name}</p>}
      <p className={cn("truncate leading-5", account.name ? "text-[13px] text-ink-secondary" : "text-[15px] font-semibold text-ink")} title={account.email}>{account.email}</p>
      {plan && <p data-accounts-plan={account.plan?.status} className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] font-medium leading-4 text-ink-secondary">
        <PixelIcon name={paid ? "cloud" : "sparkle"} size={14} />
        <span className="truncate">{plan}</span>
      </p>}
      {account.signIn && <p className="mt-1 text-[12px] leading-4 text-warning">{t("accounts.needsSignIn")}</p>}
    </div>
  </div>;
}

/** Signed out: the account step in the browser, and the calm sheet while it goes on; it closes when signed in. */
function SignInInBrowser({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    void continueInBrowser({ kind: "signin" }).then((outcome) => { if (outcome !== "browser") onClose(); }, () => onClose());
    const off = window.madaniDesktop?.cloudAccount?.onState((state) => { if (state.account && state.status === "connected") onClose(); else if (state.status !== "connecting") onClose(); });
    return () => off?.();
  }, []);
  return <ContinueInBrowserSheet kind="signin" onClose={onClose} />;
}

/** The sheet as the rail's page keeps it: asked for by main, from the person's click on the page beside the rail. */
export function useAccountsSheet(): { open: boolean; close: () => void } {
  const bridge = window.madaniDesktop?.accounts;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    void bridge.sheetPending().then((pending) => { if (pending) setOpen(true); }).catch(() => {});
    return bridge.onOpenSheet(() => setOpen(true));
  }, [bridge]);
  useEffect(() => { if (open) void window.madaniDesktop?.rail?.expand?.(true)?.catch(() => {}); }, [open]);
  return { open, close: () => {
    setOpen(false);
    void window.madaniDesktop?.rail?.expand?.(false)?.catch(() => {});
    void bridge?.sheetClosed().catch(() => {});
  } };
}
