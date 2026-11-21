import { X } from "@/icons";
import { useWakes, wakeActions, type Wake } from "../data/cloud-wake";
import { Modal } from "./controls";
import { Button } from "./kit";
import { Mascot, useReducedMotion } from "./Mascot";
import { AnimatePresence, EASE_OUT, m, SPRING } from "./motion";

/** a typical wake is about half a minute: the bar eases toward most of the way and never claims done before it answers */
const EXPECTED_S = 45;
const reached = (elapsedMs: number) => 0.9 * (1 - Math.exp(-elapsedMs / 18_000));

function WakeBar({ wake }: { wake: Wake }) {
  const elapsed = Date.now() - wake.startedAt;
  return (
    <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-track" aria-hidden>
      <m.div className="h-full w-full rounded-full bg-ink" style={{ originX: 0 }} initial={{ scaleX: Math.max(0.04, reached(elapsed)) }}
        animate={{ scaleX: 0.9 }} transition={{ duration: Math.max(1, EXPECTED_S - elapsed / 1000), ease: [0.15, 0.55, 0.3, 1] }} />
    </div>
  );
}

function WakeCard({ wake }: { wake: Wake }) {
  const reduced = useReducedMotion();
  const ready = wake.phase === "ready";
  return (
    <m.div className="pop pointer-events-auto w-[min(300px,calc(100vw-24px))] rounded-[22px] bg-pop px-3.5 py-3" style={{ boxShadow: "var(--pop-shadow)", originX: 1, originY: 0 }}
      initial={{ opacity: 0, y: -8, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.16, ease: EASE_OUT } }} transition={SPRING}>
      <div className="flex items-center gap-2.5">
        <span className="shrink-0" aria-hidden><Mascot body="kit" color="blue" size={28} state={ready ? "happy" : "waking"} still={reduced} /></span>
        <div className="min-w-0 flex-1" role="status">
          <div className="truncate text-14 font-medium text-ink">{ready ? `${wake.name} is online` : `waking ${wake.name}`}</div>
          {!ready && <div className="truncate text-13 text-ink-3">about half a minute</div>}
        </div>
        <button type="button" onClick={() => wakeActions.hide(wake.cloudId)} aria-label={ready ? "close" : "hide"} className="press hover-ghost -me-1.5 grid size-9 shrink-0 place-items-center rounded-full text-ink-3"><X size={16} strokeWidth={1.5} /></button>
      </div>
      {!reduced && !ready && <WakeBar wake={wake} />}
      {ready && wake.pending.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {wake.pending.map((p) => <Button key={p.key} size="sm" variant="primary" className="w-full" onClick={() => wakeActions.run(wake.cloudId, p.key)}>{p.label}</Button>)}
        </div>
      )}
    </m.div>
  );
}

/** a madani cloud waking for something the person asked: a short note first, then a pill in the corner on every page,
 *  which offers the waiting action once the cloud answers */
export function WakePill() {
  const { wakes, asking } = useWakes();
  const shown = Object.values(wakes).filter((w) => !w.hidden);
  const ask = asking ? wakes[asking.cloudId] : undefined;
  return (
    <>
      <div className="pointer-events-none fixed right-4 top-4 z-30 flex flex-col items-end gap-2 max-lg:right-3 max-lg:top-[calc(60px+env(safe-area-inset-top))]">
        <AnimatePresence initial={false}>{shown.map((w) => <WakeCard key={w.cloudId} wake={w} />)}</AnimatePresence>
      </div>
      <Modal open={Boolean(ask && asking)} onClose={wakeActions.closeAsk} title={ask ? `${ask.name} is waking up` : ""}
        footer={<><Button onClick={() => asking && wakeActions.cancel(asking.key)}>cancel</Button><Button variant="primary" onClick={wakeActions.closeAsk}>keep browsing</Button></>}>
        it takes about half a minute; you can keep browsing.
      </Modal>
    </>
  );
}
