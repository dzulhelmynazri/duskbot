import type { ReactNode } from "react";
import { Check, Minus } from "@/icons";
import type { PlanCatalog } from "../data/contracts";
import { freeTradeoffs, type FunnelPlan } from "../data/funnel";
import { bundleOf, dollars } from "../data/pricing";
import { Modal } from "../ui/controls";
import { Button } from "../ui/kit";

/** the honest comparison shown when someone picks Free: what changes, with Free one click away */
export function FreeSheet({ open, catalog, plan, onClose, onFree, primary, freeLabel = "continue with free", error }: { open: boolean; catalog: PlanCatalog; plan: FunnelPlan; onClose(): void; onFree(): void; primary: ReactNode; freeLabel?: string; error?: string | null }) {
  const b = bundleOf(catalog, plan);
  if (!b) return null;
  return (
    <Modal open={open} onClose={onClose} wide title="what free leaves out" footer={<><Button onClick={onFree}>{freeLabel}</Button>{primary}</>}>
      <p>free keeps every bot, chat and connector for personal use. here is what changes without madani cloud.</p>
      <div className="mt-5 grid grid-cols-2 gap-x-5 pb-2.5 text-13" aria-hidden>
        <span className="text-ink-3">free <span className="num">$0</span></span>
        <span className="font-medium text-ink">{b.name} <span className="num">{dollars(b.monthly)}/mo</span></span>
      </div>
      <ul className="">
        {freeTradeoffs(catalog, plan).map((r) => (
          <li key={r.topic} className="py-3">
            <p className="text-12 text-ink-3">{r.topic}</p>
            <div className="mt-1 grid grid-cols-2 gap-x-5 text-13 leading-[1.45]">
              <p className="flex gap-2 text-ink-3"><Minus size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-ink-4" aria-hidden /><span><span className="sr-only">on free: </span>{r.free}</span></p>
              <p className="flex gap-2 text-ink"><Check size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-good" aria-hidden /><span><span className="sr-only">on {b.name}: </span>{r.paid}</span></p>
            </div>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-3 text-13 text-bad">{error}</p>}
    </Modal>
  );
}
