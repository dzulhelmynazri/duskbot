import { useMemo, useState, type ReactNode } from "react";
import { Download } from "@/icons";
import { useCloud } from "../data/cloud";
import { LoadError } from "./common";
import { useSession } from "../data/session";
import { useAccountUsage, type PlanWindow } from "../data/usage";
import { eventsCsv, seriesBy, TOKEN_KINDS, type UsageGroup, type UsageMonth } from "../data/usage-math";
import { exact, parseDay, percent, shortDate, until, usd } from "../lib/format";
import { Select } from "../ui/controls";
import { Bar, Button, Card, PageHeader, Skeleton, Stat as Part } from "../ui/kit";
import { Nil, SectionHead, Table, Td, Th } from "../ui/table";
import { Legend, UsageChart } from "../ui/UsageChart";
import { useNow } from "../lib/now";
import { Figure } from "../ui/Figure";
import { Activity } from "./activity";

const GROUPS: Array<{ value: UsageGroup; label: string }> = [{ value: "type", label: "token type" }, { value: "bot", label: "bot" }, { value: "model", label: "model" }, { value: "workspace", label: "workspace" }];
const PAGE = 12;

function Label({ id, children }: { id?: string; children: ReactNode }) {
  return <h2 id={id} className="text-15 text-ink-3">{children}</h2>;
}

function Big({ value, unit }: { value: ReactNode; unit?: string }) {
  return <p className="mt-4 flex min-w-0 items-baseline gap-2"><Figure value={value} />{unit && <span className="text-15 text-ink-3">{unit}</span>}</p>;
}

const resetText = (t: number | null, now: number) => (t ? (t - now < 86_400_000 ? `resets ${until(t, now)}` : `resets ${shortDate(t)}`) : "no reset time");

function Included({ plans, now }: { plans: PlanWindow[]; now: number }) {
  const top = plans[0];
  return (
    <Card className="min-w-0 p-7" aria-labelledby="included-title">
      <Label id="included-title">{top ? `${top.provider}${top.plan ? ` ${top.plan}` : ""}, ${top.label.toLowerCase()} included usage` : "included usage"}</Label>
      {top ? (
        <>
          <Big value={percent(top.usedPercent)} unit="used" />
          <Bar value={top.usedPercent} tone={top.usedPercent >= 90 ? "warn" : "ink"} className="mt-5 !h-[5px]" label={`${top.provider} ${top.label} usage`} />
          <p className="mt-3 text-14 text-ink-3">{resetText(top.resetsAt, now)} · from {top.workspaceName}</p>
        </>
      ) : <p className="mt-4 max-w-[44ch] text-15 leading-[1.55] text-ink-3">sign in to codex or claude in the app and your plan usage shows up here.</p>}
    </Card>
  );
}

