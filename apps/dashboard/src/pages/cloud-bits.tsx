import { useState, type CSSProperties, type ReactNode } from "react";
import { Cloud, LoaderCircle, Monitor, Power, Server } from "@/icons";
import type { WorkspaceSummary } from "../../../../shared/dashboard-protocol";
import { useCloud } from "../data/cloud";
import { wakeCloud } from "../data/cloud-wake";
import { api } from "../lib/api";
import type { CheckoutSource, CloudDesktop, PlanCatalog } from "../data/contracts";
import { bundleOf, desktopOf, dollars, planSpecLine } from "../data/pricing";
import { planSelection, type PaidPlan } from "./plan-sheet";
import { checkoutDone, trialAction, useQuickCheckout } from "./cloud-offer";
import { useSession } from "../data/session";
import { duration } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { Choice, Modal, StatusDot } from "../ui/controls";
import { Button, cx } from "../ui/kit";
import { Mascot } from "../ui/Mascot";

export const STATUS: Record<CloudDesktop["status"], { label: string; tone: "good" | "warn" | "bad" | "quiet" | "accent" }> = {
  provisioning: { label: "setting up", tone: "accent" },
  running: { label: "online", tone: "good" },
  waking: { label: "waking up", tone: "warn" },
  sleeping: { label: "stopped", tone: "quiet" },
  stopped: { label: "off", tone: "quiet" },
  error: { label: "needs attention", tone: "bad" },
};

export function CloudStatus({ cloud, className }: { cloud: CloudDesktop; className?: string }) {
  const s = cloud.awaitingPayment ? { label: "waiting for payment", tone: "quiet" as const } : STATUS[cloud.status];
  const up = cloud.status === "running" && cloud.uptimeSec ? ` · up ${duration(cloud.uptimeSec)}` : "";
  return <StatusDot tone={s.tone} live={cloud.status === "running" || cloud.status === "waking" || (cloud.status === "provisioning" && !cloud.awaitingPayment)} className={className}>{s.label}{up}</StatusDot>;
}

export function regionName(catalog: PlanCatalog | null, id: string) {
  const r = catalog?.regions.find((x) => x.id === id);
  return r ? `${r.city}, ${r.name}` : id;
}

export function tierName(catalog: PlanCatalog | null, cloud: CloudDesktop) {
  return (catalog && desktopOf(catalog, cloud.tier)?.name) ?? (cloud.placement === "shared" ? "madani cloud" : "dedicated");
}

export function workspaceIcon(w: Pick<WorkspaceSummary, "kind">, cloud: CloudDesktop | null, size = 18) {
  const p = { size, strokeWidth: 1.5, "aria-hidden": true } as const;
  return cloud ? <Cloud {...p} /> : w.kind === "mac" ? <Monitor {...p} /> : <Server {...p} />;
}

const warmed = new Map<string, number>();
/** a cloud we put to sleep to save cost wakes, quietly, the moment its owner heads for it: once per few minutes at most */
export function prewarm(cloud: CloudDesktop) {
  if (!cloud.resting || Date.now() - (warmed.get(cloud.id) ?? 0) < 5 * 60_000) return;
  warmed.set(cloud.id, Date.now());
  void api.power(cloud.id, true).catch(() => {});
}

/** an action for a cloud we put to sleep wakes it now, whatever opened lately, with the corner pill showing how far it got; the action itself waits for it */
export function wakeFirst(cloud: CloudDesktop | null | undefined, name: string) {
  if (!cloud?.resting) return;
  warmed.set(cloud.id, Date.now());
  void wakeCloud(cloud, name);
}

/** power: asleep or off wakes at once; turning off asks first, since bots stop answering */
export function PowerButton({ cloud, size = "sm" }: { cloud: CloudDesktop; size?: "sm" | "md" }) {
  const { power } = useCloud();
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  if (cloud.status === "provisioning") return null;
  if (cloud.status === "waking") return <Button size={size} variant="outline" disabled><Power size={15} strokeWidth={1.75} aria-hidden />waking</Button>;
  const on = cloud.status === "running" || cloud.status === "error";
  const go = async (next: boolean) => {
    setBusy(true); setAsking(false);
    try { await power(cloud.id, next); toast(next ? `waking ${cloud.name}` : `${cloud.name} is going to sleep`); } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <>
      <Button size={size} variant={on ? "outline" : "primary"} disabled={busy} onClick={() => (on ? setAsking(true) : void go(true))}>
        <Power size={15} strokeWidth={1.75} aria-hidden />{busy ? (on ? "sleeping" : "waking") : on ? "sleep" : "wake"}
      </Button>
      <Modal open={asking} onClose={() => setAsking(false)} title={`put ${cloud.name} to sleep?`} footer={<><Button onClick={() => setAsking(false)}>keep it on</Button><Button variant="primary" onClick={() => void go(false)}>sleep</Button></>}>
        your bots stop answering and their routines wait until you wake it again. nothing on it is lost.
      </Modal>
    </>
  );
}

