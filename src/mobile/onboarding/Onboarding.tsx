import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { storeApp } from "@/lib/store-app";
import { AnimatePresence } from "motion/react";
import { ClipboardPaste, Keyboard, QrCode, UserRound } from "../../icons";
import { WorkingDots } from "@/components/WorkingIndicator";
import { t } from "@/lib/i18n";
import { upperFirst } from "@/lib/lower-first";
import { THEME_SKINS } from "@/lib/skins";
import { pairSignIn, universalSignInLink, type MobileConnectionRecord, type PairSignIn } from "../../../shared/mobile-link";
import { haptic } from "../haptics";
import { PixelArt, PixelMascot } from "../Illustration";
import { usePlatform, type CameraPermission } from "../platform";
import { LINK_DEADLINE_MS, linkDeadline, PairError, readScanned, redeemPairing, resolveTypedCode, type TypedPairing } from "../connection/pair";
import { followSignInService, signInServiceSwitch } from "../account/environment";
import { Scanner } from "./Scanner";
import { CloudPicker } from "../account/CloudPicker";
import { MobileSignIn } from "../account/MobileSignIn";
import { useMobileAccount } from "../account/AccountGate";
import { MascotTrio } from "./SkyScene";
import { editCode, formatCode, fullCode, typedCodeComplete } from "./code-field";
import { BackButton, ErrorLine, FIELD, HEADLINE, LINE, PRIMARY, QUIET, Screen, StepPane, TONAL } from "./parts";

export type Step = "welcome" | "signin" | "clouds" | "switch" | "confirm" | "scan" | "code" | "paste";
/** a madani cloud's QR or link: the account it logs in to, its code when it carries one, and the cloud it was drawn on */
type CloudQr = { email: string; code?: string; cloud?: string; pair?: TypedPairing };
type Failure = { code: PairError["code"] | "account-offline"; name: string; companion: boolean };
type PhoneCodeOutcome = Awaited<ReturnType<NonNullable<ReturnType<typeof useMobileAccount>>["signIn"]["phoneCode"]>>["outcome"];

/** a madani cloud code that did not log in, as the failure the code screen says */
export function phoneCodeFailure(outcome: Exclude<PhoneCodeOutcome, "signed-in">): Failure["code"] {
  switch (outcome) {
    case "wrong-code": return "unknown";
    case "expired": return "expired";
    case "used": return "used";
    case "limited": return "limited";
    case "offline": return "account-offline";
    case "failed": return "account-offline";
  }
}

export const DOWNLOAD_URL = "https://madani.bot/download";
/** the account sign-in a desktop's QR carries waits this long at most, then the pairing goes on without it */
const CARRIED_SIGN_IN_MS = 5_000;

function installationName(payload: TypedPairing | null, fallback = t("mobile.pair.workspace")): string {
  if (payload?.name) return payload.name;
  try { return new URL(payload?.origin ?? "").host; } catch { return fallback; }
}

/** `addAccount`: an empty sign-in for another account, beside the one the phone has */
export type OnboardingStart = "welcome" | "signin" | "addAccount";

/** Where a fresh start lands: a link that arrived goes to its confirmation, a signed-in phone to its clouds, a sign-in
 * asked for from Settings to the sign-in, anyone else to pairing with their computer. */
export function firstStep({ incoming, signedIn, adding, startAt = "welcome" }: { incoming: boolean; signedIn: boolean; adding: boolean; startAt?: OnboardingStart }): Step {
  if (incoming) return "confirm";
  if (startAt === "addAccount") return "signin";
  if (startAt === "signin") return signedIn ? "clouds" : "signin";
  if (signedIn && !adding) return "clouds";
  return "welcome";
}

