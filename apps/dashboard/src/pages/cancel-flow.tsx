import { useState, type ReactNode } from "react";
import { ArrowUpRight, Minus } from "@/icons";
import { useCloud } from "../data/cloud";
import type { PlanCatalog, Selection } from "../data/contracts";
import { bundleOf, priceCart } from "../data/pricing";
import { useAccountUsage } from "../data/usage";
import { useSession } from "../data/session";
import type { CancelAnswer, RetentionInput } from "../data/wire";
import { longDate } from "../lib/format";
import { Link } from "../lib/router";
import { Choice, Modal } from "../ui/controls";
import { Button } from "../ui/kit";
import { cartText, planSelection } from "./plan-sheet";

export const CONTACT = "mailto:hello@madani.bot";

/** the reasons in the order they are offered */
export const REASONS: Array<{ id: CancelAnswer; label: string }> = [
  { id: "price", label: "it's too expensive" },
  { id: "unused", label: "i'm not using it" },
  { id: "broken", label: "something broke" },
  { id: "feature", label: "it's missing a feature i need" },
  { id: "switching", label: "i'm switching to something else" },
  { id: "other", label: "something else" },
];
/** reasons with their own help before the cancel */
const HELPED: ReadonlySet<CancelAnswer> = new Set(["price", "unused", "broken", "feature"]);

export type FlowStep = "reason" | "help" | "confirm";
/** every reason, or none, sees a way to keep the plan before the cancel when there is one: its own help, a discount or a smaller plan */
export const nextStep = (step: FlowStep, reason: CancelAnswer | null, canSave = false): FlowStep =>
  step === "reason" && ((reason && HELPED.has(reason)) || canSave) ? "help" : "confirm";

/** what ends with the plan, as plain lines, in the person's own numbers when known; `keepsLicense` is a work license that outlives the madani cloud */
export function losses(opts: { desk: boolean; work: boolean; keepsLicense: boolean; bots?: number; routines?: number }): string[] {
  const bots = opts.bots && opts.bots > 1 ? `your ${opts.bots} bots stop` : opts.bots === 1 ? "your bot stops" : "your bots stop";
  const routines = opts.routines && opts.routines > 1 ? `your ${opts.routines} routines only run` : opts.routines === 1 ? "your routine only runs" : "routines only run";
  return [
    ...(opts.desk ? [`${bots} working when your mac sleeps`, `${routines} while your mac is awake`, "your madani cloud files are kept for 30 days, then deleted"] : []),
    ...(opts.work && !opts.keepsLicense ? ["work use is no longer covered. personal use stays free."] : []),
  ];
}

/** the plan's losses in this person's own numbers; read only once the flow is open */
function useLosses(opts: { desk: boolean; work: boolean; keepsLicense: boolean }) {
  const { bots } = useAccountUsage();
  return losses({ ...opts, bots: bots.length, routines: bots.reduce((sum, row) => sum + (row.bot.routines?.length ?? 0), 0) });
}

function LeadLine({ desk, work, keepsLicense }: { desk: boolean; work: boolean; keepsLicense: boolean }) {
  const lost = useLosses({ desk, work, keepsLicense });
  return <p>{desk ? `once it ends, ${lost[0]}. ` : ""}if it's the cost, there's a lighter way to keep it.</p>;
}

