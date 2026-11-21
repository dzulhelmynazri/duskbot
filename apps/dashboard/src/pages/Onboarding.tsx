import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, LoaderCircle, Monitor } from "@/icons";
import meadow from "../art/p-meadow.webp";
import layers from "../art/wide-layers-plain.webp";
import { useCloud } from "../data/cloud";
import type { BillingInterval, PlanCatalog } from "../data/contracts";
import { bundleOf } from "../data/pricing";
import { useSession } from "../data/session";
import { api, FIXTURE } from "../lib/api";
import { navigate, useLocation } from "../lib/router";
import { planIntent } from "../lib/site";
import { Downloads } from "../ui/Downloads";
import { StretchPill } from "../ui/Digits";
import { SplitFrame } from "../ui/Frame";
import { Button, cx, Skeleton } from "../ui/kit";
import { Mascot, type MascotHandle } from "../ui/Mascot";
import type { SceneHandle, SceneMood } from "../ui/Scene";
import { points } from "./Billing";
import { CHECKOUT_SOON, trialAction } from "./cloud-offer";
import { track, trackOnboardingStep } from "../lib/analytics";
import { per, planSelection, type PaidPlan } from "./plan-sheet";
import { fromApp } from "../lib/from-app";
import { APP_LANDING_PATH, type WebsiteHome } from "../../../../shared/account-api";

const STEPS = ["name", "plan", "app"] as const;
type Step = (typeof STEPS)[number];
type Home = "cloud" | "free";

const SAVED = "madani-onboarding-step";
/** the end of the first steps for someone the desktop app sent: the way back to it */
const APP_DONE = `${APP_LANDING_PATH}?set=1`;
const isStep = (v: string | null): v is Step => (STEPS as readonly string[]).includes(v ?? "");
const LABELS = ["your name", "pick a home", "get the app"];

function Busy({ children }: { children: ReactNode }) {
  return <><LoaderCircle size={17} strokeWidth={2} className="spin" aria-hidden />{children}</>;
}

/** how far along: a rail that fills, and a small bot that rides its leading edge and hops when a step lands */
function Rail({ at, total }: { at: number; total: number }) {
  const rider = useRef<MascotHandle>(null);
  const last = at === total - 1;
  const part = (at + 1) / total;
  useEffect(() => { rider.current?.react("hop"); }, [at]);
  return (
    <div className="relative mb-10 h-2 rounded-full bg-track [overflow-x:clip]" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={at + 1} aria-label={`step ${at + 1} of ${total}`}>
      <div className="h-full origin-left rounded-full bg-ink transition-transform duration-500 ease-[var(--ease-out)] motion-reduce:transition-none" style={{ transform: `scaleX(${part})` }} />
      <div className="pointer-events-none absolute inset-0 transition-transform duration-500 ease-[var(--ease-pop)] motion-reduce:transition-none" style={{ transform: `translateX(${part * 100}%)` }} aria-hidden>
        <span className="absolute -top-[30px] left-0 -translate-x-full"><Mascot ref={rider} body="tofu" color="pink" size={34} state={last ? "celebrate" : "happy"} /></span>
      </div>
    </div>
  );
}

/** both homes keep the same light card; the chosen one shows a filled dot, never a darker card */
function Dot({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={cx("grid size-4 shrink-0 place-items-center rounded-full transition-colors duration-150 ease-[ease]", on ? "bg-ink-3" : "bg-track")}>
      <span className={cx("size-1.5 rounded-full bg-bg transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none", on ? "scale-100 opacity-100" : "scale-75 opacity-0")} />
    </span>
  );
}

/** madani cloud first and chosen, its plans on a white track with one grey thumb that stretches between them; this
 * computer below it as the free way */
