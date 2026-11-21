import { useEffect, useState } from "react";
import { ChevronRight, RotateCw } from "../../icons";
import { WorkingDots } from "@/components/WorkingIndicator";
import { t } from "@/lib/i18n";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import { HEADLINE, LINE, PRIMARY, Screen } from "../onboarding/parts";
import { LoadingMascot, PixelArt } from "../Illustration";
import { usePlatform } from "../platform";

/** seconds before each automatic retry; the last one repeats */
export const RETRY_SECONDS = [5, 10, 20, 40, 60];

/** A saved computer that did not answer at launch: the link is kept, so this is never the pairing screen. It retries
 * on its own, on demand, when the phone comes back online or to the front, and lets the person open another saved one.
 * `gone`: a madani cloud that was deleted, which never answers again: no retries, only Remove and the other places. */
export function Unreachable({ record, others, attempts, trying, gone = false, onRetry, onSwitch, onRemove }: {
  record: MobileConnectionRecord;
  others: MobileConnectionRecord[];
  attempts: number;
  trying: boolean;
  gone?: boolean;
  onRetry(): void;
  onSwitch(id: string): void;
  onRemove?(): void;
}) {
  const wait = RETRY_SECONDS[Math.min(Math.max(attempts - 1, 0), RETRY_SECONDS.length - 1)]!;
  const [left, setLeft] = useState(wait);
  useEffect(() => {
    if (trying || gone) return;
    setLeft(wait);
    const started = Date.now();
    const tick = setInterval(() => {
      const remaining = wait - Math.floor((Date.now() - started) / 1000);
      if (remaining <= 0) { clearInterval(tick); onRetry(); } else setLeft(remaining);
    }, 1000);
    return () => clearInterval(tick);
  }, [trying, gone, wait, onRetry]);
  const platform = usePlatform();
  useEffect(() => {
    if (trying || gone) return;
    window.addEventListener("online", onRetry);
    const stopResume = platform.onResume?.(onRetry);
    const stopNetwork = platform.onNetworkChange?.(onRetry);
    return () => { window.removeEventListener("online", onRetry); stopResume?.(); stopNetwork?.(); };
  }, [trying, gone, onRetry, platform]);

  return (
    <main className="madani-mobile relative flex size-full flex-col overflow-hidden bg-app text-ink" aria-busy={trying}>
      <Screen art={<PixelArt name={gone ? "cloud" : "computer"} size={84} />} actions={gone
        ? <button type="button" data-testid="mobile-gone-remove" className={PRIMARY} onClick={onRemove}>{t("mobile.gone.remove")}</button>
        : <button type="button" disabled={trying} className={PRIMARY} onClick={onRetry}>{trying ? <WorkingDots /> : <><RotateCw size={18} />{t("mobile.onboarding.retry")}</>}</button>
      }>
        <h1 className={HEADLINE}>{t(gone ? "mobile.gone.title" : "mobile.unreachable.title", { name: record.label })}</h1>
        <p className={LINE}>{t(gone ? "mobile.gone.body" : "mobile.unreachable.body")}</p>
        {!gone && <p role="status" className="mt-4 flex min-h-6 items-center justify-center gap-2 text-[15px] font-medium text-ink-secondary">
          {trying ? <><LoadingMascot size={22} />{t("mobile.unreachable.trying")}</> : t("mobile.unreachable.next", { seconds: left })}
        </p>}
        {others.length > 0 && (
          <div className="mt-8 w-full max-w-[320px] text-left">
            <p className="px-1 pb-2 text-[15px] font-semibold text-ink-secondary">{t("mobile.unreachable.others")}</p>
            <div className="overflow-hidden rounded-[18px] bg-ink/[0.05]">
              {others.map((other) => (
                <button key={other.id} type="button" disabled={trying} onClick={() => onSwitch(other.id)} className="mobile-row flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left text-[17px] font-semibold text-ink disabled:opacity-60">
                  <span className="min-w-0 flex-1 truncate">{other.label}</span>
                  <ChevronRight aria-hidden size={18} className="shrink-0 text-ink-tertiary" />
                </button>
              ))}
            </div>
          </div>
        )}
      </Screen>
    </main>
  );
}