function Confirm({ desk, work, keepsLicense, trial, until }: { desk: boolean; work: boolean; keepsLicense: boolean; trial: boolean; until: string }) {
  const lost = useLosses({ desk, work, keepsLicense });
  return (
    <>
      <p>{keepsLicense ? `your madani cloud keeps working until ${until} and isn't charged again. your work license stays and keeps renewing.` : `everything keeps working until ${until}, and you won't be charged${trial ? "" : " again"}.`}{lost.length ? " after that:" : ""}</p>
      {lost.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {lost.map((l) => <li key={l} className="flex gap-2.5 text-14 text-ink-2"><Minus size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-4" aria-hidden />{l}</li>)}
        </ul>
      )}
      <p className="mt-3">you can come back any time.</p>
    </>
  );
}

function HelpLink({ to, external, onClick, children }: { to: string; external?: boolean; onClick(): void; children: ReactNode }) {
  const cls = "hover-row flex min-h-12 items-center justify-between gap-3 rounded-[14px] bg-card px-3.5 text-14 text-ink";
  return external
    ? <a href={to} className={cls} onClick={onClick}>{children}<ArrowUpRight size={15} strokeWidth={1.5} className="shrink-0 text-ink-3" aria-hidden /></a>
    : <Link to={to} className={cls} onClick={onClick}>{children}<ArrowUpRight size={15} strokeWidth={1.5} className="shrink-0 text-ink-3" aria-hidden /></Link>;
}

function Unused({ onHelped }: { onHelped(): void }) {
  const { month, bots, loading } = useAccountUsage();
  const turns = month?.totals.turns ?? 0;
  return (
    <>
      <p>{loading ? "checking what your bots did..." : turns > 0 ? `this month your ${bots.length === 1 ? "bot" : `${bots.length} bots`} took ${turns.toLocaleString("en-US")} turns.` : "your bots haven't done much this month."} a few ways people get more out of it:</p>
      <div className="mt-4 flex flex-col gap-1.5">
        <HelpLink to="/bots" onClick={onHelped}>give a bot a routine, like a morning brief</HelpLink>
        <HelpLink to="/connectors" onClick={onHelped}>connect your email, calendar or slack</HelpLink>
        <HelpLink to="/usage" onClick={onHelped}>see what each bot did this month</HelpLink>
      </div>
    </>
  );
}

/** the ways to keep the plan for less: the one-time discount, and plus for someone on pro */
function Saves({ offer, plus, smaller, work, busy, onDiscount, onDowngrade, catalog, interval }: { offer: { percent: number; cycles: number } | null; plus: { name: string } | null; smaller: Selection | null; work: boolean; busy: string | null; onDiscount(): void; onDowngrade(): void; catalog: PlanCatalog; interval: Selection["interval"] }) {
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      {offer && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-card px-4 py-3">
          <div className="min-w-0 flex-1 basis-[200px]">
            <p className="text-14 text-ink">{offer.percent}% off your next {offer.cycles} months</p>
            <p className="text-13 text-ink-3">your plan stays as it is. one time only.</p>
          </div>
          <Button variant="primary" size="sm" onClick={onDiscount} disabled={busy !== null}>{busy === "discount" ? "applying" : `take ${offer.percent}% off`}</Button>
        </div>
      )}
      {plus && smaller && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-card px-4 py-3">
          <div className="min-w-0 flex-1 basis-[200px]">
            <p className="text-14 text-ink">switch to {plus.name}</p>
            <p className="num text-13 text-ink-3">{cartText(priceCart(smaller, catalog), interval)}, a smaller madani cloud{work ? ", work license included" : ""}</p>
          </div>
          <Button variant={offer ? "outline" : "primary"} size="sm" onClick={onDowngrade} disabled={busy !== null}>{busy === "downgrade" ? "switching" : `switch to ${plus.name}`}</Button>
        </div>
      )}
    </div>
  );
}

/** account, billing, manage subscription: why, a tailored offer or fix, then what ends and the cancel itself.
 * consumer rules (US, EU, India) need an online cancel: the reason is optional and the cancel is at most three screens in. */
