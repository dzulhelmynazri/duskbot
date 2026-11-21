import { useEffect, useState } from "react";
import { AppWindow, Check } from "@/icons";
import { useCloud } from "../data/cloud";
import type { CloudDesktop, DesktopTier, PlanCatalog, SlackWake } from "../data/contracts";
import { desktopMonthly, desktopOf, dollars, gb, planTotal, specLine } from "../data/pricing";
import { useSession } from "../data/session";
import { api, ApiError } from "../lib/api";
import { longDate, MONTH_NAMES } from "../lib/format";
import { SETUP_LABELS } from "../data/live";
import { SETUP_STEPS } from "../data/wire";
import { Link } from "../lib/router";
import { appLink, openApp } from "../lib/app-link";
import { Switch } from "../ui/controls";
import { Button, Card, cx, KV, PageHeader, SectionTitle, Skeleton } from "../ui/kit";
import { Mascot } from "../ui/Mascot";
import { useWorkspaceLoad } from "../data/detail";
import { NumbersPending } from "./numbers-pending";
import { CloudPitch, CloudStatus, PowerButton, prewarm, Provisioning, regionName, tierName } from "./cloud-bits";
import { DeleteDataAction, DeletionBanner } from "./DeleteData";
import { canDeleteData, deletion } from "../data/delete-data";
import { MachineView } from "./Machine";
import { ResizeDialog } from "./resize-sheet";
import { useNow } from "../lib/now";
import { useAccountUsage } from "../data/usage";
import { MoveGuide } from "./cloud-card";

