// Screen 2: sign in inside the sheet with an emailed code; single sign-on and two-step accounts continue in the browser.
import type { FormEvent } from "react";
import { Check, ExternalLink, Loader2 } from "../../icons";
import { CodeBoxes } from "./CodeBoxes";
import type { CloudSignInPhase, CloudSignInProblem } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { ACTIONS, BackLink, FIELD, Heading, LINK, PRIMARY, PRIMARY_WIDE, QUIET, SCREEN } from "./parts";

export { codeDigits } from "./CodeBoxes";

const BROWSER_PROBLEMS: ReadonlySet<CloudSignInProblem> = new Set(["sso", "two-factor", "browser"]);

export function problemLine(problem: CloudSignInProblem, triesLeft: number | null): string {
  switch (problem) {
    case "invalid-email": return t("cloudBuy.signIn.invalidEmail");
    case "rate-limited": return t("cloudBuy.signIn.rateLimited");
    case "wrong-code": return triesLeft === 1 ? t("cloudBuy.signIn.wrongCodeOne") : t("cloudBuy.signIn.wrongCode", { count: triesLeft ?? 0 });
    case "expired": return t("cloudBuy.signIn.expired");
    case "signup-closed": return t("cloudBuy.signIn.signupClosed");
    case "device-limit": return t("cloudBuy.signIn.deviceLimit");
    case "sso": return t("cloudBuy.signIn.sso");
    case "two-factor": return t("cloudBuy.signIn.twoFactor");
    case "browser": return t("cloudBuy.signIn.browser");
    case "storage": return t("cloudBuy.signIn.storage");
    case "failed": return t("cloudBuy.signIn.failed");
  }
}

const clock = (ms: number) => { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };

export function SignInScreen({ phase, email, code, profileEmail, busy, now, onBack, onEmail, onSend, onChangeEmail, onCode, onResend, onBrowser, heading, backLabel }: {
  phase: CloudSignInPhase; email: string; code: string; profileEmail: string | null; busy: boolean; now: number;
  /** A sign-in that isn't about madani cloud or a plan: its own title and way back. */
  heading?: string; backLabel?: string;
  onBack: () => void; onEmail: (email: string) => void; onSend: () => void; onChangeEmail: () => void;
  onCode: (code: string) => void; onResend: () => void; onBrowser: () => void;
}) {
  const problem = phase.step === "done" ? null : phase.problem;
  const browser = problem !== null && BROWSER_PROBLEMS.has(problem);
  const title = heading ?? (phase.intent ? t("cloudBuy.signIn.title") : t("cloudBuy.signIn.titlePlain"));
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy) onSend(); };
  return <div data-cloud-add={`sign-in-${phase.step}`} className={SCREEN}>
    <div className="flex flex-col gap-3">
      <BackLink label={backLabel ?? t("cloudBuy.back")} onClick={onBack} />
      <Heading title={title} sub={t("cloudBuy.signIn.sub")} />
    </div>
    {phase.step === "email" && <form className="flex flex-col gap-1.5" onSubmit={submit} noValidate>
      <label htmlFor="cloud-add-email" className="text-[13px] leading-[18px] text-ink-secondary">{t("cloudBuy.signIn.email")}</label>
      <input id="cloud-add-email" data-autofocus type="email" autoComplete="email" inputMode="email" spellCheck={false} value={email} disabled={busy}
        aria-invalid={problem === "invalid-email" || undefined} aria-describedby={problem ? "cloud-add-problem" : undefined}
        onChange={event => onEmail(event.target.value)} className={FIELD} />
      <button type="submit" className={`${PRIMARY_WIDE} mt-2`} disabled={busy || !email.trim()}>
        {busy && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{t("cloudBuy.signIn.send")}
      </button>
      {profileEmail && email.trim().toLowerCase() === profileEmail.trim().toLowerCase() && <p className="text-[13px] leading-[18px] text-ink-tertiary">{t("cloudBuy.signIn.fromProfile")}</p>}
    </form>}
    {phase.step === "code" && <div className="flex flex-col gap-2.5">
      <p id="cloud-add-code-label" className="text-[13px] leading-[18px] text-ink-secondary">
        {t("cloudBuy.signIn.codeLabel", { email: phase.email })} · <button type="button" className={LINK} disabled={busy} onClick={onChangeEmail}>{t("cloudBuy.signIn.change")}</button>
      </p>
      <CodeBoxes code={code} onCode={onCode} busy={busy} wrong={problem === "wrong-code"} labelId="cloud-add-code-label" problemId={problem ? "cloud-add-problem" : undefined} />
      {phase.signupOpen === false && <p data-cloud-signup-closed className="text-[13px] leading-[18px] text-ink-secondary">{t("cloudBuy.signIn.signupClosedNote")}</p>}
      <div className="flex min-h-6 items-center justify-between gap-3 text-[13px] text-ink-tertiary">
        {busy ? <span role="status" className="inline-flex items-center gap-1.5"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{t("cloudBuy.signIn.checking")}</span>
          : phase.resendAt > now ? <span>{t("cloudBuy.signIn.resendIn", { time: clock(phase.resendAt - now) })}</span>
            : <button type="button" className={LINK} onClick={onResend}>{t("cloudBuy.signIn.resend")}</button>}
      </div>
    </div>}
    {phase.step === "done" && <p role="status" className="flex items-center gap-2 text-[14px] leading-5 text-ink">
      <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-ink text-app"><Check size={12} strokeWidth={2.4} /></span>
      {phase.intent ? t("cloudBuy.signIn.done") : t("cloudBuy.signIn.donePlain")}
    </p>}
    {problem && <div id="cloud-add-problem" role="alert" className="flex flex-col items-start gap-3 text-[13px] leading-[18px] text-ink">
      <p>{problemLine(problem, phase.step === "code" ? phase.triesLeft : null)}</p>
      {browser && <button type="button" className={PRIMARY} onClick={onBrowser}>{t("cloudBuy.signIn.continueBrowser")}<ExternalLink size={14} aria-hidden="true" /></button>}
      {problem === "expired" && phase.step === "code" && <button type="button" className={QUIET} disabled={busy} onClick={onResend}>{t("cloudBuy.signIn.newCode")}</button>}
    </div>}
    {phase.step !== "done" && !browser && <p className="text-[13px] leading-[18px] text-ink-tertiary">{t("cloudBuy.signIn.ssoHint")}{" "}
      <button type="button" className={LINK} onClick={onBrowser}>{t("cloudBuy.signIn.continueBrowser")}</button></p>}
  </div>;
}

/** The browser approval (single sign-on, two-step, or an older Cloud): the code to check, and the browser again. */
export function BrowserSignInScreen({ code, checkout, trial, busy, onReopen, onCancel }: {
  code: string | null; checkout: boolean; trial: boolean; busy: boolean; onReopen: () => void; onCancel: () => void;
}) {
  return <div data-cloud-add="signing-in" className={SCREEN}>
    <Heading title={t("cloudAdd.browserTitle")} />
    {code ? <ol className="flex list-decimal flex-col gap-1.5 ps-5 text-[14px] leading-5 text-ink marker:text-ink-tertiary">
      <li>{t("cloudAdd.signInStep1")}</li>
      <li>{t("cloudAccount.codeCheck")}<code dir="ltr" className="mt-1.5 block w-fit select-all rounded-[10px] bg-ink/[0.05] px-3 py-1.5 font-mono text-[17px] font-medium tracking-[0.12em]">{code}</code></li>
      <li>{t(!checkout ? "cloudAdd.signInStep3Connect" : trial ? "cloudAdd.signInStep3Trial" : "cloudAdd.signInStep3")}</li>
    </ol> : <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{t("cloudAdd.opening")}</p>}
    <div className={ACTIONS}>
      <button type="button" className={QUIET} disabled={busy} onClick={onCancel}>{t("cloudAdd.cancel")}</button>
      <button type="button" className={PRIMARY} disabled={busy || !code} onClick={onReopen}>{t("cloudAdd.reopenBrowser")}<ExternalLink size={14} aria-hidden="true" /></button>
    </div>
  </div>;
}