export function CancelFlow({ open, onClose, catalog }: { open: boolean; onClose(): void; catalog: PlanCatalog }) {
  const { billing, cancel, changePlan, updateCard, retentionStep, takeDiscount } = useCloud();
  const { toast } = useSession();
  const [step, setStep] = useState<FlowStep>("reason");
  const [reason, setReason] = useState<CancelAnswer | null>(null);
  const [busy, setBusy] = useState<"discount" | "downgrade" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sub = billing?.subscription;
  if (!sub) return null;
  const sel = sub.selection;
  const desk = sel.desktop !== "none";
  const work = sel.license !== "personal";
  // a plan change on a trial ends the trial and bills at once, so a trial cancel always ends the whole plan
  const trial = sub.trialEndsAt !== undefined && sub.trialEndsAt > Date.now();
  const keepsLicense = work && desk && !trial;
  const offer = billing?.retention?.offer ?? null;
  const onPro = sel.desktop === bundleOf(catalog, "pro")?.desktop;
  const plus = bundleOf(catalog, "starter");
  const smaller: Selection = planSelection(catalog, "starter", { interval: sel.interval, region: sel.region, work: false, keep: sel });
  const until = longDate(sub.currentPeriodEnd);
  const cheaper = onPro && plus && !trial ? plus : null;
  const canSave = Boolean(offer || cheaper);

  const log = (s: RetentionInput["step"], outcome: RetentionInput["outcome"]) => { if (reason) retentionStep({ reason, step: s, outcome }); };
  const close = onClose;
  const keep = () => { log(step, "kept"); close(); };
  const next = () => {
    if (step === "reason" && reason) log("reason", "shown");
    setError(null);
    setStep(nextStep(step, reason, canSave));
  };
  const run = async (kind: "discount" | "downgrade" | "cancel", action: () => Promise<void>) => {
    setBusy(kind); setError(null);
    try { await action(); close(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const discount = () => run("discount", async () => { await takeDiscount(reason ?? "price"); toast(`${offer!.percent}% off your next ${offer!.cycles} months`); });
  const downgrade = () => run("downgrade", async () => {
    await changePlan(smaller, 0);
    log("help", "downgrade");
    toast(`you switch to ${plus?.name ?? "plus"} on ${until}. until then nothing changes.`);
  });
  const stop = () => run("cancel", async () => {
    if (keepsLicense) { await changePlan({ ...sel, desktop: "none", size: null }); log("confirm", "cancelled"); }
    else await cancel(reason ?? "");
    toast(keepsLicense ? `cancelled. your madani cloud works until ${until}.` : `cancelled. everything keeps working until ${until}.`);
  });

  const title = step === "reason" ? "what's going on?" : step === "help" ? (reason === "broken" ? "let's fix it first" : reason === "price" ? "a lighter way to keep it" : reason === "unused" ? "here's what it can do" : reason === "feature" ? "tell us what's missing" : "before you go") : keepsLicense ? "cancel your madani cloud?" : "cancel your plan?";
  const saves = <Saves offer={offer} plus={cheaper} smaller={cheaper ? smaller : null} work={work} busy={busy} onDiscount={() => void discount()} onDowngrade={() => void downgrade()} catalog={catalog} interval={sel.interval} />;
  // past the reason, keeping the plan is the button that stands out; cancelling stays one clear click away
  const footer = step === "confirm"
    ? <><Button variant="primary" onClick={keep}>keep my plan</Button><Button variant="danger" onClick={() => void stop()} disabled={busy !== null}>{busy === "cancel" ? "cancelling" : keepsLicense ? "cancel madani cloud" : "cancel my plan"}</Button></>
    : step === "help"
      ? <><Button variant="primary" onClick={keep}>keep my plan</Button><Button onClick={next} disabled={busy !== null}>continue to cancel</Button></>
      : <><Button onClick={keep}>keep my plan</Button><Button variant="primary" onClick={next} disabled={busy !== null}>continue</Button></>;

  return (
    <Modal open={open} onClose={close} title={title} footer={footer} wide>
      {step === "reason" && (
        <>
          <p>pick the closest one, or skip it. it helps us fix the right thing.</p>
          <fieldset className="mt-4 min-w-0">
            <legend className="sr-only">reason</legend>
            <div className="flex flex-col gap-1">
              {REASONS.map((r) => <Choice key={r.id} name="cancel-reason" value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)} title={r.label} />)}
            </div>
          </fieldset>
          <button type="button" className="text-link mt-3 h-9 text-13" onClick={() => void updateCard()}>update your card instead</button>
        </>
      )}

      {step === "help" && reason === "price" && (
        <>
          <p>before you go, here's what we can do.</p>
          {canSave ? saves : <p className="mt-4 rounded-[16px] bg-card px-4 py-3 text-14">you're on our smallest plan. free keeps your bots running on your mac at no cost.</p>}
        </>
      )}
      {step === "help" && (reason === null || reason === "switching" || reason === "other") && (
        <>
          <LeadLine desk={desk} work={work} keepsLicense={keepsLicense} />
          {saves}
        </>
      )}
      {step === "help" && reason === "unused" && <><Unused onHelped={() => log("help", "helped")} />{canSave && <><p className="mt-5">or keep it for less:</p>{saves}</>}</>}
      {step === "help" && reason === "broken" && (
        <>
          <p>most problems clear up with a restart, and we answer every message.</p>
          <div className="mt-4 flex flex-col gap-1.5">
            {desk && <HelpLink to="/cloud" onClick={() => log("help", "helped")}>restart your madani cloud</HelpLink>}
            <HelpLink to="/workspaces" onClick={() => log("help", "helped")}>check that your computers are connected</HelpLink>
            <HelpLink to={`${CONTACT}?subject=${encodeURIComponent("something broke")}`} external onClick={() => log("help", "helped")}>write to us at hello@madani.bot</HelpLink>
          </div>
        </>
      )}
      {step === "help" && reason === "feature" && (
        <>
          <p>tell us what you need. we read every note, and it shapes what we build next.</p>
          <div className="mt-4 flex flex-col gap-1.5">
            <HelpLink to={`${CONTACT}?subject=${encodeURIComponent("a feature i need")}`} external onClick={() => log("help", "helped")}>write to us at hello@madani.bot</HelpLink>
          </div>
        </>
      )}

      {step === "confirm" && <Confirm desk={desk} work={work} keepsLicense={keepsLicense} trial={trial} until={until} />}
      {error && <p role="alert" className="mt-3 text-13 text-bad">{error}</p>}
    </Modal>
  );
}