/** no madani cloud yet: the one pitch, then the sizes it comes in */
function Empty() {
  const { catalog } = useCloud();
  return (
    <div className="flex flex-col gap-4">
      <CloudPitch title="keep your bots working" body="madani cloud keeps your bots available, even while your mac sleeps." link={{ to: "/workspaces#add", label: "use my own server instead" }} />
      <Card className="enter" style={{ ["--i" as string]: 1 }} aria-labelledby="sizes-title">
        <SectionTitle id="sizes-title" action={<Link to="/billing" className="text-link inline-flex h-8 items-center text-13">plans and billing</Link>}>plans</SectionTitle>
        {catalog ? (
          <ul className="">
            {catalog.bundles.filter((b) => b.id !== "free").map((b) => {
              const d = desktopOf(catalog, b.desktop);
              return (
                <li key={b.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3 md:grid-cols-[140px_minmax(0,1fr)_minmax(0,280px)_auto]">
                  <span className="text-14 font-medium text-ink">{b.name}</span>
                  <span className="num truncate text-13 text-ink-3 max-md:hidden">{d ? specLine(d) : ""}</span>
                  <span className="truncate text-13 text-ink-3 max-md:hidden">{b.members > 1 ? `${b.members} seats, ` : ""}always available{d?.priority ? ", priority wake" : ""}</span>
                  <span className="num text-end text-14 text-ink">{dollars(b.monthly)}<span className="text-ink-3">/mo</span></span>
                </li>
              );
            })}
          </ul>
        ) : <Skeleton className="h-32" />}
        {catalog && <p className="mt-4 text-13 text-ink-3">{catalog.regions.length === 1 ? "region" : "regions"}: {catalog.regions.map((r) => r.city).join(", ")}. every size has its own sandbox, network and disk.</p>}
      </Card>
    </div>
  );
}

const STEPS: string[] = SETUP_STEPS.map((step) => SETUP_LABELS[step]);

function SettingUp({ cloud }: { cloud: CloudDesktop }) {
  const at = Math.max(0, STEPS.indexOf(cloud.progress?.step ?? ""));
  return (
    <Card className="!p-8 max-sm:!p-5" aria-labelledby="setup-title">
      <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_200px] md:items-center">
        <div className="min-w-0">
          <h2 id="setup-title" className="text-24 font-medium tracking-[-0.035em] text-ink">setting up {cloud.name}</h2>
          <p className="mt-1 text-14 text-ink-3">about a minute. your bots move in by themselves.</p>
          <div className="mt-6"><Provisioning cloud={cloud} /></div>
          <ol className="mt-6 flex flex-col gap-2.5">
            {STEPS.map((s, i) => (
              <li key={s} className={cx("flex items-center gap-3 text-14", i < at ? "text-ink-3" : i === at ? "text-ink" : "text-ink-4")}>
                <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
                  {i < at ? <Check size={14} strokeWidth={2} /> : <span className={cx("live-dot !size-1.5", i === at ? "text-ink" : "text-ink-4")} data-live={i === at} />}
                </span>
                {s}<span className="sr-only">{i < at ? ", done" : i === at ? ", in progress" : ""}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="flex items-end justify-center gap-1 max-md:hidden" aria-hidden>
          <Mascot color="orange" size={36} />
          <span className="mb-3 inline-flex"><Mascot color="blue" size={48} /></span>
          <Mascot color="green" size={36} />
        </div>
      </div>
    </Card>
  );
}

/** the size it is, what that includes, and the next size up */
function Size({ cloud, catalog }: { cloud: CloudDesktop; catalog: PlanCatalog }) {
  const { billing } = useCloud();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<DesktopTier["id"] | null>(null);
  const sub = billing?.subscription;
  const current = desktopOf(catalog, cloud.tier);
  const next = catalog.desktops[catalog.desktops.findIndex((d) => d.id === cloud.tier) + 1] ?? null;
  const total = sub ? planTotal(catalog, sub.selection) : null;
  const includes = [
    specLine(cloud),
    cloud.placement === "shared" ? "its own sandbox on our machines" : "a whole machine of its own",
    current?.priority ? "always available, priority wake" : "always available, wakes in seconds",
  ];
  return (
    <Card aria-labelledby="size-title" className="flex flex-col">
      <SectionTitle id="size-title" action={<Button size="sm" onClick={() => { setFocus(null); setOpen(true); }} disabled={!sub}>resize</Button>}>size</SectionTitle>
      <p className="flex flex-wrap items-baseline gap-x-2"><span className="text-24 font-medium tracking-[-0.035em] text-ink">{current?.name ?? tierName(catalog, cloud)}</span>{total ? <span className="num text-14 text-ink-3">{total.amount}{total.unit} {total.note === "cloud size only" ? "" : total.note}</span> : current && <span className="num text-14 text-ink-3">{dollars(desktopMonthly(current, null, catalog.custom))}/mo</span>}</p>
      <ul className="mt-4 flex flex-col gap-2">
        {includes.map((line) => <li key={line} className="flex gap-2.5 text-14 text-ink-2"><Check size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-4" aria-hidden />{line}</li>)}
      </ul>
      {next && (
        <div className="mt-auto pt-6">
          <div className="rounded-[16px] bg-btn px-4 py-3.5">
            <p className="text-13 leading-[1.5] text-ink-3"><span className="text-ink-2">need more room?</span> {next.name} gives you {next.vcpu} vcpu, {gb(next.ramGb)} ram and {gb(next.diskGb)} disk{next.priority && !current?.priority ? ", with priority wake" : ""}.</p>
            <button type="button" onClick={() => { setFocus(next.id); setOpen(true); }} disabled={!sub} className="text-link mt-2 inline-flex h-8 items-center text-13 disabled:opacity-45">upgrade to {next.name}</button>
          </div>
        </div>
      )}
      <ResizeDialog open={open} onClose={() => setOpen(false)} cloud={cloud} catalog={catalog} focus={focus} />
    </Card>
  );
}

function SlackWakeSetting({ cloud }: { cloud: CloudDesktop }) {
  const { toast } = useSession();
  const [wake, setWake] = useState<SlackWake | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (busy) return;
    const ctl = new AbortController();
    let unavailable = false;
    let loading = false;
    const load = async () => {
      if (unavailable || loading || document.visibilityState !== "visible") return;
      loading = true;
      try {
        const answer = await api.slackWake(cloud.id, ctl.signal);
        if (!ctl.signal.aborted) { setWake(answer); unavailable = !answer.available; }
      } catch (e) {
        if (!ctl.signal.aborted && e instanceof ApiError && e.status === 404) { setWake(null); unavailable = true; }
      } finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    document.addEventListener("visibilitychange", load);
    return () => { ctl.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [cloud.id, cloud.status, busy]);
  const change = async (enabled: boolean) => {
    setBusy(true);
    try { setWake(await api.setSlackWake(cloud.id, enabled)); }
    catch (e) {
      if (e instanceof ApiError && e.status === 404) setWake(null);
      else toast((e as Error).message, "bad");
    } finally { setBusy(false); }
  };
  if (!wake?.available) return null;
  const waiting = (wake.state === "holding" || wake.state === "waking") && wake.buffered > 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-3">
      <dt className="text-14 text-ink-3">wake for slack</dt>
      <dd><Switch label="wake for slack" checked={wake.enabled} disabled={busy} onChange={(enabled) => void change(enabled)} /></dd>
      <dd className="col-span-2 text-13 text-ink-3" aria-live="polite">{waiting ? `${wake.buffered} slack ${wake.buffered === 1 ? "message" : "messages"} waiting, waking ${cloud.name}` : "while it sleeps we keep its slack connection, seal each message to this desktop and wake it. only the desktop can read them."}</dd>
    </div>
  );
}

function Live({ cloud }: { cloud: CloudDesktop }) {
  const { catalog, billing } = useCloud();
  const { pick, workspace } = useSession();
  const now = useNow();
  const { detail, error: detailError, retry } = useWorkspaceLoad(cloud.workspaceId);
  useEffect(() => { if (cloud.workspaceId && workspace?.id !== cloud.workspaceId) pick(cloud.workspaceId); }, [cloud.workspaceId, workspace?.id, pick]);
  const asleep = cloud.status === "sleeping" || cloud.status === "stopped";
  // opening its page is using it: a cloud we put to sleep wakes now, its numbers follow in seconds
  useEffect(() => { prewarm(cloud); }, [cloud]);
  const sub = billing?.subscription;
  const deleting = cloud.provider === "managed" && (canDeleteData(cloud, billing) || deletion(cloud) !== null);
  const { bots } = useAccountUsage();
  return (
    <div className="flex flex-col gap-4">
      <DeletionBanner cloud={cloud} />
      <MoveGuide cloud={cloud} rows={bots} cloudBots={detail?.report?.bots ?? null} />
      {cloud.revivedAt && now - cloud.revivedAt < 3 * 86_400_000 && (
        <Card className="!py-4" aria-live="polite">
          <p className="text-15 font-medium text-ink">welcome back</p>
          <p className="mt-1 text-14 text-ink-3">your cloud and bots are restored, right where they stopped.</p>
        </Card>
      )}
      {cloud.status === "error" && (
        <Card className="!py-4" aria-live="polite">
          <p className="text-14 text-bad">{cloud.error ?? "it stopped answering."}</p>
          <p className="mt-1 text-13 text-ink-3">waking it usually fixes this. if it does not, <a href="mailto:hello@madani.bot" className="text-link">write to us</a> and we look at it right away.</p>
        </Card>
      )}
      {cloud.egressLimit && (
        <Card className="!py-4" aria-live="polite">
          <p className="text-14 text-ink">{egressNotice(cloud.egressLimit)}</p>
          <p className="mt-1 text-13 text-ink-3">chat, browsing and your apps use very little. a proxy, a file host or a big upload loop is what gets here. <a href="mailto:hello@madani.bot" className="text-link">write to us</a> if that looks wrong.</p>
        </Card>
      )}
      {asleep && cloud.egressLimit?.state !== "paused" && (
        <Card className="flex flex-wrap items-center gap-5">
          <Mascot color="silver" size={40} state="sleeping" />
          <div className="min-w-0 flex-1">
            <h2 className="text-15 font-medium text-ink">{cloud.name} is asleep</h2>
            <p className="mt-0.5 text-14 text-ink-3">your bots and their routines wait until you wake it. nothing on it is lost.</p>
          </div>
          <PowerButton cloud={cloud} size="md" />
        </Card>
      )}
      {asleep ? null : !cloud.resting && detail ? <MachineView detail={detail} now={now} region={regionName(catalog, cloud.region)} /> : cloud.resting || cloud.status === "running" ? <NumbersPending cloud={cloud} error={detailError} retry={retry} /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Card aria-labelledby="about-title">
          <SectionTitle id="about-title">about</SectionTitle>
          <dl className="">
            <KV k="runs on" v={cloud.placement === "shared" ? "its own sandbox" : "its own machine"} />
            {(cloud.status === "running" || cloud.status === "sleeping") && <SlackWakeSetting key={cloud.id} cloud={cloud} />}
            <KV k="created" v={longDate(cloud.createdAt)} />
            {sub && <KV k={sub.cancelAt ? "ends" : "renews"} v={longDate(sub.cancelAt ?? sub.currentPeriodEnd)} />}
          </dl>
          {deleting ? <DeleteDataAction cloud={cloud} /> : <p className="mt-4 text-13 text-ink-3">to remove it, cancel it in <Link to="/billing" className="text-link">plans and billing</Link>.</p>}
        </Card>
        {catalog ? <Size cloud={cloud} catalog={catalog} /> : <Skeleton className="h-[220px] !rounded-card" />}
      </div>
    </div>
  );
}

export function CloudDesktopPage() {
  const { clouds, catalog } = useCloud();
  const cloud = clouds?.[0] ?? null;
  if (clouds === null) return <div aria-busy="true" aria-label="loading"><Skeleton className="h-9 w-64" /><Skeleton className="mt-8 h-[420px] !rounded-card" /></div>;
  if (!cloud) {
    return (
      <div>
        <PageHeader title="madani cloud" sub="an always-on computer for your bots." />
        <Empty />
      </div>
    );
  }
  const running = cloud.status === "running";
  return (
    <div>
      <PageHeader
        title={cloud.name}
        sub={<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"><CloudStatus cloud={cloud} /><span className="text-13 font-medium text-ink-3">{regionName(catalog, cloud.region)}</span></span>}
        action={cloud.status === "provisioning" ? undefined : <div className="flex gap-2"><PowerButton cloud={cloud} size="md" /><Button variant={running ? "primary" : "outline"} onPointerEnter={() => prewarm(cloud)} onFocus={() => prewarm(cloud)} onClick={() => { prewarm(cloud); openApp(appLink.cloud); }}><AppWindow size={16} strokeWidth={1.5} aria-hidden />open in the app</Button></div>}
      />
      {cloud.status === "provisioning" ? <SettingUp cloud={cloud} /> : <Live cloud={cloud} />}
    </div>
  );
}

/** the 1st, in utc: the day the month's limits lift */
export function egressNotice(limit: NonNullable<CloudDesktop["egressLimit"]>): string {
  const day = new Date(limit.until), date = `${MONTH_NAMES[day.getUTCMonth()]!.toLowerCase()} ${day.getUTCDate()}`;
  return limit.state === "paused" ? `your madani cloud sent a lot of data this month, so it is paused until ${date}.` : `your madani cloud sent a lot of data this month, so its connection is slowed until ${date}.`;
}
