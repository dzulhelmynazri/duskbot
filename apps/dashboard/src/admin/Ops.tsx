import { useState, type ReactNode } from "react";
import { RefreshCw } from "@/icons";
import { Button, cx } from "../ui/kit";
import { m } from "../ui/motion";
import { ago, compact } from "../lib/format";
import { Link } from "../lib/router";
import { PersonLink } from "./sheet";
import { useNow } from "../lib/now";
import { toast } from "../lib/toast";
import { adminCall, useAdmin } from "./api";
import { Avatar, percent, personName, usd } from "./kit";
import { AdminHeader, Failed, Loading, n } from "./ui";
import { Chevron, Fold, Reveal } from "./Fold";
import { mbit, monthOut, Relays, RelaySummary, useRelays } from "./OpsRelays";
import { TopAccounts } from "./OpsAccounts";
import { OpsSharing } from "./OpsSharing";
import type { OpsRelayCard } from "./ops-types";
import type { OpsAnswer, OpsBox, OpsCheck, OpsLevel, OpsMeter, OpsRule, OpsSource, OpsSourceId, OpsSpend } from "./ops-types";

const here = (id: string) => `/admin/ops#${id}`;
export function size(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const units = ["b", "kb", "mb", "gb", "tb"];
  let v = value, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
const perSecond = (value: number) => `${size(value)}/s`;
const short = (value: number) => compact(value).toLowerCase();
const gb = (value: number) => `${Math.round(value * 10) / 10} gb`;
const hours = (value: number) => `${n(Math.round(value))} h`;

const LEVEL_DOT: Record<OpsLevel, string> = { ok: "bg-good", watch: "bg-warn", bad: "bg-bad", unknown: "bg-ink-4" };
const RULE_LEVEL: Record<OpsRule["state"], OpsLevel> = { ok: "ok", pending: "watch", firing: "bad" };
const RANK: Record<OpsLevel, number> = { bad: 0, watch: 1, unknown: 2, ok: 3 };

function Dot({ level }: { level: OpsLevel }) {
  return <span aria-hidden className={cx("inline-block size-[7px] shrink-0 rounded-[2px]", LEVEL_DOT[level])} />;
}

/** a level as a small square plus its word, so colour is never the only signal */
export function Level({ level, word }: { level: OpsLevel; word?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Dot level={level} />
      <span className={cx("text-12", level === "ok" || level === "unknown" ? "text-ink-3" : "text-ink-2")}>{word ?? level}</span>
    </span>
  );
}

/** a titled card with a light inner panel; every section on the page uses this one shape */
export function Panel({ id, title, meta, children, foot }: { id: string; title: string; meta?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex min-w-0 scroll-mt-6 flex-col rounded-[24px] bg-card p-2">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 px-2 pb-1.5 pt-1">
        <h2 id={`${id}-title`} className="text-14 font-medium text-ink">{title}</h2>
        {meta && <span className="t-meta">{meta}</span>}
      </div>
      <div className="flex-1 rounded-[18px] bg-pop p-1.5">{children}</div>
      {foot}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-5 text-13 text-ink-3">{children}</p>;
}

/** label and value pairs for an opened row */
export function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 max-sm:grid-cols-1">
      {items.map(([label, value]) => (
        <div key={label} className="flex min-w-0 items-baseline justify-between gap-3 text-12">
          <dt className="truncate text-ink-3">{label}</dt>
          <dd className="shrink-0 font-mono text-ink-2 num">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Bar({ share, level, tick }: { share: number; level: OpsLevel; tick?: number | null }) {
  return (
    <span aria-hidden className="relative block h-1.5 rounded-full bg-track">
      <span className="absolute inset-0 overflow-hidden rounded-full">
        {level !== "unknown" && <span className={cx("bar-fill absolute inset-0 block rounded-full", level === "bad" ? "bg-bad" : level === "watch" ? "bg-warn" : "bg-accent")} style={{ transform: `scaleX(${Math.max(0.01, Math.min(1, share))})` }} />}
      </span>
      {tick !== null && tick !== undefined && <span className="absolute -top-[3px] h-3 w-0.5 -translate-x-1/2 rounded-full bg-ink-2" style={{ left: `${Math.min(1, tick) * 100}%` }} />}
    </span>
  );
}

/** one quota: used against what the plan includes, with a tick where the month ends at this pace */
export function Meter({ label, meter, format }: { label: string; meter: OpsMeter; format(v: number): string }) {
  const limit = meter.limit && meter.limit > 0 ? meter.limit : null;
  return (
    <div className="min-w-0" role="img" aria-label={`${label}: ${format(meter.used)}${limit ? ` of ${format(limit)}` : ""}${meter.projected !== null ? `, ${format(meter.projected)} at this pace` : ""}`}>
      <div className="flex items-baseline justify-between gap-3 text-12">
        <span className="truncate text-ink-3">{label}</span>
        <span className="shrink-0 font-mono text-ink-3 num"><span className="text-ink-2">{format(meter.used)}</span>{limit ? ` of ${format(limit)}` : ""}</span>
      </div>
      {limit && <div className="mt-1.5"><Bar share={meter.used / limit} level={meter.level} tick={meter.projected !== null ? meter.projected / limit : null} /></div>}
    </div>
  );
}

export function Person({ accountId, email, fallback, sub }: { accountId: string | null; email: string | null; fallback?: string; sub?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {accountId && <Avatar seed={accountId} size={20} customer account={{ id: accountId }} />}
      <span className="min-w-0">
        <span className="block truncate text-13 text-ink">{accountId ? personName(accountId, email) : email ?? fallback ?? "unknown"}</span>
        {sub && <span className="block truncate text-12 text-ink-3">{sub}</span>}
      </span>
    </span>
  );
}

export function PersonRow({ accountId, children }: { accountId: string | null; children: ReactNode }) {
  const cls = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-2.5 py-2";
  return <li>{accountId ? <PersonLink id={accountId} className={cx("hover-row", cls)}>{children}</PersonLink> : <div className={cls}>{children}</div>}</li>;
}

const gaugeLevel = (v: number | null): OpsLevel => v === null ? "unknown" : v >= 90 ? "bad" : v >= 75 ? "watch" : "ok";

type Item = { key: string; level: OpsLevel; label: string; why: string; to: string; person?: string };
/** everything that is not ok right now, worst first */
function attention(data: OpsAnswer): Item[] {
  const items: Item[] = [];
  const { workers, r2, brevo, composio, instabox, mail } = data.spend;
  const resend = mail?.providers.find((p) => p.provider === "resend" && p.configured);
  for (const rule of data.alerts) if (rule.state !== "ok") items.push({ key: `rule:${rule.id}`, level: RULE_LEVEL[rule.state], label: rule.label, why: `alert ${rule.state}${rule.value ? `, now ${rule.value}` : ""}, over ${rule.threshold}`, to: here("ops-services") });
  for (const check of data.health.checks) if (check.level === "bad" || check.level === "watch") items.push({ key: `check:${check.id}`, level: check.level, label: check.name, why: check.detail ?? check.value, to: here("ops-services") });
  const ruled = new Set(items.map((item) => item.label));
  for (const box of data.health.boxes) {
    for (const [what, value] of [["cpu", box.cpu], ["memory", box.mem], ["disk", box.disk]] as const) {
      const level = gaugeLevel(value), label = `${box.name} ${what}`;
      if ((level === "bad" || level === "watch") && !ruled.has(label)) items.push({ key: `box:${label}`, level, label, why: `${Math.round(value ?? 0)}% used`, to: here("ops-machines") });
    }
  }
  const meters: Array<[string, OpsMeter | undefined, (v: number) => string]> = [
    ["cloudflare workers requests", workers?.requests, short], ["cloudflare workers cpu time", workers?.cpuMs, (v) => `${short(v)} ms`],
    ["r2 storage", r2?.total, size], ["brevo emails today", brevo?.daily, n], ["brevo emails this month", brevo?.monthly, n],
    ["resend emails today", resend?.daily, n], ["resend emails this month", resend?.monthly, n],
  ];
  for (const [label, meter, format] of meters) {
    if (meter && (meter.level === "bad" || meter.level === "watch") && !ruled.has(label)) items.push({ key: `meter:${label}`, level: meter.level, label,
      why: `${format(meter.used)}${meter.limit ? ` of ${format(meter.limit)} included` : ""}${meter.projected !== null ? `, ${format(meter.projected)} at this pace` : ""}`, to: here("ops-spend") });
  }
  if (composio?.nearLimit) items.push({ key: "composio", level: "watch", label: "composio", why: `${n(composio.nearLimit)} ${composio.nearLimit === 1 ? "install is" : "installs are"} past 80% of their daily limit`, to: here("ops-spend") });
  for (const source of data.sources) if (source.configured && !source.ok) items.push({ key: `source:${source.id}`, level: "bad", label: source.label, why: source.error ? `collector failing: ${source.error}` : "collector failing, numbers are stale", to: here("ops-sources") });
  for (const row of instabox.limited) items.push({ key: `limited:${row.cloudId}`, level: row.state === "paused" ? "bad" : "watch", label: personName(row.accountId, row.email), why: `cloud ${row.state}, ${gb(row.egressGb)} out this month`, to: "", person: row.accountId });
  return items.sort((a, b) => RANK[a.level] - RANK[b.level]);
}

const ItemLink = ({ item, className, children }: { item: Item; className: string; children: ReactNode }) =>
  item.person ? <PersonLink id={item.person} className={className}>{children}</PersonLink> : <Link to={item.to} className={className}>{children}</Link>;

function Summary({ data, items }: { data: OpsAnswer; items: Item[] }) {
  const checks = data.health.checks, ok = checks.filter((check) => check.level === "ok").length;
  const firing = data.alerts.filter((rule) => rule.state === "firing").length;
  const level: OpsLevel = items.some((item) => item.level === "bad") ? "bad" : items.length ? "watch" : "ok";
  return (
    <section aria-labelledby="ops-summary" className="rounded-[24px] bg-card p-2">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-2 pb-1.5 pt-1">
        <h2 id="ops-summary" className="flex items-center gap-2 text-14 font-medium text-ink"><Dot level={level} />{items.length ? `${n(items.length)} ${items.length === 1 ? "thing needs" : "things need"} a look` : "everything is ok"}</h2>
        <span className="t-meta">{n(ok)} of {n(checks.length)} checks ok · {n(firing)} {firing === 1 ? "alert" : "alerts"} firing</span>
      </div>
      <div className="rounded-[18px] bg-pop p-1.5">
        {items.length ? (
          <ul>
            {items.map((item) => (
              <li key={item.key}>
                <ItemLink item={item} className="hover-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-2.5 py-2">
                  <span className="flex min-w-0 items-baseline gap-2.5">
                    <span className="translate-y-[-1px]"><Dot level={item.level} /></span>
                    <span className="min-w-0">
                      <span className="block truncate text-13 text-ink">{item.label}</span>
                      <span className="block truncate text-12 text-ink-3">{item.why}</span>
                    </span>
                  </span>
                  <span className={cx("text-12", item.level === "bad" ? "text-bad" : "text-ink-3")}>{item.level === "bad" ? "bad" : "watch"}</span>
                </ItemLink>
              </li>
            ))}
          </ul>
        ) : <p className="px-2.5 py-2 text-13 text-ink-3">no alert is firing, every check passes and nothing is past its plan.</p>}
      </div>
    </section>
  );
}

function NotYet({ source }: { source: OpsSource | undefined }) {
  return <p className="text-12 text-ink-3">{!source || !source.configured ? "not set up yet." : source.error ? `not collected yet: ${source.error}` : "not collected yet."}</p>;
}

/** the opened part of one provider's spend row */
function SpendDetail({ provider, spend, sources, now }: { provider: OpsSpend["lines"][number]["provider"]; spend: OpsSpend; sources: OpsSource[]; now: number }) {
  const source = (id: OpsSourceId) => sources.find((s) => s.id === id);
  const { instabox, workers, r2, composio, brevo, dodo, relay } = spend;
  if (provider === "instabox") {
    const t = instabox.totals, customers = [...instabox.customers].sort((a, b) => b.costCents - a.costCents).slice(0, 8);
    return (
      <>
        <Facts items={[["machines", n(t.machines)], ["customers", n(t.customers)], ["awake", hours(t.awakeHours)], ["vcpu hours", n(Math.round(t.vcpuHours))], ["egress", gb(t.egressGb)], ["today", <span className="text-money">{usd(t.todayCents)}</span>]]} />
        {customers.length > 0 && (
          <ul className="-mx-2.5 mt-2">
            {customers.map((c) => (
              <PersonRow key={c.accountId} accountId={c.accountId}>
                <Person accountId={c.accountId} email={c.email} sub={<>{c.plan} · {hours(c.awakeHours)} awake · {gb(c.egressGb)}{c.egressState && <span className="text-warn"> · {c.egressState}</span>}</>} />
                <span className="font-mono text-13 text-money num">{usd(c.costCents)}</span>
              </PersonRow>
            ))}
          </ul>
        )}
      </>
    );
  }
  if (provider === "workers") {
    if (!workers) return <NotYet source={source("cloudflare")} />;
    return (
      <div className="flex flex-col gap-3">
        <Meter label="requests" meter={workers.requests} format={short} />
        <Meter label="cpu time" meter={workers.cpuMs} format={(v) => `${short(v)} ms`} />
        <Facts items={[["plan", workers.plan.label], ["base", <span className="text-money">{usd(workers.plan.baseCents)}</span>], ["overage at this pace", <span className="text-money">{usd(workers.overageCents)}</span>],
          ...workers.scripts.map((s) => [s.name, <>{short(s.requests)} req{s.errors ? <span className="text-warn"> · {short(s.errors)} errors</span> : null}</>] as [string, ReactNode])]} />
      </div>
    );
  }
  if (provider === "r2") {
    if (!r2) return <NotYet source={source("cloudflare")} />;
    return (
      <div className="flex flex-col gap-3">
        <Meter label="stored" meter={r2.total} format={size} />
        <Facts items={[["free tier", size(r2.freeBytes)], ["overage at this pace", <span className="text-money">{usd(r2.overageCents)}</span>], ...r2.buckets.map((b) => [b.name, `${size(b.bytes)} · ${n(b.objects)} objects`] as [string, ReactNode])]} />
      </div>
    );
  }
  if (provider === "brevo") {
    if (!brevo) return <NotYet source={source("brevo")} />;
    return (
      <div className="flex flex-col gap-3">
        <Meter label="today" meter={brevo.daily} format={n} />
        <Meter label="this month" meter={brevo.monthly} format={n} />
        <Facts items={[["sent today", n(brevo.today.sent)], ["delivered", n(brevo.today.delivered)], ["bounced", n(brevo.today.bounced)], ["blocked", n(brevo.today.blocked)]]} />
      </div>
    );
  }
  if (provider === "composio") {
    if (!composio) return <NotYet source={source("composio")} />;
    return (
      <>
        <Facts items={[["calls today", n(composio.today.calls)], ["this week", n(composio.week.calls)], ["installs past 80%", n(composio.nearLimit)], ["queue", composio.queue ? `${n(composio.queue.events)} · ${size(composio.queue.bytes)}` : "-"],
          ["limit per install", `${n(composio.limits.installation)} a day`], ["limit per account", `${n(composio.limits.account)} a day`]]} />
        {composio.top.length > 0 && (
          <ul className="-mx-2.5 mt-2">
            {composio.top.slice(0, 5).map((row) => (
              <PersonRow key={row.installationId} accountId={row.accountId}>
                <Person accountId={row.accountId} email={row.email} fallback={row.installationId} sub={`${percent(row.share)} of the limit · ${n(row.week)} this week`} />
                <span className="font-mono text-13 text-ink num">{n(row.today)}</span>
              </PersonRow>
            ))}
          </ul>
        )}
      </>
    );
  }
  if (provider === "relay") {
    if (!relay) return <NotYet source={source("relay")} />;
    return (
      <>
        <Facts items={[["today", size(relay.today.bytes)], ["this month", size(relay.month.bytes)], ["tunnels today", n(relay.today.tunnels)], ["limited today", n(relay.today.limited)], ["limit per tunnel", `${size(relay.dailyLimitBytes)} a day`]]} />
        {relay.top.length > 0 && (
          <ul className="-mx-2.5 mt-2">
            {relay.top.slice(0, 5).map((row) => (
              <PersonRow key={row.tunnelId} accountId={row.accountId}>
                <Person accountId={row.accountId} email={row.email} fallback={row.tunnelId} sub={`${size(row.monthBytes)} this month${row.limited ? `, limited ${n(row.limited)}x` : ""}`} />
                <span className="font-mono text-13 text-ink num">{size(row.todayBytes)}</span>
              </PersonRow>
            ))}
          </ul>
        )}
      </>
    );
  }
  return (
    <Facts items={[["fees today", <span className="text-money">{usd(dodo.todayCents)}</span>], ["charged this month", <span className="text-money">{usd(dodo.grossCents)}</span>], ["payments", n(dodo.payments)],
      ["rate", `${percent(dodo.rate.rate)} + ${usd(dodo.rate.fixedCents)}`], ["last webhook", dodo.lastWebhookAt ? ago(dodo.lastWebhookAt, now) : "never"], ["figures", dodo.estimated ? "estimated" : "from dodo"]]} />
  );
}

/** what each provider's meter means in the spend row: used against what the plan includes */
function included(provider: string, spend: OpsSpend): { share: number; level: OpsLevel; text: string } | null {
  const pick = provider === "workers" ? spend.workers && ([spend.workers.requests, (v: number) => `${short(v)} requests`] as const)
    : provider === "r2" ? spend.r2 && ([spend.r2.total, size] as const)
    : provider === "brevo" ? spend.brevo && ([spend.brevo.monthly, (v: number) => `${n(v)} emails`] as const) : null;
  if (!pick) return null;
  const [meter, format] = pick;
  if (!meter.limit) return null;
  return { share: meter.used / meter.limit, level: meter.level, text: `${format(meter.used)} of ${format(meter.limit)} included` };
}

const SPEND_COLS = "grid-cols-[minmax(0,1fr)_76px_76px_14px] max-sm:grid-cols-[minmax(0,1fr)_68px_68px_14px]";
function Spend({ spend, sources, now }: { spend: OpsSpend; sources: OpsSource[]; now: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const t = spend.totals;
  return (
    <Panel id="ops-spend" title="spend this month" meta={`today ${usd(t.todayCents)}`}>
      <div className={cx("grid gap-3 px-2.5 pb-1 pt-1 t-meta", SPEND_COLS)}><span>provider</span><span className="text-end">so far</span><span className="text-end">pace</span><span /></div>
      <ul>
        {spend.lines.map((line) => {
          const meter = included(line.provider, spend), isOpen = open === line.provider, panel = `ops-spend-${line.provider}`;
          return (
            <li key={line.provider}>
              <button type="button" aria-expanded={isOpen} aria-controls={panel} onClick={() => setOpen(isOpen ? null : line.provider)}
                className={cx("hover-row grid w-full items-center gap-3 rounded-[12px] px-2.5 py-2 text-start", SPEND_COLS)}>
                <span className="min-w-0">
                  <span className="block truncate text-13 text-ink">{line.label}</span>
                  {meter ? (
                    <span className="mt-1 flex items-center gap-2.5">
                      <span className="w-16 shrink-0"><Bar share={meter.share} level={meter.level} /></span>
                      <span className="truncate text-12 text-ink-3">{meter.text}</span>
                    </span>
                  ) : <span className="block truncate text-12 text-ink-3">{line.note}</span>}
                </span>
                <span className={cx("text-end font-mono text-13 num", line.monthCents > 0 ? "text-money" : "text-ink-4")}>{usd(line.monthCents)}</span>
                <span className={cx("text-end font-mono text-13 num", line.projectedCents > 0 ? "text-money" : "text-ink-4")}>{usd(line.projectedCents)}</span>
                <Chevron open={isOpen} />
              </button>
              <Reveal open={isOpen} id={panel}><div className="px-2.5 pb-3 pt-1">{<SpendDetail provider={line.provider} spend={spend} sources={sources} now={now} />}</div></Reveal>
            </li>
          );
        })}
        <li className={cx("mt-1 grid items-center gap-3 rounded-[12px] bg-wash-lime px-2.5 py-2", SPEND_COLS)}>
          <span className="text-13 font-medium text-ink">total</span>
          <span className="text-end font-mono text-13 font-medium text-money num">{usd(t.monthCents)}</span>
          <span className="text-end font-mono text-13 font-medium text-money num">{usd(t.projectedCents)}</span>
          <span />
        </li>
      </ul>
    </Panel>
  );
}

function Machine({ box, now }: { box: OpsBox; now: number }) {
  const gauges: Array<[string, number | null, number | null]> = [["cpu", box.cpu, null], ["memory", box.mem, box.memTotalBytes], ["disk", box.disk, box.diskTotalBytes]];
  return (
    <li className="px-2.5 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-13 text-ink">{box.name}</span>
        <span className="truncate text-12 text-ink-3">{box.at ? `sampled ${ago(box.at, now)}` : "no sample yet"}</span>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-4 max-sm:gap-3">
        {gauges.map(([label, value, total]) => {
          const level = gaugeLevel(value);
          return (
            <div key={label} className="min-w-0" title={total ? `of ${size(total)}` : undefined}>
              <div className="flex items-baseline justify-between gap-2 text-12">
                <span className="truncate text-ink-3">{label}</span>
                <span className="font-mono text-ink-2 num">{value === null ? "-" : `${Math.round(value)}%`}<span className="sr-only">{level === "ok" || level === "unknown" ? "" : `, ${level}`}</span></span>
              </div>
              <div className="mt-1.5"><Bar share={(value ?? 0) / 100} level={level} /></div>
            </div>
          );
        })}
      </div>
      <p className="mt-2.5 truncate text-12 text-ink-3">
        load <span className="font-mono text-ink-2 num">{box.load ? box.load.map((v) => v.toFixed(2)).join(" ") : "-"}</span>{box.cores ? ` on ${box.cores} cores` : ""}
        {box.net && <> · now <span className="font-mono text-ink-2 num">{perSecond(box.net.inRate)}</span> in, <span className="font-mono text-ink-2 num">{perSecond(box.net.outRate)}</span> out</>}
      </p>
    </li>
  );
}

function Machines({ boxes, now }: { boxes: OpsBox[]; now: number }) {
  return (
    <Panel id="ops-machines" title="machines" meta={`${n(boxes.length)} ${boxes.length === 1 ? "box" : "boxes"}`}>
      {boxes.length ? <ul>{boxes.map((box) => <Machine key={box.name} box={box} now={now} />)}</ul> : <Empty>no machine has reported yet.</Empty>}
    </Panel>
  );
}

const SERVICE_COLS = "grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_64px] max-sm:grid-cols-[minmax(0,1fr)_64px]";
function Services({ checks, rules, now }: { checks: OpsCheck[]; rules: OpsRule[]; now: number }) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const sorted = [...checks].sort((a, b) => RANK[a.level] - RANK[b.level]);
  const ok = checks.filter((check) => check.level === "ok").length;
  const firing = rules.filter((rule) => rule.state === "firing").length;
  const order = { firing: 0, pending: 1, ok: 2 } as const;
  return (
    <Panel id="ops-services" title="services" meta={`${n(ok)} of ${n(checks.length)} ok`} foot={rules.length > 0 && (
      <div className="px-1 pt-1.5">
        <button type="button" aria-expanded={rulesOpen} aria-controls="ops-rules" onClick={() => setRulesOpen((v) => !v)} className="hover-ghost flex min-h-11 w-full items-center justify-between gap-3 rounded-[16px] px-2 text-start text-13 text-ink-2">
          <span>alert rules</span><span className="flex items-center gap-2"><span className="t-meta">{n(rules.length)} rules, {n(firing)} firing</span><Chevron open={rulesOpen} /></span>
        </button>
        <Reveal open={rulesOpen} id="ops-rules">
          <ul className="pb-1 pt-1">
            {[...rules].sort((a, b) => order[a.state] - order[b.state]).map((rule) => (
              <li key={rule.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate text-13 text-ink">{rule.label}</span>
                  <span className="block truncate text-12 text-ink-3">{rule.threshold}{rule.value ? ` · now ${rule.value}` : ""} · {rule.state !== "ok" && rule.since ? `since ${ago(rule.since, now)}` : rule.lastFiredAt ? `last fired ${ago(rule.lastFiredAt, now)}` : "never fired"}</span>
                </span>
                <Level level={RULE_LEVEL[rule.state]} word={rule.state} />
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    )}>
      {sorted.length ? (
        <>
          <div className={cx("grid gap-3 px-2.5 pb-1 pt-1 t-meta", SERVICE_COLS)}><span>check</span><span className="max-sm:hidden">now</span><span className="text-end">latency</span></div>
          <ul>
            {sorted.map((check) => {
              const loud = check.level === "bad" || check.level === "watch";
              return (
                <li key={check.id} className={cx("grid items-baseline gap-x-3 rounded-[12px] px-2.5 py-1.5", SERVICE_COLS)} title={check.detail ?? undefined}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Dot level={check.level} />
                    <span className="truncate text-13 text-ink">{check.name}</span>
                    <span className="sr-only">, {check.level}</span>
                  </span>
                  <span className="truncate text-12 text-ink-3 max-sm:hidden">{check.value}</span>
                  <span className="text-end font-mono text-12 text-ink-3 num">{check.latencyMs !== null ? `${n(check.latencyMs)} ms` : "-"}</span>
                  <span className={cx("col-span-full truncate ps-[15px] text-12 text-ink-3", !loud && !check.detail && "sm:hidden")}>{loud && <span className={check.level === "bad" ? "text-bad" : "text-warn"}>{check.level}, </span>}<span className="sm:hidden">{check.value}{check.detail ? ", " : ""}</span>{check.detail}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : <Empty>no checks have run yet.</Empty>}
    </Panel>
  );
}

function People({ list }: { list: OpsAnswer["abuse"] }) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, 5);
  return (
    <Panel id="ops-people" title="people to look at" meta={list.length ? "by score" : undefined}>
      {shown.length ? (
        <ul>
          {shown.map((s) => (
            <PersonRow key={s.key} accountId={s.accountId}>
              <Person accountId={s.accountId} email={s.email} fallback={s.ip ?? s.key} sub={<span title={s.signals.map((sig) => `${sig.label}${sig.ratio !== null ? ` ${Math.round(sig.ratio * 10) / 10}x` : ""}`).join(", ")}>{s.why}</span>} />
              <span className="text-end font-mono text-13 text-ink num" title="score">{Math.round(s.score)}</span>
            </PersonRow>
          ))}
        </ul>
      ) : <Empty>nobody stands out right now.</Empty>}
      {list.length > 5 && <button type="button" onClick={() => setAll((v) => !v)} className="text-link mx-auto block h-9 px-3 text-12">{all ? "show fewer" : `show all ${n(list.length)}`}</button>}
    </Panel>
  );
}

const EVERY_MS = { "5m": 300_000, "1h": 3_600_000 } as const;
function Sources({ sources, now }: { sources: OpsSource[]; now: number }) {
  const failing = sources.filter((s) => s.configured && !s.ok).length;
  const ready = sources.filter((s) => s.configured).length;
  return (
    <Fold id="ops-sources" title="where these numbers come from" meta={`${n(ready)} of ${n(sources.length)} set up${failing ? `, ${n(failing)} failing` : ""}`} defaultOpen={failing > 0}>
      <ul className="grid grid-cols-3 gap-x-6 gap-y-2 rounded-[18px] bg-pop p-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
        {sources.map((s) => {
          const stale = s.at !== null && now - s.at > EVERY_MS[s.every] * 3;
          const level: OpsLevel = !s.configured ? "unknown" : !s.ok ? "bad" : stale || s.at === null ? "watch" : "ok";
          return (
            <li key={s.id} className="min-w-0 text-12">
              <span className="flex items-center gap-2"><Dot level={level} /><span className="text-ink-2">{s.label}</span><span className="text-ink-4">every {s.every.replace("m", " min").replace("h", " h")}</span></span>
              <span className="block truncate ps-[15px] text-ink-3">
                {!s.configured ? "not set up" : `${s.at ? `collected ${ago(s.at, now)}` : "never collected"}${stale ? ", late" : ""}`}
                {s.error && <span className="text-bad">, {s.error}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </Fold>
  );
}

function Collect({ onDone }: { onDone(): void }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const answer = await adminCall<{ ran: string[] }>("/ops/collect", { body: {} });
      toast(answer.ran.length ? `collected ${answer.ran.join(", ")}.` : "nothing to collect right now.");
      onDone();
    } catch (error) {
      toast((error as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => void run()}>
      <m.span className="inline-flex" aria-hidden animate={busy ? { rotate: 360 } : { rotate: 0 }} transition={busy ? { repeat: Infinity, duration: 0.9, ease: "linear" } : { duration: 0 }}><RefreshCw size={14} strokeWidth={1.75} /></m.span>
      {busy ? "collecting" : "collect now"}
    </Button>
  );
}

function Tile({ id, title, big, money, sub, bar }: { id: string; title: string; big: ReactNode; money?: boolean; sub: ReactNode; bar?: { meter: OpsMeter } | null }) {
  const limit = bar?.meter.limit ?? null;
  return (
    <Panel id={id} title={title}>
      <div className="flex min-h-[84px] flex-col justify-center gap-1 px-2 py-1.5">
        <span className={cx("font-mono text-[22px] font-medium leading-8 tracking-[-0.04em] num", money ? "text-money" : "text-ink")}>{big}</span>
        {bar && limit ? <Bar share={bar.meter.used / limit} level={bar.meter.level} tick={bar.meter.projected !== null ? bar.meter.projected / limit : null} /> : null}
        <span className="text-12 leading-[1.45] text-ink-3">{sub}</span>
      </div>
    </Panel>
  );
}
/** each mail provider as this service counted it: today and the month against its caps, the emails it passed to the other
 *  provider and its last refusal (auth/mail-router.ts) */
function MailTile({ mail, brevo, now }: { mail: OpsSpend["mail"]; brevo: OpsSpend["brevo"]; now: number }) {
  const providers = mail?.providers.filter((p) => p.configured) ?? [];
  return (
    <Panel id="ops-tile-emails" title="emails">
      <div className="flex min-h-[84px] flex-col justify-center gap-4 px-2 py-1.5">
        {providers.length ? providers.map((p) => (
          <div key={p.provider} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="text-13 text-ink">{p.provider}</span>
              <span className="truncate text-12 text-ink-3">{p.sends}</span>
            </div>
            <Meter label="today" meter={p.daily} format={n} />
            <Meter label="this month" meter={p.monthly} format={n} />
            <span className="text-12 leading-[1.45] text-ink-3">
              <span className={p.fallbacks.today ? "text-warn" : undefined}>{n(p.fallbacks.month)} passed to the other provider this month{p.fallbacks.today ? `, ${n(p.fallbacks.today)} today` : ""}</span>
              {" · "}{p.lastError ? <>last error {p.lastError.reason}, {ago(p.lastError.at, now)}</> : "no errors"}
            </span>
          </div>
        )) : <span className="text-12 leading-[1.45] text-ink-3">{brevo ? <>brevo: {n(brevo.monthly.used)} this month · {n(brevo.today.sent)} today</> : "not counted yet"}</span>}
      </div>
    </Panel>
  );
}
const levelOf = (used: number, limit: number | null, projected: number | null): OpsLevel => !limit ? "unknown" : used >= limit ? "bad" : used >= limit * 0.8 || (projected ?? 0) >= limit ? "watch" : "ok";

/** the month's usage and what it costs, one tile each: madani cloud, emails, each node's traffic, cloudflare */
function Glance({ data, relays }: { data: OpsAnswer | null; relays: OpsRelayCard[] | null }) {
  const spend = data?.spend, box = spend?.instabox.totals, brevo = spend?.brevo ?? null, workers = spend?.workers ?? null;
  const workersLine = spend?.lines.find((line) => line.provider === "workers");
  const links = (relays ?? []).filter((card) => card.id !== "cloudflare");
  const cfRelay = (relays ?? []).find((card) => card.id === "cloudflare")?.stats?.cost ?? null;
  const dash = <span className="text-ink-4">-</span>;
  return (
    <div className="grid grid-cols-5 gap-4 max-xl:grid-cols-3 max-md:grid-cols-2 max-sm:grid-cols-1">
      <Tile id="ops-tile-cloud" title="madani cloud" big={box ? `${n(Math.round(box.awakeHours))} h` : dash}
        sub={box ? <>machine-hours this month · instabox <span className="text-money">{usd(box.costCents)}</span>, <span className="text-money">{usd(box.projectedCents)}</span> at this pace</> : "not reported yet"} />
      <MailTile mail={spend?.mail ?? null} brevo={brevo} now={data?.now ?? 0} />
      {links.map((card) => {
        const stats = card.stats, month = stats ? monthOut(stats) : null;
        return (
          <Tile key={card.id} id={`ops-tile-${card.id}`} title={`${card.label.replace(/ relay.*/, "")} traffic`} big={month ? size(month.used) : dash}
            bar={month ? { meter: { used: month.used, limit: month.allowance, projected: month.projected, level: levelOf(month.used, month.allowance, month.projected) } } : null}
            sub={stats && month ? <>out this month{month.allowance ? ` of ${size(month.allowance)}` : ""}{month.projected !== null ? ` · ${size(month.projected)} at this pace` : ""} · now {mbit(stats.box?.bytesPerSecOut ?? stats.now.bytesPerSecOut)}</> : card.error ?? "not reported yet"} />
        );
      })}
      <Tile id="ops-tile-cloudflare" title="cloudflare" money={!!(workersLine || cfRelay)} big={workersLine || cfRelay ? usd((workersLine?.projectedCents ?? 0) + (cfRelay?.projectedCents ?? 0)) : dash}
        sub={workersLine || cfRelay ? <>our workers at this pace, est.{workers ? ` · ${short(workers.requests.used)} of ${short(workers.requests.limit ?? 0)} requests` : ""}{cfRelay ? ` · relay ${usd(cfRelay.projectedCents)}` : ""}</> : "not reported yet"} />
    </div>
  );
}

/** everything that costs money or can go down, from what the collectors last stored */
/** where each part of this long page is, so relays, emails and the abuse list are one tap from the top */
const JUMPS: Array<[string, string]> = [["ops-sharing", "usage sharing"], ["ops-relays-summary", "relays"], ["ops-accounts", "top accounts"], ["ops-tile-emails", "emails"], ["ops-spend", "spend"],
  ["ops-people", "people to look at"], ["ops-machines", "machines"], ["ops-services", "services"]];

export function OpsPage() {
  const { data, error, loading, reload } = useAdmin<OpsAnswer>("/ops", 60_000);
  const now = useNow(30_000);
  const relays = useRelays();
  return (
    <>
      <AdminHeader title="ops"
        sub={data ? <span className="inline-flex flex-wrap items-center gap-2">{data.month}, {percent(data.elapsed)} of the month gone · updated {ago(data.now, now)}{data.fixture && <span className="tag !h-[22px] !px-2">sample data</span>}</span> : "spend, machines, services and people to look at"}
        action={<Collect onDone={reload} />} />
      <nav aria-label="on this page" className="mb-4 flex flex-wrap gap-1.5">
        {JUMPS.map(([id, label]) => <Link key={id} to={`/admin/ops#${id}`} className="hover-chip inline-flex h-8 items-center rounded-full bg-card px-3 text-13 text-ink-2">{label}</Link>)}
      </nav>
      <div className="mb-4 flex flex-col gap-4">
        <OpsSharing />
        <RelaySummary data={relays.data} error={relays.error} />
        <TopAccounts />
        <Glance data={data} relays={relays.data?.relays ?? null} />
      </div>
      <Relays data={relays.data} error={relays.error} setData={relays.setData} />
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading rows={8} />}
      {data && (
        <div className="flex flex-col gap-4">
          <Summary data={data} items={attention(data)} />
          <div className="grid grid-cols-2 items-start gap-4 max-lg:grid-cols-1">
            <div className="flex min-w-0 flex-col gap-4">
              <Spend spend={data.spend} sources={data.sources} now={now} />
              <People list={data.abuse} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <Machines boxes={data.health.boxes} now={now} />
              <Services checks={data.health.checks} rules={data.alerts} now={now} />
            </div>
          </div>
          <Sources sources={data.sources} now={now} />
        </div>
      )}
    </>
  );
}