function Failed({ failure, onSignIn }: { failure: Failure; onSignIn?: () => void }) {
  const key = failure.code === "unreachable" && failure.companion ? "network" : failure.code;
  // a cloud never takes a code, and a code nobody knows is often a cloud's or a browser's: logging in is the way there
  const signIn = onSignIn && (failure.code === "sign-in" || failure.code === "unknown");
  return (
    <ErrorLine action={signIn ? (
      <button type="button" data-failure-sign-in="" onClick={onSignIn} className="mobile-press -ms-2 mt-1 flex min-h-11 items-center rounded-full px-2 text-[15px] font-semibold text-ink underline underline-offset-2">
        {t("mobile.onboarding.err.signInAction")}
      </button>
    ) : null}>
      <span className="block font-semibold">{t(`mobile.onboarding.err.${key}.title` as Parameters<typeof t>[0])}</span>
      <span className="block text-ink-secondary">{upperFirst(t(`mobile.onboarding.err.${key}.body` as Parameters<typeof t>[0], { name: failure.name }))}</span>
    </ErrorLine>
  );
}

/** First launch to linked. Pairing with your own computer needs no account (App Store guideline 5.1.1(v)): scan its QR
 * code first, or type its code. Signing in is only for a madani cloud (the account finds it and pairs with it). The success moment and the hand-off
 * to Home belong to the connection gate. */
