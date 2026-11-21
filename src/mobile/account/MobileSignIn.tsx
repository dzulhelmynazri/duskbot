import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { storeApp } from "@/lib/store-app";
import { WorkingDots } from "@/components/WorkingIndicator";
import { problemLine } from "@/components/cloud-buy/SignInScreen";
import type { CloudSignInProblem } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import type { CloudSignInStart } from "../../../electron/cloud-account.mjs";
import type { OAuthProvider } from "../../../shared/account-api";
import { haptic } from "../haptics";
import { PixelArt } from "../Illustration";
import { usePlatform } from "../platform";
import { LEGAL_LINKS } from "../legal";
import { ErrorLine, FIELD, HEADLINE, LINE, PRIMARY, QUIET, TONAL } from "../onboarding/parts";
import { useMobileAccount } from "./AccountGate";
import { MARKS } from "./marks";

const PROVIDER_LABEL = { apple: "accountGate.apple", google: "accountGate.google" } as const;
const CODE_LENGTH = 8;

const digits = (value: string) => value.replace(/\D/g, "").slice(0, CODE_LENGTH);

/** The phone's own madani account sign-in, in the app's look: the providers the service has on, then an emailed code in one
 * field (the system offers it from Messages or Mail), with every problem said next to the field it is about. */
