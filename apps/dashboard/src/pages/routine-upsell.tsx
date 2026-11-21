import { useEffect, useState } from "react";
import { cloudForWorkspace, useCloud } from "../data/cloud";
import { routineUpsell } from "../data/routine-upsell";
import { useSession } from "../data/session";
import { api } from "../lib/api";
import { trackUpsell, watchUpsell } from "../lib/analytics";
import { Modal } from "../ui/controls";
import { Button } from "../ui/kit";
import { Mascot } from "../ui/Mascot";
import { AnimatePresence } from "../ui/motion";
import { PlanSheet } from "./plan-sheet";

const SEEN = "madani-dash-routines-seen";
const SHOWN = "madani-dash-routine-upsell-at";

export function RoutineUpsell() {
  const { account, workspaces } = useSession();
  const { billing, clouds } = useCloud();
  const [routine, setRoutine] = useState<ReturnType<typeof routineUpsell>["next"]>(null);
  const [plan, setPlan] = useState(false);
  const free = billing !== null && clouds !== null && clouds.length === 0 && (!billing.subscription || billing.subscription.selection.desktop === "none");

  const local = (workspaces ?? []).filter((w) => ["mac", "linux", "windows"].includes(w.kind) && clouds !== null && !cloudForWorkspace(clouds, w.id)).map((w) => w.id).join(",");
  const ready = !!account && workspaces !== null && clouds !== null && billing !== null;

  useEffect(() => {
    if (!ready || !local) return;
    const ctl = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || document.visibilityState !== "visible") return;
      loading = true;
      try {
        const details = await Promise.all(local.split(",").map((id) => api.workspace(id, ctl.signal)));
        if (ctl.signal.aborted) return;
        const stored: unknown = JSON.parse(localStorage.getItem(SEEN) ?? "null");
        const seen = Array.isArray(stored) && stored.every((id) => typeof id === "string") ? stored as string[] : null;
        const now = Date.now();
        const result = routineUpsell(details, seen, Number(localStorage.getItem(SHOWN) ?? 0), now);
        localStorage.setItem(SEEN, JSON.stringify(result.seen));
        if (free && result.next) {
          localStorage.setItem(SHOWN, String(now));
          setRoutine(result.next);
          trackUpsell("shown", "dash_routines");
        }
      } catch {} finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    document.addEventListener("visibilitychange", load);
    return () => { ctl.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [ready, local, free]);

  const open = Boolean(routine && free);
  useEffect(() => { if (open) return watchUpsell("dash_routines"); }, [open]);
  const close = () => setRoutine(null);
  const notNow = () => { trackUpsell("dismiss", "dash_routines"); close(); };
  return (
    <>
      <AnimatePresence>{routine && free && <Modal key="routine" open onClose={notNow} wide title={`routines stop when your ${routine.workspace.kind === "mac" ? "Mac" : "computer"} sleeps`} footer={<><Button onClick={notNow}>not now</Button><Button variant="primary" onClick={() => { trackUpsell("click", "dash_routines"); close(); setPlan(true); }}>see madani cloud</Button></>}>
        <p>"{routine.routine.name}" runs on {routine.workspace.name}. madani cloud keeps it running, even when your computer is off.</p>
        <dl className="mt-5 text-13">
          <div className="flex items-center gap-3 py-3"><Mascot color="silver" size={24} state="sleeping" /><dt className="min-w-0 flex-1 truncate text-ink-2">{routine.workspace.name}</dt><dd className="shrink-0">stops while asleep</dd></div>
          <div className="flex items-center gap-3 py-3"><span className="size-6 shrink-0" aria-hidden /><dt className="min-w-0 flex-1 truncate text-ink-2">madani cloud</dt><dd className="shrink-0">always available</dd></div>
        </dl>
      </Modal>}</AnimatePresence>
      <AnimatePresence>{plan && <PlanSheet key="plan" start="starter" source="dash_routines" onClose={() => setPlan(false)} />}</AnimatePresence>
    </>
  );
}