function PlanStep({ catalog, home, setHome, plan, setPlan }: { catalog: PlanCatalog; home: Home; setHome(h: Home): void; plan: PaidPlan; setPlan(p: PaidPlan): void }) {
  const cloud = home === "cloud";
  const plans = (["starter", "pro"] as const).flatMap((id) => { const b = bundleOf(catalog, id); return b ? [{ id, b }] : []; });
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">where your bots live</legend>
      <div className={cx("rounded-[22px] bg-card p-2", !cloud && "hover-card")}>
        <label htmlFor="home-cloud" className="focus-tint block cursor-pointer rounded-[16px]">
          <input id="home-cloud" type="radio" name="home" value="cloud" checked={cloud} onChange={() => setHome("cloud")} className="sr-only" />
          <span className="relative block overflow-hidden rounded-[16px]">
            <img src={meadow} alt="" width={800} height={354} className="h-[84px] w-full object-cover object-bottom" draggable={false} />
            {/* pro has its own scene, crossfading in over plus's meadow */}
            <img src={layers} alt="" width={800} height={354} className={cx("absolute inset-0 h-[84px] w-full object-cover object-bottom transition-opacity duration-300 ease-out motion-reduce:transition-none", plan === "pro" ? "opacity-100" : "opacity-0")} draggable={false} />
            <span className="absolute bottom-1 right-4" aria-hidden><Mascot body="kit" color="blue" size={44} state="working" still /></span>
          </span>
          <span className="flex items-center justify-between gap-3 px-3 pt-4">
            <span className="text-17 font-medium tracking-[-0.02em] text-ink">madani cloud</span>
            <Dot on={cloud} />
          </span>
          <ul key={plan} className="plan-points-in flex flex-col gap-2 px-3 pb-2 pt-3">
            {points(plan, catalog).map((p) => (
              <li key={p} className="flex gap-2.5 text-14 leading-[1.45] text-ink-2">
                <Check size={17} strokeWidth={2} className="mt-0.5 shrink-0 text-good" aria-hidden />{p}
              </li>
            ))}
          </ul>
        </label>
        {cloud && (
          <div role="radiogroup" aria-label="plan" className="step-in relative mt-1 grid grid-cols-2 rounded-full bg-bg p-1">
            <StretchPill target={plan} className="bg-[color-mix(in_oklab,var(--ink)_5%,var(--bg))]" />
            {plans.map(({ id, b }) => {
              const on = plan === id;
              return (
                <button key={id} type="button" role="radio" aria-checked={on} data-stretch-key={id} onClick={() => setPlan(id)}
                  className={cx("relative inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-13", on ? "font-medium text-ink" : "font-normal text-ink-2 hover-link")}>
                  {b.name.toLowerCase()} <span className="num">{per(b.monthly, "month", catalog).amount}/mo</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <label htmlFor="home-free" className={cx("focus-tint mt-2 flex cursor-pointer items-center gap-3.5 rounded-[18px] bg-card py-3.5 pe-5 ps-4", home !== "free" && "hover-card")}>
        <input id="home-free" type="radio" name="home" value="free" checked={home === "free"} onChange={() => setHome("free")} className="sr-only" />
        <Monitor size={20} strokeWidth={1.5} className="shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-15 font-medium text-ink">this computer</span>
          <span className="block text-13 leading-[1.4] text-ink-3">bots work while it's awake.</span>
        </span>
        <span className="num shrink-0 text-14 text-ink-2">free</span>
        <Dot on={home === "free"} />
      </label>
    </fieldset>
  );
}

/** the first minutes of an account, one step at a time: a name, where the bots live, the app. a plan picked on the
 * site arrives chosen; the step survives a refresh. there is no way past it but through: every dashboard page leads
 * back here until it is done. paying ends on the plans page, staying free ends on the dashboard */
export function Onboarding() {
  const { account, catalog, billing, clouds, checkout, updateProfile, finishOnboarding } = useCloud();
  const { account: me, setAccount, toast } = useSession();
  const { path, query } = useLocation();
  const intent = planIntent(query);
  // an open checkout already has a machine reserved: only a paid one counts
  const bought = billing?.subscription?.status === "active" || billing?.subscription?.status === "past_due" || Boolean(clouds?.some((cloud) => !cloud.awaitingPayment));
  const asked = query.get("step");
  const saved = sessionStorage.getItem(SAVED);
  const wanted: Step = asked === "done" ? "app" : isStep(asked) ? asked : isStep(saved) ? saved : "name";
  const step: Step = wanted === "plan" && bought ? "app" : wanted;
  const at = STEPS.indexOf(step);
  const guess = account?.profile.name || me?.name || me?.email.split("@")[0] || "";
  const [name, setName] = useState<string | null>(null);
  const [home, setHome] = useState<Home>("cloud");
  const [plan, setPlan] = useState<PaidPlan>(intent?.plan ?? "starter");
  const [interval, setInterval] = useState<BillingInterval>(intent?.interval ?? "month");
  const [busy, setBusy] = useState<"name" | "cloud" | "free" | "done" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const scene = useRef<SceneHandle>(null);
  const leaving = useRef(false);
  const shownName = name ?? guess;
  // signed up from the app (its sign-in brought them here): they have it, so there is no app step
  const [inApp] = useState(fromApp);
  const total = inApp ? STEPS.length - 1 : STEPS.length;
  const ended = useRef(false);

  const search = query.toString();
  const address = (to: Step) => {
    const params = new URLSearchParams(search);
    params.set("step", to);
    return `${path}?${params}`;
  };
  const here = address(step);
  useEffect(() => { sessionStorage.setItem(SAVED, step); }, [step]);
  useEffect(() => { trackOnboardingStep(step, inApp); }, [step, inApp]);
  useEffect(() => { setError(null); scene.current?.react("perk"); }, [step]);
  useEffect(() => { if (step === "plan") setInterval("month"); }, [step]);
  // each history entry names its step, so back and forward move between steps and a refresh stays put
  useEffect(() => { if (asked !== step && !leaving.current) navigate(here, { replace: true }); }, [asked, step, here]);

  const go = (to: Step) => navigate(address(to));
  /** done: the account is marked and the dashboard opens like any other visit; the app picks things up by itself */
  const finish = async (to: string, home: WebsiteHome) => {
    setBusy("done"); setError(null);
    try { await finishOnboarding(home); }
    catch { setError("that didn't save. try again."); setBusy(null); return; }
    sessionStorage.removeItem(SAVED);
    leaving.current = true;
    navigate(to, { replace: true });
  };
  // the app has no step of its own when the app sent them: a stale step there just finishes
  useEffect(() => {
    if (!inApp || step !== "app" || ended.current) return;
    ended.current = true;
    void finish(bought ? "/billing" : APP_DONE, bought ? "cloud" : "free");
  }, [inApp, step]);
  const choose = async (where: "cloud" | "free") => {
    // from the app: it carries on with this computer, so the browser's part ends here
    if (where === "free") { if (inApp) await finish(APP_DONE, "free"); else go("app"); return; }
    if (!catalog) return;
    track({ name: "plan_chosen", props: { plan, period: interval } });
    if (catalog.checkoutOpen === false) { setError(CHECKOUT_SOON); return; }
    setBusy("cloud"); setError(null);
    // checkout comes back to the plans page, so the first run is over once the payment page opens
    try { await finishOnboarding("cloud"); } catch { /* the plans page still works; the next visit asks again */ }
    sessionStorage.removeItem(SAVED);
    const ok = await checkout({ source: "dash_onboarding", kind: "plan", selection: planSelection(catalog, plan, { interval, work: false }), bundle: null });
    if (!ok) { setError("checkout didn't open. try again."); setBusy(null); return; }
    // the live page is on its way to the payment page; fixtures pay at once
    if (FIXTURE) { toast("paid. your madani cloud is being set up."); leaving.current = true; navigate("/billing", { replace: true }); }
  };
  const signOut = () => {
    sessionStorage.removeItem(SAVED);
    leaving.current = true;
    void api.signOut().finally(() => setAccount(null));
  };
  // a plan picked on the site goes from the name straight to checkout
  const direct = Boolean(intent) && !bought;
  const saveName = async () => {
    const next = shownName.trim();
    if (!next) { setError("a name, any name."); return; }
    setBusy("name"); setError(null);
    try { if (next !== (account?.profile.name ?? "")) await updateProfile(next); }
    catch (e) { setError((e as Error).message); setBusy(null); return; }
    if (direct && catalog) { await choose("cloud"); return; }
    setBusy(null);
    if (bought && inApp) { await finish("/billing", "cloud"); return; }
    go(bought ? "app" : "plan");
  };

  const chosen = catalog ? bundleOf(catalog, plan) : null;
  const price = chosen && catalog ? per(chosen.monthly, interval, catalog) : null;
  const mood: SceneMood = busy ? "thinking" : focused ? "typing" : "idle";
  const back = (to: Step) => <button type="button" onClick={() => go(to)} disabled={busy !== null} className="text-link -ms-2 inline-flex h-11 items-center gap-1.5 rounded-full px-2 text-14 disabled:opacity-50"><ArrowLeft size={15} strokeWidth={1.75} aria-hidden />back</button>;
  const big = "w-full !h-12 !text-15";

  return (
    <SplitFrame
      mood={mood}
      step={at}
      scene={scene}
      snug
      card={<p key={step} className="swap-in flex items-end gap-3.5"><span className="text-[56px] font-medium leading-[0.8] tracking-[-0.05em] text-ink">{at + 1}</span><span className="pb-0.5 text-20 font-medium tracking-[-0.03em] text-ink">{LABELS[at]}</span></p>}
      aside={<button type="button" onClick={signOut} disabled={busy !== null} className="text-link -me-2 h-11 rounded-full px-2 text-14 disabled:opacity-50">sign out</button>}
    >
      <Rail at={Math.min(at, total - 1)} total={total} />
      {step === "name" ? (
        <form key="name" className="step-in" onSubmit={(e) => { e.preventDefault(); void saveName(); }} noValidate>
          <h1 className="t-title">what's your name?</h1>
          <p className="mt-3 text-16 text-ink-2">{direct ? "then checkout, and your madani cloud starts setting up." : "two quick things and you're in."}</p>
          <input id="onb-name" aria-label="your name" placeholder="your name" autoComplete="given-name" maxLength={60} value={shownName} onChange={(e) => { setName(e.target.value); setError(null); }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} className="field mt-7 !h-12" aria-invalid={Boolean(error)} aria-describedby={error ? "onb-error" : undefined} />
          {direct && (
            <div className="mt-4 flex items-center gap-3 rounded-[16px] bg-card p-2 pe-4">
              <img src={meadow} alt="" width={800} height={354} className="h-12 w-16 shrink-0 rounded-[10px] object-cover object-bottom" draggable={false} />
              <span className="min-w-0 flex-1">
                <span className="block text-14 font-medium text-ink">madani cloud, {chosen?.name.toLowerCase() ?? "plus"}</span>
                <span className="num block text-13 text-ink-3">{price ? `${price.amount}${price.unit}, cancel any time` : <Skeleton className="h-4 w-28" />}</span>
              </span>
              <button type="button" onClick={() => go("plan")} className="text-link h-11 shrink-0 rounded-full px-1 text-14">change</button>
            </div>
          )}
          {error && <p id="onb-error" role="alert" className="mt-2.5 text-14 text-bad">{error}</p>}
          <Button type="submit" variant="primary" className={cx("mt-3", big)} disabled={busy !== null || (direct && !catalog)}>{busy ? <Busy>{direct ? "opening checkout" : "saving"}</Busy> : direct ? trialAction(catalog) ?? "continue to checkout" : "continue"}</Button>
        </form>
      ) : step === "plan" ? (
        <div key="plan" className="step-in">
          <h1 className="t-title">where should your bots live?</h1>
          <p className="mb-6 mt-3 text-16 text-ink-2">on madani cloud they keep working, even when your computer is off.</p>
          {catalog ? <PlanStep catalog={catalog} home={home} setHome={(h) => { setHome(h); setError(null); }} plan={plan} setPlan={(p) => { setPlan(p); setError(null); }} /> : <div className="flex flex-col gap-2" aria-busy="true"><Skeleton className="h-[300px] !rounded-[22px]" /><Skeleton className="h-[72px] !rounded-[18px]" /></div>}
          {error && <p role="alert" className="mt-3 text-14 text-bad">{error}</p>}
          <Button variant="primary" className={cx("mt-5", big)} onClick={() => void choose(home)} disabled={busy !== null || !catalog}>{busy === "cloud" ? <Busy>opening checkout</Busy> : busy === "done" ? <Busy>opening</Busy> : home === "free" ? "continue with free" : trialAction(catalog) ?? (price ? `continue to checkout, ${price.amount}${price.unit}` : "continue to checkout")}</Button>
          <div className="mt-2 flex items-center justify-between">{back("name")}{home === "cloud" && <span className="text-14 text-ink-3">cancel any time</span>}</div>
        </div>
      ) : inApp ? (
        <div key="app" className="min-h-[200px]" aria-busy="true" />
      ) : (
        <div key="app" className="step-in">
          {bought && <p className="tag mb-4 !bg-lime !text-ink" role="status"><span className="live-dot text-good" data-live />your madani cloud is being set up</p>}
          <h1 className="t-title">get the app.</h1>
          <p className="mt-3 text-16 text-ink-2">sign in with this account and make your first bot.</p>
          <div className="mt-6"><Downloads /></div>
          {error && <p role="alert" className="mt-3 text-14 text-bad">{error}</p>}
          <Button variant="primary" className={cx("mt-5", big)} onClick={() => void finish(bought ? "/billing" : "/", bought ? "cloud" : "free")} disabled={busy !== null}>{busy ? <Busy>opening</Busy> : "go to the dashboard"}</Button>
          {!bought && <div className="mt-1">{back("plan")}</div>}
        </div>
      )}
    </SplitFrame>
  );
}