export function Provisioning({ cloud }: { cloud: CloudDesktop }) {
  const v = Math.round((cloud.progress?.value ?? 0) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-14">
        <span className="text-ink-2" aria-live="polite">{cloud.awaitingPayment ? "finish checkout and it starts setting up" : cloud.progress?.step ?? "getting ready"}</span>
        <span className="num text-ink-3">{v}%</span>
      </div>
      <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label="setting up your madani cloud">
        <div className="bar-fill h-full w-full rounded-full bg-accent" style={{ transform: `scaleX(${Math.max(0.03, v / 100)})` }} />
        <div className="sweep absolute inset-y-0 left-0 w-1/3 bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--bg)_45%,transparent),transparent)]" aria-hidden />
      </div>
    </div>
  );
}

/** plus or pro in two rows and one button that goes straight to checkout */
export function QuickPick({ catalog, source, className, onDone, secondary }: { source: CheckoutSource; catalog: PlanCatalog; className?: string; onDone?(): void | Promise<void>; secondary?: ReactNode }) {
  const { checkout } = useCloud();
  const { toast } = useSession();
  const [pick, setPick] = useState<PaidPlan>("starter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = bundleOf(catalog, pick);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      if (await checkout({ source, kind: "plan", selection: planSelection(catalog, pick, { interval: "month", work: false }), bundle: null })) {
        toast(checkoutDone(catalog));
        if (onDone) await onDone(); else navigate("/cloud");
      } else setError("checkout didn't open. try again.");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={className}>
      <fieldset className="min-w-0">
        <legend className="sr-only">plan</legend>
        <div className="flex flex-col gap-1">
          {(["starter", "pro"] as const).map((id) => {
            const b = bundleOf(catalog, id);
            const d = b ? desktopOf(catalog, b.desktop) : null;
            return b && <Choice key={id} name="quick-plan" value={id} checked={id === pick} onChange={() => setPick(id)} title={b.name} detail={d ? planSpecLine(d, b.license !== "personal") : b.blurb} aside={<>{dollars(b.monthly)}<span className="text-ink-3">/mo</span></>} />;
          })}
        </div>
      </fieldset>
      <p className="mt-4 text-13 text-ink-3">always available, cancel any time.</p>
      {error && <p role="alert" className="mt-2 text-13 text-bad">{error}</p>}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        {secondary}
        <Button variant="primary" onClick={() => void go()} disabled={busy || !chosen}>{busy ? "opening checkout" : trialAction(catalog) ?? `continue, ${dollars(chosen?.monthly ?? 0)}/mo`}</Button>
      </div>
    </div>
  );
}

/** the one cloud pitch: a line, a sentence, one button straight to checkout and the three mascots; home and the empty cloud page share it */
export function CloudPitch({ source = "dash_cloud", title = "keep your bots on while your mac sleeps", body = "madani cloud runs them all day and all night. set up in one click.", action, link = { to: "/billing", label: "see plans" }, className, id = "pitch-title", style }: { source?: CheckoutSource; title?: string; body?: ReactNode; action?: ReactNode | false; link?: { to: string; label: string } | null; className?: string; id?: string; style?: CSSProperties }) {
  const { catalog } = useCloud();
  const { busy, error, buy } = useQuickCheckout(source);
  return (
    <section className={cx("surface enter flex items-center gap-8 rounded-card bg-card px-8 py-7 max-sm:flex-col-reverse max-sm:items-start max-sm:gap-5 max-sm:p-5", className)} style={style} aria-labelledby={id}>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-24 font-medium tracking-[-0.035em] text-ink">{title}</h2>
        <p className="mt-1.5 max-w-[52ch] text-14 leading-[1.55] text-ink-3">{body}</p>
        {(action !== false || link) && (
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
            {action === false ? null : action ?? <Button variant="primary" onClick={() => void buy("starter")} disabled={busy || !catalog} aria-busy={busy}>{busy ? <><LoaderCircle size={17} strokeWidth={2} className="spin" aria-hidden />opening checkout</> : "get madani cloud"}</Button>}
            {link && <Link to={link.to} className="text-link inline-flex h-9 items-center text-14 max-sm:h-11">{link.label}</Link>}
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-13 text-bad">{error}</p>}
      </div>
      <div className="flex shrink-0 items-end gap-1 pe-2" aria-hidden>
        <Mascot color="orange" body="boxo" size={52} state="sleeping" />
        <span className="mb-3 inline-flex"><Mascot color="blue" body="kit" size={72} state="working" /></span>
        <Mascot color="pink" body="hearty" size={52} state="sleeping" />
      </div>
    </section>
  );
}
