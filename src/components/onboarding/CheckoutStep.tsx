// madani cloud's purchase as one step of the first run: the account, the plan and the checkout happen in the browser (the
// account context redirect, src/lib/account-intent.ts), and this screen waits calmly beside it. It moves on by itself
// once the payment shows on the account; the page opens again in one press, and this Mac is always one press away.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudAccountState } from "../../../electron/cloud-account.mjs";
import { track } from "@/lib/analytics";
import { continueInBrowser, stopWaitingInBrowser } from "@/lib/account-intent";
import { offerTrialDays, usd } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { useCloudOffer } from "@/lib/use-cloud-offer";
import { PlaceArt } from "../ui/PlaceArt";
import { cloudBought } from "./funnel";
import { PRIMARY, StepFrame } from "./FunnelSteps";

/** the account is re-read this often while the checkout is open in the browser, beside main's own watch */
const LOOK_MS = 6_000;

type Phase = "idle" | "opening" | "waiting" | "failed";

/** What the waiting line says: the sign-in while one is under way in the browser, else the plan and checkout. */
export function checkoutLine(account: CloudAccountState | null, signingIn: boolean): "signIn" | "checkout" {
  if (account?.status === "connected") return "checkout";
  return signingIn || account?.status === "connecting" ? "signIn" : "checkout";
}

/** madani cloud's tile on the place step: the trial as its tag and the price after it, or nothing while unknown. */
export function useCloudTile(enabled: boolean): { tag: string | null; note: string | null } {
  const offer = useCloudOffer(enabled);
  if (!offer?.plans.length) return { tag: null, note: null };
  const price = usd(Math.min(...offer.plans.map((plan) => plan.amount)) / 100);
  const days = offerTrialDays(offer);
  return days
    ? { tag: t("funnel.place.cloudTrialTag", { days }), note: null }
    : { tag: t("funnel.place.cloudPriceTag", { price }), note: null };
}

export function CheckoutStep({ start, onPaid, onMac }: {
  /** open the browser on arrival (the person just picked madani cloud); a resumed run waits for a press instead */
  start: boolean;
  onPaid: () => void;
  onMac: () => void;
}) {
  const bridge = window.madaniDesktop?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [phase, setPhase] = useState<Phase>(start ? "opening" : "idle");
  const paid = useRef(false);
  const signingIn = useRef(false);
  const live = useRef(true);
  // set again on every mount: React's strict mode mounts twice in development
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const seen = useCallback((next: CloudAccountState | null) => {
    if (!live.current) return;
    setAccount(next);
    if (paid.current || !cloudBought(next)) return;
    paid.current = true;
    track("onboarding_checkout", { action: "paid" });
    void window.madaniDesktop?.focusWindow?.().catch(() => {});
    onPaid();
  }, [onPaid]);

  // the account as main says it, read again now and then and whenever the window comes back to the front
  useEffect(() => {
    if (!bridge) return;
    const stop = bridge.onState(seen);
    const look = () => void bridge.refresh().then(seen, () => {});
    void bridge.state().then(seen, () => {});
    const timer = setInterval(look, LOOK_MS);
    window.addEventListener("focus", look);
    return () => { stop(); clearInterval(timer); window.removeEventListener("focus", look); };
  }, [bridge, seen]);

  const open = useCallback(async (again: boolean) => {
    setPhase("opening");
    try {
      const outcome = await continueInBrowser({ kind: "upgrade", source: "app_onboarding", move: "computer" });
      signingIn.current = outcome === "browser";
      // this screen is the waiting state for the first run, so the app-wide "Continue in your browser" sheet stays closed
      stopWaitingInBrowser();
      track("onboarding_checkout", { action: again ? "again" : "open", outcome });
      if (!live.current) return;
      setPhase(outcome === "unavailable" || outcome === "failed" ? "failed" : "waiting");
    } catch {
      track("onboarding_checkout", { action: again ? "again" : "open", outcome: "failed" });
      if (live.current) setPhase("failed");
    }
  }, []);
  const started = useRef(false);
  useEffect(() => {
    if (!start || started.current) return;
    started.current = true;
    void open(false);
  }, [start, open]);

  const useMac = () => {
    track("onboarding_checkout", { action: "mac" });
    // a sign-in still waiting in the browser is let go, so this Mac's own account step starts clean
    if (account?.status !== "connected" && (signingIn.current || account?.status === "connecting")) void bridge?.cancel().catch(() => {});
    onMac();
  };

  const line = checkoutLine(account, signingIn.current);
  const email = account?.status === "connected" ? account.account?.email : undefined;
  return (
    <StepFrame
      art={<PlaceArt name="cloud" size={60} className="place-mark" />}
      title={t("funnel.checkout.title")}
      sub={line === "signIn" ? t("funnel.checkout.subSignIn") : t("funnel.checkout.sub")}
      footer={<>
        <button type="button" data-primary="" data-funnel-checkout-again="" disabled={phase === "opening"} onClick={() => void open(true)} className={PRIMARY}>
          {t("funnel.checkout.again")}
        </button>
        {/* the way out stays, quietly: a small, light text link, clearly second to the page in the browser */}
        <button type="button" data-funnel-checkout-mac="" onClick={useMac}
          className="mt-1 min-h-11 rounded-full px-3 text-[12px] leading-4 text-ink-tertiary underline-offset-4 transition-colors hover:text-ink-secondary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
          {t("funnel.checkout.mac")}
        </button>
      </>}
    >
      <div data-funnel-checkout={phase} className="flex w-full max-w-[360px] flex-col items-center gap-3">
        {phase === "failed"
          ? <p role="alert" className="text-[13px] leading-[18px] text-danger">{t("funnel.checkout.failed")}</p>
          : (
            <p role="status" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary">
              <span aria-hidden="true" className="funnel-wait inline-block size-1.5 shrink-0 rounded-full bg-ink" />
              {phase === "opening" ? t("funnel.checkout.opening") : line === "signIn" ? t("funnel.checkout.waitSignIn") : t("funnel.checkout.waitCheckout")}
            </p>
          )}
        {email && <p data-funnel-checkout-email="" className="text-[13px] leading-[18px] text-ink-tertiary">{t("funnel.account.signedIn", { email })}</p>}
      </div>
    </StepFrame>
  );
}
