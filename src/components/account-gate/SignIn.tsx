import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { MausAvatar } from "@/components/Avatar";
import { CodeBoxes, codeDigits } from "@/components/cloud-buy/CodeBoxes";
import { problemLine } from "@/components/cloud-buy/SignInScreen";
import type { CloudSignInProblem } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import type { CloudSignInStart } from "../../../electron/cloud-account.mjs";
import { OAUTH_PROVIDERS, type OAuthProvider } from "../../../shared/account-api";
import type { SignInVerify } from "./bridge";

const PILL = "flex min-h-11 w-full items-center justify-center rounded-full border border-transparent px-5 text-[14px] font-medium outline-none focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
const FIELD = "h-11 w-full rounded-xl border border-transparent bg-transparent px-3 text-[16px] text-ink outline-none focus:border-ink disabled:opacity-50";
const LINK = "min-h-11 self-center rounded-full px-3 text-[13px] text-ink-secondary underline underline-offset-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40";
export const SUPPORT_ADDRESS = "hello@madani.bot";
export type SignInOptions = { providers: OAuthProvider[]; recovery: boolean };

export function SignIn({ emailStart, emailVerify, browser, cancelEmail, onSignedIn, notice, note, mobile = false, options, children, marks }: {
  emailStart(email: string, options?: { recover: true }): Promise<CloudSignInStart>;
  emailVerify(code: string): Promise<SignInVerify>;
  browser(provider: OAuthProvider): Promise<unknown>;
  cancelEmail?(): Promise<unknown>;
  onSignedIn(): void;
  notice?: string;
  /** A quiet fact about this computer, under the form while no code is out. */
  note?: string;
  mobile?: boolean;
  /** The providers the account service says sign in, and "Can't sign in?". Without it (the phone's sheet) every provider shows. */
  options?(): Promise<SignInOptions>;
  /** Shown under the form while no code is out: the phone's demo entry and legal links. */
  children?: ReactNode;
  /** Each provider's own mark before its name, and a fill where the provider's button rules ask for one. */
  marks?: Partial<Record<OAuthProvider, { icon: ReactNode; className?: string }>>;
}) {
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<Extract<CloudSignInStart, { outcome: "sent" }> | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [problem, setProblem] = useState<CloudSignInProblem | null>(null);
  const [triesLeft, setTriesLeft] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [recover, setRecover] = useState(false);
  // asked once: a provider shows only once the service says it signs in, and none when it can't be asked
  const ask = useRef(options);
  const [providers, setProviders] = useState<readonly OAuthProvider[] | null>(options ? null : OAUTH_PROVIDERS);
  useEffect(() => {
    if (!ask.current) return;
    let alive = true;
    void ask.current().then(answer => { if (alive) setProviders(answer.providers.filter(provider => OAUTH_PROVIDERS.includes(provider))); }, () => { if (alive) setProviders([]); });
    return () => { alive = false; };
  }, []);
  useEffect(() => { host.current?.querySelector<HTMLInputElement>("[data-autofocus]")?.focus(); }, [sent]);
  useEffect(() => {
    if (!sent) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sent]);
  const run = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setProblem(null);
    try { await work(); } catch { setProblem("failed"); }
    finally { locked.current = false; setBusy(false); }
  };
  const send = () => run(async () => {
    const result = await (recover ? emailStart(email, { recover: true }) : emailStart(email));
    if (result.outcome === "sent") { setSent(result); setEmail(result.email); setCode(""); setNow(Date.now()); }
    else setProblem(result.outcome);
  });
  const verify = (digits: string) => {
    if (digits.length !== 8) return;
    void run(async () => {
      const result = await emailVerify(digits);
      if (result.outcome === "signed-in") onSignedIn();
      else { setProblem(result.outcome); setTriesLeft(result.outcome === "wrong-code" ? result.triesLeft : null); }
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!sent) { if (email.trim()) void send(); return; }
    verify(code);
  };
  return <main className={`${mobile ? "madani-mobile " : ""}flex size-full min-h-0 flex-col items-center overflow-y-auto bg-app px-6 py-8 text-ink`}>
    <div ref={host} className="my-auto flex w-full max-w-[360px] flex-col gap-4">
      <div className="flex justify-center" aria-hidden="true"><MausAvatar color="green" size={80} state="idle" animated={false} personality={false} /></div>
      <div className="text-center"><h1 className="text-[24px] font-semibold tracking-tight">{t(recover ? "accountGate.cantSignIn" : "accountGate.title")}</h1><p className="mt-2 text-[14px] leading-5 text-ink-secondary">{t(recover ? "accountGate.recoverSub" : "accountGate.sub")}</p></div>
      {notice && !recover && <p role="status" className="text-[13px] text-ink-secondary">{notice}</p>}
      {!recover && providers && providers.length > 0 && <><div className="flex flex-col gap-2">{providers.map(provider => <button key={provider} type="button" className={`${PILL} gap-2 ${marks?.[provider]?.className ?? "hover:bg-ink/[0.05]"}`} disabled={busy} onClick={() => void run(async () => { await browser(provider); })}>{marks?.[provider]?.icon}{t(provider === "google" ? "accountGate.google" : "accountGate.apple")}</button>)}</div>
      <div className="flex items-center gap-3 text-[13px] text-ink-tertiary"><span className="h-px flex-1 bg-ink/10" />{t("accountGate.or")}<span className="h-px flex-1 bg-ink/10" /></div></>}
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {!sent ? <><label htmlFor={`${id}-email`} className="text-[14px] text-ink-secondary">{t("cloudBuy.signIn.email")}</label>
          <input id={`${id}-email`} data-autofocus type="email" inputMode="email" autoComplete="email" spellCheck={false} disabled={busy} value={email} onChange={event => setEmail(event.target.value)} className={FIELD} aria-invalid={problem === "invalid-email" || undefined} />
        </> : <><p id={`${id}-code`} className="text-[14px] text-ink-secondary">{t("cloudBuy.signIn.codeLabel", { email: sent.email })}{" "}<button type="button" className="underline underline-offset-2" disabled={busy} onClick={() => void run(async () => { await cancelEmail?.(); setSent(null); setCode(""); })}>{t("cloudBuy.signIn.change")}</button></p>
          <div className="[&_input:focus]:border-ink"><CodeBoxes code={code} onCode={value => { const digits = codeDigits(value); setCode(digits); if (digits.length === 8 && digits !== code && !busy) verify(digits); }} busy={busy} wrong={problem === "wrong-code"} labelId={`${id}-code`} problemId={problem ? `${id}-problem` : undefined} /></div>
          {recover ? <p className="text-[13px] text-ink-secondary">{t("accountGate.recoverSent")}</p>
            : sent.signupOpen === false && <p className="text-[13px] text-ink-secondary">{t("cloudBuy.signIn.signupClosedNote")}</p>}
        </>}
        <button type="submit" disabled={busy || (sent ? code.length !== 8 : !email.trim())} className={`${PILL} bg-ink text-app hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink`}>{t(busy ? "cloudBuy.signIn.checking" : sent ? "accountGate.verify" : recover ? "accountGate.recoverSend" : "cloudBuy.signIn.send")}</button>
        {sent && <button type="button" className="min-h-11 text-[13px] underline underline-offset-2 disabled:opacity-40" disabled={busy || (problem !== "expired" && now < sent.resendAt)} onClick={() => void send()}>{t("cloudBuy.signIn.resend")}</button>}
        {problem && <p id={`${id}-problem`} role="alert" className="text-[13px] text-ink">{problemLine(problem, triesLeft)}</p>}
      </form>
      {options && !mobile && !sent && !recover && <button type="button" className={LINK} disabled={busy} onClick={() => { setRecover(true); setProblem(null); }}>{t("accountGate.cantSignIn")}</button>}
      {recover && !sent && <section aria-labelledby={`${id}-lost`} className="flex flex-col gap-1 border-t border-transparent pt-4">
        <h2 id={`${id}-lost`} className="text-[14px] font-medium">{t("accountGate.lostTitle")}</h2>
        <p className="text-[13px] leading-5 text-ink-secondary">{t("accountGate.lostBody", { address: SUPPORT_ADDRESS })}</p>
        <button type="button" className={`${LINK} mt-2`} disabled={busy} onClick={() => { setRecover(false); setProblem(null); }}>{t("accountGate.back")}</button>
      </section>}
      {note && !sent && !recover && <p className="text-center text-[13px] leading-5 text-ink-tertiary">{note}</p>}
      {!sent && !recover && children}
    </div>
  </main>;
}
