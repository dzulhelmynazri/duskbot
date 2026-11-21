import { useEffect, useState } from "react";
import { storeApp } from "@/lib/store-app";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { t } from "@/lib/i18n";
import { PixelArt } from "../Illustration";
import { usePlatform, type MobilePlatform } from "../platform";
import { spring } from "../motion";
import { BackButton } from "../onboarding/parts";
import { closesOnBack } from "../Sheet";
import { useMobileAccount } from "./AccountGate";
import { MobileSignIn } from "./MobileSignIn";
import { useConnections } from "../connection/connections";
import { placeKind } from "../connection/connection-notice";

export const SIGN_IN_OFFER_KEY = "madani.mobile.signInOffer";
const SHOW_AFTER_MS = 2500;

export async function signInOfferDismissed(platform: Pick<MobilePlatform, "prefs">): Promise<boolean> {
  return (await platform.prefs.get(SIGN_IN_OFFER_KEY).catch(() => null)) === "dismissed";
}

export function dismissSignInOffer(platform: Pick<MobilePlatform, "prefs">): Promise<void> {
  return platform.prefs.set(SIGN_IN_OFFER_KEY, "dismissed");
}

/** A phone linked with a QR code or a code, with no madani account: once, a small card offers the sign-in that keeps this
 * link and finds the account's cloud. It never blocks anything, and "not now" is for good. */
export function SignInOffer({ paused = false }: { paused?: boolean }) {
  const platform = usePlatform();
  const account = useMobileAccount();
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  // the store apps never ask for an account a paired computer does not need (App Store guideline 5.1.1(v))
  const { connections, loaded } = useConnections();
  // a madani cloud is already the account's: a phone linked to one is never asked to log in
  const wanted = Boolean(account?.offered && !account.account) && !storeApp() && loaded && !connections.some((place) => placeKind(place) === "cloud");

  useEffect(() => {
    if (!wanted || paused) return;
    let alive = true;
    const timer = setTimeout(() => {
      void signInOfferDismissed(platform).then((dismissed) => { if (alive && !dismissed) setVisible(true); });
    }, SHOW_AFTER_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [wanted, paused, platform]);

  useEffect(() => signingIn ? closesOnBack(() => setSigningIn(false)) : undefined, [signingIn]);

  const dismiss = () => { setVisible(false); setSigningIn(false); void dismissSignInOffer(platform); };
  if (!wanted && !signingIn) return null;

  return (
    <>
      <div className="madani-mobile pointer-events-none fixed inset-0 z-40">
      <AnimatePresence>
        {visible && !signingIn && (
          <motion.aside key="offer" aria-label={t("mobile.entry.offerTitle")} data-sign-in-offer
            className="mobile-float pointer-events-auto absolute inset-x-3 bottom-[calc(var(--m-safe-bottom)+12px)] flex items-center gap-3 rounded-[22px] bg-composer p-3.5 text-ink"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
            transition={{ ...spring.settle, opacity: { duration: 0.2 } }}>
            <PixelArt name="key" size={44} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[16px] font-semibold leading-5">{t("mobile.entry.offerTitle")}</p>
              <p className="mt-0.5 text-[14px] leading-5 text-ink-secondary">{t(storeApp() ? "mobile.entry.offerBodyStore" : "mobile.entry.offerBody")}</p>
              <div className="mt-2 flex gap-1">
                <button type="button" onClick={() => setSigningIn(true)} className="mobile-press flex min-h-11 items-center rounded-full bg-ink px-4 text-[15px] font-semibold text-app">{t("mobile.entry.signIn")}</button>
                <button type="button" onClick={dismiss} className="mobile-press flex min-h-11 items-center rounded-full px-4 text-[15px] font-semibold text-ink-secondary">{t("mobile.entry.notNow")}</button>
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
      </div>
      {signingIn && (
        <div role="dialog" aria-modal aria-label={t("mobile.entry.signInTitle")} className="madani-mobile fixed inset-0 z-50 flex flex-col overflow-y-auto bg-app text-ink">
          <div className="flex h-[calc(var(--m-safe-top)+60px)] shrink-0 items-end px-4 pb-2"><BackButton close onClick={() => setSigningIn(false)} /></div>
          <div className="flex flex-1 flex-col items-center px-7 pb-[calc(var(--m-safe-bottom)+16px)] pt-4 text-center">
            <MobileSignIn onSignedIn={dismiss} />
          </div>
        </div>
      )}
    </>
  );
}