export function MobileSignIn({ onSignedIn, initialEmail = "" }: { onSignedIn: () => void; initialEmail?: string }) {
  const account = useMobileAccount();
  const platform = usePlatform();
  const id = useId();
  const [providers, setProviders] = useState<OAuthProvider[] | null>(null);
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState<Extract<CloudSignInStart, { outcome: "sent" }> | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ kind: CloudSignInProblem; triesLeft: number | null } | null>(null);
  const [now, setNow] = useState(Date.now());
  const locked = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const signIn = account?.signIn;

  useEffect(() => {
    if (!signIn) return;
    let alive = true;
    void signIn.providers().then((list) => { if (alive) setProviders(list); }, () => { if (alive) setProviders([]); });
    return () => { alive = false; };
  }, [signIn]);
  const signInsAtOpen = useRef(account?.signIns ?? 0);
  const signIns = account?.signIns ?? 0;
  const signedInHere = Boolean(account?.account) && signIns !== signInsAtOpen.current;
  useEffect(() => { if (signedInHere) onSignedIn(); }, [signedInHere, signIns, onSignedIn]);
  useEffect(() => {
    if (!sent) return;
    field.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sent]);

  if (!signIn) return null;

  const run = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setProblem(null);
    try { await work(); } catch { setProblem({ kind: "failed", triesLeft: null }); }
    finally { locked.current = false; setBusy(false); }
  };
  const send = () => run(async () => {
    const result = await signIn.emailStart(email);
    if (result.outcome === "sent") { setSent(result); setEmail(result.email); setCode(""); setNow(Date.now()); }
    else { haptic("error"); setProblem({ kind: result.outcome, triesLeft: null }); }
  });
  const verify = (value: string) => run(async () => {
    const result = await signIn.emailVerify(value);
    if (result.outcome === "signed-in") { haptic("success"); signIn.signedIn(); return; }
    haptic("error");
    setProblem({ kind: result.outcome, triesLeft: result.outcome === "wrong-code" ? result.triesLeft : null });
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!sent) { if (email.trim()) void send(); return; }
    if (code.length === CODE_LENGTH) void verify(code);
  };
  const problemId = `${id}-problem`;
  const problemText = problem ? problemLine(problem.kind, problem.triesLeft) : signIn.problem;

  return (
    <form onSubmit={submit} noValidate className="flex w-full flex-col items-center">
      <PixelArt name={sent ? "mailbox" : "key"} size={60} className="mb-4" />
      <h1 className={HEADLINE}>{t(sent ? "mobile.entry.codeSentTitle" : "mobile.entry.signInTitle")}</h1>
      <p className={LINE}>{sent ? t("mobile.entry.codeSentBody", { email: sent.email }) : t(storeApp() ? "mobile.entry.signInBodyStore" : "mobile.entry.signInBody")}</p>

      {!sent && providers && providers.length > 0 && (
        <div className="mt-7 flex w-full flex-col gap-2.5">
          {providers.map((provider) => (
            <button key={provider} type="button" disabled={busy} className={TONAL}
              onClick={() => void run(async () => { await signIn.browser(provider); })}>
              {MARKS[provider]}{t(PROVIDER_LABEL[provider])}
            </button>
          ))}
          <div aria-hidden className="my-1.5 flex items-center gap-3 text-[14px] text-ink-tertiary"><span className="h-px flex-1 bg-ink/[0.08]" />{t("accountGate.or")}<span className="h-px flex-1 bg-ink/[0.08]" /></div>
        </div>
      )}

      {!sent ? (
        <div className={`w-full text-left ${providers?.length ? "" : "mt-7"}`}>
          <label htmlFor={`${id}-email`} className="mb-1.5 block px-1 text-[15px] font-medium text-ink">{t("cloudBuy.signIn.email")}</label>
          <input id={`${id}-email`} ref={field} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} disabled={busy}
            placeholder={t("mobile.entry.emailPlaceholder")} value={email} onChange={(event) => { setEmail(event.target.value); setProblem(null); }}
            aria-invalid={Boolean(problem) || undefined} aria-describedby={problemText ? problemId : undefined} className={FIELD} />
          {problemText && <ErrorLine id={problemId}>{problemText}</ErrorLine>}
        </div>
      ) : (
        <div className="mt-7 w-full text-left">
          <label htmlFor={`${id}-code`} className="mb-1.5 block px-1 text-[15px] font-medium text-ink">{t("mobile.entry.codeLabel")}</label>
          <input id={`${id}-code`} ref={field} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={CODE_LENGTH} disabled={busy}
            placeholder="00000000" value={code} aria-invalid={Boolean(problem) || undefined} aria-describedby={problemText ? problemId : undefined}
            onChange={(event) => {
              const next = digits(event.target.value);
              setCode(next);
              setProblem(null);
              if (next.length === CODE_LENGTH) void verify(next);
            }}
            className={`${FIELD} text-center font-mono text-[21px] tracking-[0.16em] tabular-nums placeholder:text-ink/[0.18]`} />
          {problemText && <ErrorLine id={problemId}>{problemText}</ErrorLine>}
        </div>
      )}

      <div className="mt-5 flex w-full flex-col gap-1">
        <button type="submit" disabled={busy || (sent ? code.length !== CODE_LENGTH : !email.trim())} className={PRIMARY}>
          {busy ? <WorkingDots /> : t(sent ? "accountGate.verify" : "cloudBuy.signIn.send")}
        </button>
        {sent ? (
          <div className="flex justify-center gap-1">
            <button type="button" className={`${QUIET} w-auto px-4`} disabled={busy} onClick={() => { signIn.cancelEmail(); setSent(null); setCode(""); setProblem(null); }}>{t("mobile.entry.changeEmail")}</button>
            <button type="button" className={`${QUIET} w-auto px-4`} disabled={busy || (problem?.kind !== "expired" && now < sent.resendAt)} onClick={() => void send()}>{t("mobile.entry.resend")}</button>
          </div>
        ) : (
          <p className="mt-3 text-center text-[13px] leading-5 text-ink-secondary">
            {t("mobile.entry.legalBefore")}{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => void platform.openExternal(LEGAL_LINKS.terms)}>{t("mobile.settings.terms")}</button>
            {" "}{t("mobile.entry.legalAnd")}{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => void platform.openExternal(LEGAL_LINKS.privacy)}>{t("mobile.settings.privacy")}</button>
          </p>
        )}
      </div>
    </form>
  );
}