export function Onboarding({ initial = null, initialSignIn, reason = null, startAtLink = false, startAt = "welcome", email, signInCode, signInCloud, onLinked, onOpen, onCancel }: {
  /** the account sign-in a signed-in desktop's pairing QR carried with `initial` */
  initialSignIn?: PairSignIn;
  /** the madani cloud a QR or link was drawn on, opened once the phone is logged in */
  signInCloud?: string;
  /** a place this phone already links, to open instead of pairing it again */
  onOpen?(id: string): void;
  /** where a sheet opened from inside the app starts */
  startAt?: OnboardingStart;
  /** a madani cloud's qr named the account to sign in with */
  email?: string;
  /** and carried a desktop's code that logs the phone in: it is redeemed at once, on the code screen */
  signInCode?: string;
  initial?: TypedPairing | null;
  /** Linking another computer from inside the app: a way back out. */
  startAtLink?: boolean;
  reason?: "revoked" | null;
  onLinked(record: MobileConnectionRecord, token: string, name: string): void | Promise<void>;
  onCancel?: () => void;
}) {
  const platform = usePlatform();
  const account = useMobileAccount();
  const signedIn = Boolean(account?.account);
  const home: Step = firstStep({ incoming: false, signedIn, adding: startAtLink });
  const [step, setStep] = useState<Step>(() => signInCode ? "code" : firstStep({ incoming: Boolean(initial), signedIn, adding: startAtLink, startAt }));
  const [confirm, setConfirm] = useState<TypedPairing | null>(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // a failed scan lands on the code screen with an empty field: its way forward is scanning again, not a dead submit
  const [scanFailed, setScanFailed] = useState(false);
  const [noClouds, setNoClouds] = useState(false);
  // a sign-in made here opens its only cloud at once; one the phone already held (the Keychain keeps it through a
  // delete and reinstall) lists the places to pick from
  const [justSignedIn, setJustSignedIn] = useState(false);
  // a madani cloud's QR or link logged in here: its cloud (or the account's only one) opens without a pick
  const [qrTarget, setQrTarget] = useState<{ origin: string | null } | null>(null);
  const [switchTo, setSwitchTo] = useState<CloudQr | null>(null);
  const carriedSignIn = useRef(initialSignIn);
  const leave = () => onCancel?.();
  const [signingOut, setSigningOut] = useState(false);
  const [withComputers, setWithComputers] = useState(false);
  const [value, setValue] = useState(() => signInCode ? formatCode(signInCode) : "");
  const [signInEmail, setSignInEmail] = useState(email ?? "");
  const locked = useRef(false);
  const fieldId = useId();
  const codeField = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  // a full code goes once by itself; typing it again after a change sends it again
  const sentCode = useRef<string | null>(null);
  useLayoutEffect(() => {
    const at = caret.current, input = codeField.current;
    caret.current = null;
    if (at !== null && input && document.activeElement === input) input.setSelectionRange(at, at);
  }, [value]);

  useEffect(() => {
    platform.setStatusBar?.(step === "scan" || document.documentElement.dataset.skin === THEME_SKINS.dark ? "light" : "dark");
  }, [platform, step]);

  // the link under way: any way out of its screen (Cancel, Back, closing the scanner) stops it, and its answer is dropped
  const attempt = useRef<AbortController | null>(null);
  const cancelLink = () => {
    if (!attempt.current) return;
    attempt.current.abort();
    attempt.current = null;
    locked.current = false;
    setBusy(false);
  };
  const go = (next: Step) => { cancelLink(); setFailure(null); setScanFailed(false); setValue(""); setStep(next); };
  const [cameraDenied, setCameraDenied] = useState(false);

  const redeem = async (text: string | TypedPairing, from: Step) => {
    if (locked.current) return;
    locked.current = true;
    const controller = new AbortController();
    attempt.current = controller;
    const live = () => !controller.signal.aborted;
    setBusy(true);
    setFailure(null);
    setScanFailed(false);
    let payload: TypedPairing | null = typeof text === "string" ? null : text;
    let typedCode: string | null = null;
    try {
      if (typeof text === "string") {
        const scanned = readScanned(text);
        if (scanned?.kind === "store") throw new PairError("store-qr");
        if (scanned?.kind === "signin" && followSignInService(text, scanned.service, account)) return;
        if (scanned?.kind === "signin") { await fromQr(scanned, from); return; }
        if (scanned?.kind === "pair") carriedSignIn.current = pairSignIn(text) ?? undefined;
        if (scanned?.kind === "account") { await codeSignIn(scanned.code, null, from); return; }
        if (scanned?.kind === "pair") payload = scanned.payload;
        else if (scanned?.kind === "code") typedCode = scanned.code;
        else throw new PairError("invalid");
      }
      const carried = carriedSignIn.current;
      carriedSignIn.current = undefined;
      // the code's lookup, the sign-in the QR carries and the pairing share one deadline; its end stops their requests
      const work = new AbortController();
      const result = await linkDeadline((async () => {
        if (!payload && typedCode) payload = await resolveTypedCode(typedCode);
        if (!payload) throw new PairError("invalid");
        if (carried && !(await signInWithPairing(carried, payload))) return null;
        return redeemPairing(payload, platform, work.signal);
      })(), LINK_DEADLINE_MS, controller.signal).finally(() => work.abort());
      if (!result || !live()) return;
      await linkDeadline(Promise.resolve(onLinked(result.record, result.token, result.record.label || installationName(payload))), LINK_DEADLINE_MS + 5_000);
    } catch (error) {
      if (!live()) return;
      haptic("error");
      setFailure({ code: error instanceof PairError ? error.code : "unreachable", name: installationName(payload, t("mobile.connection.yourComputer")), companion: payload?.transport === "companion" });
      if (from === "scan") { setStep("code"); setScanFailed(true); }
    } finally {
      if (attempt.current === controller) {
        attempt.current = null;
        locked.current = false;
        setBusy(false);
      }
    }
  };

  /** the 8 letters a desktop or madani cloud showed: the phone logs in to their account and goes on to its cloud */
  const codeSignIn = async (code: string, cloud: string | null, from: Step) => {
    if (!account) throw new PairError("sign-in");
    const result = await account.signIn.phoneCode(code);
    if (result.outcome !== "signed-in") {
      haptic("error");
      setFailure({ code: phoneCodeFailure(result.outcome), name: t("mobile.connection.yourComputer"), companion: false });
      if (from !== "code") { setStep("code"); setValue(formatCode(code)); }
      return;
    }
    haptic("success");
    setJustSignedIn(true);
    setQrTarget({ origin: cloud });
    setNoClouds(false);
    go("clouds");
  };
  /** A signed-in desktop's QR logs the phone in to its account as it pairs: a phone on another account is asked first
   * (false: the pairing waits for that answer); a sign-in that does not take never stops the pairing. */
  const signInWithPairing = async (signIn: PairSignIn, pair: TypedPairing): Promise<boolean> => {
    if (!account || signInServiceSwitch(signIn.service, account.origin)) return true;
    const current = account.account?.email;
    if (current && current.toLowerCase() === signIn.email.toLowerCase()) return true;
    if (current) { setSwitchTo({ email: signIn.email, code: signIn.code, pair }); go("switch"); return false; }
    await linkDeadline(account.signIn.phoneCode(signIn.code), CARRIED_SIGN_IN_MS).catch(() => null);
    return true;
  };
  /** a madani cloud's QR or link: a phone on another account asks before it switches; one on this account or none goes on */
  const fromQr = async (qr: CloudQr, from: Step) => {
    const current = account?.account?.email;
    if (current && qr.email && current.toLowerCase() !== qr.email.toLowerCase()) { setSwitchTo(qr); go("switch"); return; }
    if (qr.code) { await codeSignIn(qr.code, qr.cloud ?? null, from); return; }
    if (current) { setQrTarget({ origin: qr.cloud ?? null }); setNoClouds(false); go("clouds"); return; }
    setSignInEmail(qr.email);
    setNoClouds(false);
    go("signin");
  };
  const confirmSwitch = async () => {
    const qr = switchTo;
    if (!qr || !account || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      setSwitchTo(null);
      if (qr.pair && qr.code) {
        await linkDeadline(account.signIn.phoneCode(qr.code), CARRIED_SIGN_IN_MS).catch(() => null);
        const pair = qr.pair;
        // the link goes on on its own screen, where it shows it is linking and how it ended
        setConfirm(pair);
        setStep("confirm");
        queueMicrotask(() => void redeem(pair, "confirm"));
        return;
      }
      if (qr.code) { await codeSignIn(qr.code, qr.cloud ?? null, "switch"); return; }
      setSignInEmail(qr.email);
      setNoClouds(false);
      go("signin");
    } catch {
      haptic("error");
      setFailure({ code: "account-offline", name: t("mobile.connection.yourComputer"), companion: false });
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  const linkCode = useRef(signInCode);
  useEffect(() => {
    const code = linkCode.current;
    linkCode.current = undefined;
    if (code) void redeem(email ? universalSignInLink(email, code, null, signInCloud) : code, "code");
  }, []);

  // the system's own camera question comes up over this screen the moment the scanner is asked for; a no stays here, said
  // in one line with the way to Settings
  const openScanner = async () => {
    setFailure(null);
    setCameraDenied(false);
    const camera = platform.camera;
    if (!camera) { go("code"); return; }
    let state: CameraPermission = await camera.permission().catch(() => "prompt");
    if (state === "prompt") {
      state = await camera.request().catch(() => "denied" as const);
      // the OS prompt pauses the app; the camera only opens once it is back in front
      if (state === "granted") await new Promise((resolve) => setTimeout(resolve, 450));
    }
    if (state === "granted") go("scan");
    else { haptic("error"); setCameraDenied(true); }
  };
  const cameraLine = cameraDenied ? (
    <ErrorLine action={platform.camera?.openSettings ? <button type="button" data-camera-settings="" onClick={() => void platform.camera?.openSettings?.()} className="mobile-press -ms-2 mt-1 flex min-h-11 items-center rounded-full px-2 text-[15px] font-semibold text-ink underline underline-offset-2">{t("mobile.onboarding.openSettings")}</button> : null}>
      {t("mobile.onboarding.deniedBody")}
    </ErrorLine>
  ) : null;
  // another account signs in beside this one, which stays with its clouds
  const otherAccount = () => {
    setQrTarget(null);
    setSignInEmail("");
    setNoClouds(false);
    go("signin");
  };

  const linkedEmail = useRef(startAt === "signin" && !signInCode ? email : undefined);
  const accountEmail = account?.account?.email;
  useEffect(() => {
    const wanted = linkedEmail.current;
    if (!wanted || !accountEmail) return;
    linkedEmail.current = undefined;
    if (accountEmail.toLowerCase() !== wanted.toLowerCase()) void fromQr({ email: wanted, ...(signInCloud ? { cloud: signInCloud } : {}) }, "signin");
  }, [accountEmail]);
  const paste = async () => {
    const text = await platform.readClipboard?.();
    if (text) setValue(text.trim());
  };

  // android's back walks the same way the on-screen buttons do, and leaves the app from the first screen. without a
  // listener capacitor swallows the press, so back did nothing at all before pairing
  const onBack = useRef<() => boolean>(() => false);
  onBack.current = () => {
    cancelLink();
    const canClose = Boolean(startAtLink && onCancel);
    switch (step) {
      case "welcome": if (canClose) leave(); return canClose;
      case "clouds": if (canClose) leave(); else go("welcome"); return true;
      case "switch": setSwitchTo(null); if (canClose) leave(); else go(home); return true;
      case "signin": go("welcome"); return true;
      case "paste": go("code"); return true;
      case "confirm": setConfirm(null); setFailure(null); if (canClose) leave(); else go(home); return true;
      default: go(home); return true;
    }
  };
  const backListener = useRef(() => onBack.current());
  useEffect(() => platform.onBack?.(backListener.current), [platform]);
  const firstScreen = step === "welcome" && !busy && !(startAtLink && onCancel);
  const canLeave = Boolean(startAtLink && onCancel);
  useEffect(() => platform.backAtRoot?.(backListener.current, firstScreen), [platform, firstScreen]);

  const back = (to: Step = home) => <BackButton onClick={() => go(to)} />;
  const close = startAtLink && onCancel ? <BackButton close onClick={leave} /> : null;
  const download = (
    <p className="mt-5 text-[14px] leading-5 text-ink-secondary">
      {t("mobile.entry.noApp")}{" "}
      <button type="button" className="font-semibold text-ink underline underline-offset-2" onClick={() => void platform.openExternal(DOWNLOAD_URL)}>{t("mobile.entry.download")}</button>
    </p>
  );

  return (
    <main className="madani-mobile relative size-full overflow-hidden bg-app text-ink" data-scan-clear aria-busy={busy}>
      <AnimatePresence mode="wait" initial={false}>
        {step === "welcome" && (
          <StepPane id="welcome">
            <Screen top={close} art={<MascotTrio scale={1.4} />} actions={<>
              <button type="button" data-entry="scan" className={PRIMARY} onClick={() => void openScanner()}><QrCode size={20} />{t("mobile.entry.scan")}</button>
              <button type="button" data-entry="signin" className={TONAL} onClick={() => go(signedIn ? "clouds" : "signin")}><UserRound size={20} />{t("mobile.entry.signInCloud")}</button>
              <button type="button" data-entry="code" className={`${QUIET} gap-2`} onClick={() => go("code")}><Keyboard size={18} />{t("mobile.entry.code")}</button>
            </>}>
              {reason === "revoked" && <ErrorLine>{t("mobile.pair.revoked")}</ErrorLine>}
              <h1 className={`${HEADLINE} ${reason === "revoked" ? "mt-5" : ""}`}>{t(startAtLink ? "mobile.entry.addTitle" : "mobile.entry.title")}</h1>
              <p className={LINE}>{t(storeApp() ? "mobile.entry.bodyStore" : "mobile.entry.body")}</p>
              {cameraLine}
              {download}
            </Screen>
          </StepPane>
        )}

        {step === "signin" && (
          <StepPane id="signin">
            <Screen top={back("welcome")} align="top" actions={null}>
              <MobileSignIn initialEmail={signInEmail} onSignedIn={() => { setJustSignedIn(true); go("clouds"); }} />
            </Screen>
          </StepPane>
        )}

        {step === "clouds" && (
          <StepPane id="clouds">
            <Screen top={close ?? back("welcome")} art={noClouds ? <PixelArt name="signpost" size={84} /> : <PixelMascot color="blue" size={64} />} actions={<>
              {noClouds && <button type="button" className={TONAL} onClick={() => void openScanner()}><QrCode size={20} />{t("mobile.entry.scan")}</button>}
              {noClouds && <button type="button" className={TONAL} onClick={() => go("code")}><Keyboard size={20} />{t("mobile.entry.code")}</button>}
              {!noClouds && <button type="button" disabled={busy} className={QUIET} onClick={() => go("welcome")}>{t("mobile.entry.otherWays")}</button>}
              {signedIn && <button type="button" data-entry="other-account" disabled={busy || signingOut} className={QUIET} onClick={otherAccount}>{t("mobile.clouds.addAccount")}</button>}
              {signedIn && !startAtLink && <button type="button" data-entry="sign-out" disabled={busy || signingOut} className={QUIET}
                onClick={() => { setSigningOut(true); void account?.signOutOfPhone().catch(() => setSigningOut(false)); }}>{signingOut ? <WorkingDots /> : t("accountGate.signOut")}</button>}
            </>}>
              <h1 className={HEADLINE}>{t(noClouds ? storeApp() ? "mobile.clouds.noneTitleStore" : "mobile.clouds.noneTitle" : withComputers ? "mobile.clouds.pickAnyTitle" : "mobile.clouds.pickTitle")}</h1>
              <p className={LINE}>{t(noClouds ? storeApp() ? "mobile.clouds.noneStore" : "mobile.clouds.none" : withComputers ? "mobile.clouds.pickAnyBody" : "mobile.clouds.pickBody", { email: account?.account?.email ?? "" })}</p>
              <CloudPicker busy={busy} autoPick={!startAtLink && justSignedIn} target={qrTarget} onOpen={onOpen} onNone={() => setNoClouds(true)} onComputers={setWithComputers} onPairing={(payload) => redeem(payload, "clouds")} />
              {failure && <Failed failure={failure} />}
              {cameraLine}
            </Screen>
          </StepPane>
        )}

        {step === "switch" && switchTo && (
          <StepPane id="switch">
            <Screen top={close ?? back()} art={<PixelArt name="key" size={84} />} actions={<>
              <button type="button" data-entry="switch-account" disabled={busy} className={PRIMARY} onClick={() => void confirmSwitch()}>{busy ? <WorkingDots /> : t("mobile.clouds.switchAccount")}</button>
              <button type="button" disabled={busy} className={QUIET} onClick={() => { setSwitchTo(null); if (canLeave) leave(); else go(home); }}>{t("mobile.pair.cancel")}</button>
            </>}>
              <h1 className={HEADLINE}>{t("mobile.clouds.switchTitle", { email: switchTo.email })}</h1>
              <p className={LINE}>{t("mobile.clouds.switchKeeps", { current: account?.account?.email ?? "" })}</p>
              {failure && <Failed failure={failure} />}
            </Screen>
          </StepPane>
        )}

        {step === "confirm" && confirm && (
          <StepPane id="confirm">
            <Screen art={<PixelArt name="computer" size={84} />} actions={<>
              <button type="button" disabled={busy} className={PRIMARY} onClick={() => void redeem(confirm, "confirm")}>{busy ? <WorkingDots /> : t("mobile.pair.link")}</button>
              <button type="button" data-link-cancel="" className={QUIET} onClick={() => { cancelLink(); setConfirm(null); setFailure(null); if (onCancel && startAtLink) leave(); else go(home); }}>{t("mobile.pair.cancel")}</button>
            </>}>
              <h1 className={HEADLINE}>{t("mobile.pair.confirm", { name: installationName(confirm) })}</h1>
              <p className={LINE}>{t("mobile.onboarding.confirmBody")}</p>
              {failure && <Failed failure={failure} onSignIn={() => go(signedIn ? "clouds" : "signin")} />}
            </Screen>
          </StepPane>
        )}

        {(step === "code" || step === "paste") && (
          <StepPane id={step}>
            <form className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={(event) => { event.preventDefault(); if (value.trim()) void redeem(value, step); }}>
              <div className="flex h-[calc(var(--m-safe-top)+60px)] shrink-0 items-end px-4 pb-2">{back(step === "paste" ? "code" : home)}</div>
              <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-4 text-center">
                <PixelArt name="computer" size={76} className="mb-5" />
                <h1 className={HEADLINE}>{t(step === "code" ? "mobile.onboarding.codeTitle" : "mobile.onboarding.pasteTitle")}</h1>
                <p className={LINE}>{t(step === "code" ? "mobile.entry.codeBody" : "mobile.onboarding.pasteBody")}</p>
                <div className="mt-7 w-full text-left">
                  <label htmlFor={fieldId} className="mb-1.5 block px-1 text-[15px] font-medium text-ink">{t(step === "code" ? "mobile.onboarding.codeLabel" : "mobile.onboarding.pasteLabel")}</label>
                  {step === "code" ? (
                    <input ref={codeField} id={fieldId} autoFocus value={value} readOnly={busy}
                      onChange={(event) => {
                        const typed = event.target;
                        const next = editCode(value, typed.value, typed.selectionStart ?? typed.value.length);
                        caret.current = next.caret;
                        setValue(next.value);
                        if (failure) setFailure(null);
                        const full = fullCode(next.value);
                        if (full && sentCode.current !== full) { sentCode.current = full; void redeem(next.value, "code"); }
                        else if (!full) sentCode.current = null;
                      }}
                      inputMode="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX"
                      aria-invalid={Boolean(failure) || undefined}
                      className={`${FIELD} text-center font-mono text-[19px] tracking-[0.1em] placeholder:text-ink/[0.3]`} />
                  ) : (
                    <div className="flex w-full gap-2">
                      <input id={fieldId} autoFocus value={value} disabled={busy} onChange={(event) => { setValue(event.target.value); setFailure(null); }}
                        inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="madanibot://pair?..." aria-invalid={Boolean(failure) || undefined}
                        className={`${FIELD} flex-1`} />
                      {platform.readClipboard && <button type="button" onClick={() => void paste()} aria-label={t("mobile.onboarding.pasteFromClipboard")} className="mobile-press flex size-[52px] shrink-0 items-center justify-center rounded-[16px] bg-ink/[0.06] text-ink"><ClipboardPaste size={20} /></button>}
                    </div>
                  )}
                  {failure && <Failed failure={failure} onSignIn={() => go(signedIn ? "clouds" : "signin")} />}
                  {cameraLine}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-center gap-1 px-6 pb-[calc(var(--m-safe-bottom)+16px)] pt-4">
                {scanFailed && !value.trim() && !busy
                  ? <button type="button" data-scan-again="" className={PRIMARY} onClick={() => void openScanner()}><QrCode size={20} />{t("mobile.onboarding.scanAgain")}</button>
                  : <button type="submit" disabled={busy || !value.trim() || (step === "code" && !typedCodeComplete(value))} className={PRIMARY}>{busy ? <WorkingDots /> : t(failure ? "mobile.onboarding.retry" : "mobile.pair.link")}</button>}
                {step === "code" && <button type="button" className={QUIET} onClick={() => { setValue(""); setFailure(null); setStep("paste"); }}>{t("mobile.onboarding.pasteInstead")}</button>}
              </div>
            </form>
          </StepPane>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {step === "scan" && (
          <Scanner key="scan" platform={platform} busy={busy}
            onCode={(text) => void redeem(text, "scan")}
            onClose={() => go(home)} onEnterCode={() => go("code")} onPaste={() => go("paste")} />
        )}
      </AnimatePresence>
    </main>
  );
}