function Resets({ plans, now }: { plans: PlanWindow[]; now: number }) {
  return (
    <Card className="min-w-0 p-7" aria-labelledby="resets-title">
      <Label id="resets-title">usage resets</Label>
      {plans.length ? (
        <ul className="mt-3">
          {plans.map((p) => (
            <li key={`${p.provider}-${p.label}`} className="grid grid-cols-[minmax(0,1fr)_minmax(80px,200px)_48px] items-center gap-5 py-3.5 max-sm:grid-cols-[minmax(0,1fr)_48px]">
              <div className="min-w-0">
                <div className="truncate text-15 text-ink">{p.provider}{p.plan ? ` ${p.plan}` : ""} · {p.label.toLowerCase()}</div>
                <div className="truncate text-13 text-ink-3">{resetText(p.resetsAt, now)}</div>
              </div>
              <Bar value={p.usedPercent} tone={p.usedPercent >= 90 ? "warn" : "ink"} className="max-sm:hidden" label={`${p.provider} ${p.label} usage`} />
              <span className="num text-end text-15 text-ink-2">{percent(p.usedPercent)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-4 text-17 text-ink-2">no usage resets available</p>}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-card bg-card px-7 py-6 max-sm:px-5 max-sm:py-5">
      <div className="text-15 text-ink-3">{label}</div>
      <div className="mt-2"><Figure value={value} /></div>
    </div>
  );
}

/** the month's tokens in full, then input, output and cache on their own */
function Tokens({ month }: { month: UsageMonth | null }) {
  const split = month?.split.totals;
  const older = split && split.unsplit > 0;
  const none = older && split.unsplit === month.totals.tokens;
  return (
    <div className="min-w-0 rounded-card bg-card px-7 py-6 max-sm:px-5 max-sm:py-5">
      <div className="text-15 text-ink-3">total tokens</div>
      <div className="mt-2">{month ? <Figure value={exact(month.totals.tokens)} /> : <Skeleton className="h-8 w-24" />}</div>
      {month && split && !none && (
        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
          {TOKEN_KINDS.map(({ key, label }) => <Part key={key} label={label} value={exact(split[key])} />)}
          {older && <Part label="not split" value={exact(split.unsplit)} />}
        </div>
      )}
      {month && (older || none) && month.totals.tokens > 0 && <p className="mt-4 text-13 text-ink-3">{none ? "input, output and cache show up once your workspaces run the latest app." : "not split comes from workspaces on an older app."}</p>}
    </div>
  );
}

export function UsagePage() {
  const now = useNow(60_000);
  const cloud = useCloud();
  const { month, plans, loading, error, refresh } = useAccountUsage();
  const { detail } = useSession();
  const [group, setGroup] = useState<UsageGroup>("type");
  const [limit, setLimit] = useState(PAGE);
  const series = useMemo(() => (month ? seriesBy(month, group) : []), [month, group]);
  const exportCsv = () => {
    if (!month) return;
    const url = URL.createObjectURL(new Blob([eventsCsv(month.events)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `madanibot-usage-${month.days[0]?.slice(0, 7) ?? "month"}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const loadError = error ?? cloud.error;
  if (loadError && !month) return <div><PageHeader title="usage" sub="this month, every workspace." /><LoadError error={loadError} retry={() => { refresh(); cloud.refresh(); }} /></div>;
  return (
    <div className="min-w-0">
      <PageHeader title="usage" sub="this month, every workspace." />
      <Included plans={plans} now={now} />
      <p className="mt-3 px-1 text-14 text-ink-4">included usage comes with the plans your bots sign in to.</p>

      <div className="mt-8 flex flex-col gap-4">
        {/* one plan is already the card above; the list only adds something with more than one */}
        {plans.length > 1 && <Resets plans={plans} now={now} />}
        <div className="grid gap-4 md:grid-cols-2">
          <Tokens month={!loading ? month : null} />
          <Stat label="bot turns" value={!loading && month ? month.totals.turns.toLocaleString("en-US") : <Skeleton className="h-8 w-24" />} />
        </div>
        <Card aria-labelledby="chart-title" className="min-w-0">
          <SectionHead id="chart-title" action={
            <div className="flex items-center gap-3">
              <label htmlFor="usage-group" className="text-13 text-ink-3">group by</label>
              <Select id="usage-group" className="w-[150px] [&_select]:!h-10 [&_select]:!rounded-full" value={group} onChange={(e) => setGroup(e.target.value as UsageGroup)}>
                {GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </Select>
            </div>
          }>tokens per day</SectionHead>
          <div className="mt-6">
            {loading || !month ? <Skeleton className="h-[260px]" />
              : month.totals.tokens === 0 ? <p className="py-20 text-center text-14 text-ink-3">no bot turns yet this month. usage shows up here after the first chat.</p>
              : <UsageChart days={month.days} series={series} />}
          </div>
          {month && month.totals.tokens > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <Legend series={series} />
              {month.estimated && (group === "bot" || group === "model") && <p className="text-13 text-ink-3">per-day split by {group} is estimated from the month.</p>}
            </div>
          )}
        </Card>
        {detail?.report?.activity && <Activity detail={detail} now={now} />}
      </div>

      <section className="mt-12" aria-labelledby="events-title">
        <SectionHead id="events-title" action={<Button variant="outline" onClick={exportCsv} disabled={!month || month.events.length === 0}><Download size={16} strokeWidth={1.5} aria-hidden />export</Button>}>usage events</SectionHead>
        {loading || !month ? (
          <div className="flex flex-col gap-2" aria-busy="true">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : month.events.length ? (
          <>
            <Table label="usage events" className="max-sm:[&_table]:table-fixed max-sm:[&_td]:px-2 max-sm:[&_th]:px-2">
              <thead>
                <tr>
                  <Th className="max-sm:w-[20%]">date</Th>
                  <Th className="max-md:hidden">workspace</Th>
                  <Th className="max-sm:w-[32%]">bot</Th>
                  <Th className="max-lg:hidden">model</Th>
                  <Th className="!text-end max-md:hidden">turns</Th>
                  <Th className="!text-end max-sm:w-[25%]">tokens</Th>
                  <Th className="!text-end max-sm:w-[23%]">cost</Th>
                </tr>
              </thead>
              <tbody>
                {month.events.slice(0, limit).map((e) => (
                  <tr key={`${e.date}-${e.workspaceId}-${e.bot}`} className="hover-row">
                    <Td className="num whitespace-nowrap">{shortDate(parseDay(e.date))}</Td>
                    <Td className="max-w-[200px] truncate text-ink-2 max-md:hidden">{e.workspaceName}</Td>
                    <Td className="max-w-[160px] truncate">{e.bot}</Td>
                    <Td className="max-w-[200px] truncate text-ink-2 max-lg:hidden">{e.model === "Mixed" ? <Nil /> : e.model}</Td>
                    <Td className="num text-end text-ink-2 max-md:hidden">{e.turns.toLocaleString("en-US")}</Td>
                    <Td className="num truncate text-end" title={exact(e.tokens)}>{exact(e.tokens)}</Td>
                    <Td className="num truncate text-end text-ink-2">{e.costUsd === null ? <Nil /> : usd(e.costUsd)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {month.events.length > limit && <button type="button" onClick={() => setLimit((n) => n + PAGE * 2)} className="press-soft hover-ghost -ms-4 mt-2 h-11 rounded-full px-4 text-14 text-ink-3">show more</button>}
          </>
        ) : <p className="py-8 text-14 text-ink-3">no usage events yet this month.</p>}
        <p className="mt-4 text-13 text-ink-3">costs are estimates. workspaces report daily totals, never your messages.</p>
      </section>
    </div>
  );
}
