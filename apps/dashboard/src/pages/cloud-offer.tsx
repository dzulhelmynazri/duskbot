import { useState } from "react";
import { Check, LoaderCircle } from "@/icons";
import cloudLemon from "../art/cloud-lemon.png";
import cloudPink from "../art/cloud-pink.png";
import computer from "../art/s-computer.webp";
import poster from "../art/wide-layers.webp";
import { useCloud } from "../data/cloud";
import type { CheckoutSource, PlanCatalog } from "../data/contracts";
import { bundleOf, dollars } from "../data/pricing";
import { useSession } from "../data/session";
import { Button, ButtonLink, cx } from "../ui/kit";
import { planSelection, type PaidPlan } from "./plan-sheet";

/** what madani cloud does for someone, said the same way everywhere it is offered */
export const CLOUD_POINTS = [
  "always available, even with your laptop shut",
  "routines run on time, day and night",
  "text your bots from your phone, any time",
  "ready in a minute, nothing to install",
] as const;

export function Points({ className }: { className?: string }) {
  return (
    <ul className={cx("flex flex-col gap-2", className)}>
      {CLOUD_POINTS.map((p) => (
        <li key={p} className="flex gap-2.5 text-14 leading-[1.45] text-ink-2">
          <Check size={17} strokeWidth={2} className="mt-0.5 shrink-0 text-good" aria-hidden />{p}
        </li>
      ))}
    </ul>
  );
}

export const CHECKOUT_SOON = "paid plans open soon. your account is ready, and we'll email you when checkout opens.";

/** the checkout button while a first plan starts free, else null */
export const trialAction = (catalog: Pick<PlanCatalog, "trialDays"> | null) => (catalog?.trialDays ? `start ${catalog.trialDays}-day free trial` : null);
export const checkoutDone = (catalog: Pick<PlanCatalog, "trialDays"> | null) => (catalog?.trialDays ? "your free trial started. your madani cloud is being set up." : "paid. your madani cloud is being set up.");

/** checkout for a plan in one click: monthly, the first region, personal use; the plans page has every option */
export function useQuickCheckout(source: CheckoutSource) {
  const { catalog, checkout } = useCloud();
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buy = async (plan: PaidPlan = "starter") => {
    if (!catalog) return;
    if (catalog.checkoutOpen === false) { setError(CHECKOUT_SOON); return; }
    setBusy(true); setError(null);
    const ok = await checkout({ source, kind: "plan", selection: planSelection(catalog, plan, { interval: "month", work: false }), bundle: null });
    if (ok) toast(checkoutDone(catalog));
    else setError("checkout didn't open. try again.");
    setBusy(false);
  };
  return { busy, error, buy };
}

export const monthlyOf = (catalog: PlanCatalog | null, plan: PaidPlan) => {
  const b = catalog ? bundleOf(catalog, plan) : null;
  return b ? dollars(b.monthly) : null;
};

/** the one cloud offer on home for anyone without it: the sky poster, a white panel with the case and one button */
export function CloudHero({ source = "dash_home" }: { source?: CheckoutSource }) {
  const { catalog } = useCloud();
  const { busy, error, buy } = useQuickCheckout(source);
  return (
    <section className="enter relative isolate overflow-hidden rounded-card bg-[#3fbdfb]" aria-labelledby="cloud-hero-title">
      <img src={poster} alt="" className="absolute inset-0 -z-10 size-full object-cover object-[center_80%]" draggable={false} />
      <img src={cloudPink} alt="" width={240} height={80} className="pixel-art cloud-drift absolute right-[34%] top-6 -z-10 w-[96px] max-md:hidden" style={{ ["--drift" as string]: "80px", ["--dur" as string]: "46s" }} draggable={false} />
      <img src={cloudLemon} alt="" width={240} height={80} className="pixel-art cloud-drift absolute right-[6%] top-12 -z-10 w-[72px]" style={{ ["--drift" as string]: "-60px", ["--dur" as string]: "58s" }} draggable={false} />
      <div className="grid items-end gap-6 p-3 md:grid-cols-[minmax(0,440px)_minmax(0,1fr)] md:p-4">
        <div className="pop rounded-[20px] bg-pop p-6 text-ink max-md:order-last max-sm:p-5">
          <h2 id="cloud-hero-title" className="text-28 font-medium tracking-[-0.04em] text-balance">give your bots a computer that never sleeps.</h2>
          <Points className="mt-5" />
          {error && <p role="alert" className="mt-4 text-14 text-bad">{error}</p>}
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void buy("starter")} disabled={busy || !catalog}>
              {busy ? <><LoaderCircle size={17} strokeWidth={2} className="spin" aria-hidden />opening checkout</> : trialAction(catalog) ?? "get madani cloud"}
            </Button>
            <ButtonLink to="/billing">compare plans</ButtonLink>
          </div>
        </div>
        <div className="relative flex min-h-[220px] origin-bottom items-end justify-center gap-3 pb-3 max-md:-mb-8 max-md:min-h-[150px] max-md:scale-[0.7]" aria-hidden>
          <img src={computer} alt="" width={520} height={599} className="w-[150px] drop-shadow-[0_10px_0_rgb(19_19_22/0.08)]" draggable={false} />
        </div>
      </div>
    </section>
  );
}
