import { useId, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, Check, Download } from "@/icons";
import { AnimatePresence, EASE_OUT, m, Pill, SPRING, usePill } from "../ui/motion";
import { Button, cx, Segmented } from "../ui/kit";
import { Link } from "../lib/router";
import { PersonLink } from "./sheet";
import { useAdmin } from "./api";
import { Avatar, percent, personName, usd } from "./kit";
import { AdminHeader, Failed, Loading, n, Pager, SearchBox } from "./ui";
import { DataSwitch } from "./DataSwitch";
import { Bar, Empty, Panel, size } from "./Ops";
import type { OpsAccountFlag, OpsAccountRow, OpsAccountsAnswer, OpsAccountsRange, OpsFairStage, OpsLevel } from "./ops-types";

const STAGE: Record<OpsFairStage, { word: string; level: OpsLevel }> = { full: { word: "full speed", level: "ok" }, slowing: { word: "slowing", level: "watch" }, chat: { word: "chat only", level: "bad" } };
const FLAG: Record<OpsAccountFlag["kind"], { word: string; cls: string; rank: number }> = {
  abuse: { word: "possible abuse", cls: "bg-wash-pink text-ink", rank: 0 },
  throttled: { word: "throttled", cls: "bg-wash-lemon text-ink", rank: 1 },
  check: { word: "needs checking", cls: "bg-wash-sky text-ink", rank: 2 },
};
/** a step or flag this page doesn't know yet (a newer service) reads as its own word, never as a crash */
export const stageOf = (stage: string) => STAGE[stage as OpsFairStage] ?? { word: stage || "not reported yet", level: "unknown" as OpsLevel };
export const flagOf = (kind: string) => FLAG[kind as OpsAccountFlag["kind"]] ?? { word: kind || "flagged", cls: "bg-wash-sky text-ink", rank: 3 };

type SortKey = "relay" | "share" | "awake" | "cost" | "emails" | "codes" | "flags";
const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "relay", label: "relay" }, { key: "share", label: "share" }, { key: "awake", label: "awake" }, { key: "cost", label: "cost" },
  { key: "emails", label: "emails" }, { key: "codes", label: "codes" }, { key: "flags", label: "flags" },
];
const valueOf = (row: OpsAccountRow, key: SortKey) => {
  switch (key) {
    case "relay": return row.relay?.monthBytes ?? -1;
    case "share": return row.relay?.share ?? -1;
    case "awake": return row.cloud?.awakeHours ?? -1;
    case "cost": return row.cloud?.costCents ?? -1;
    case "emails": return row.emails ?? -1;
    case "codes": return row.codes ?? -1;
    case "flags": return (row.flags ?? []).reduce((sum, flag) => sum + (4 - flagOf(flag.kind).rank) * 10, 0);
  }
};
const COLS = "grid grid-cols-[minmax(180px,1.6fr)_minmax(140px,1fr)_60px_64px_72px_60px_56px_minmax(128px,1.1fr)] items-center gap-3";
const TOP = 20, PAGE = 50;

function Flags({ flags = [] }: { flags?: OpsAccountFlag[] }) {
  if (!flags.length) return <span className="block text-end text-12 text-ink-4">-</span>;
  const kinds = [...new Set(flags.map((flag) => flag.kind))].sort((a, b) => flagOf(a).rank - flagOf(b).rank);
  return (
    <span className="flex flex-wrap justify-end gap-1" title={flags.map((flag) => flag.why).join("\n")}>
      {kinds.map((kind) => <span key={kind} className={cx("inline-flex h-[22px] items-center whitespace-nowrap rounded-full px-2 text-12", flagOf(kind).cls)}>{flagOf(kind).word}</span>)}
      <span className="sr-only">: {flags.map((flag) => flag.why).join("; ")}</span>
    </span>
  );
}

function RelayCell({ relay, floorAt, fullSpeed }: { relay: OpsAccountRow["relay"]; floorAt: number; fullSpeed: number }) {
  if (!relay) return <span className="text-12 text-ink-4">-</span>;
  const stage = stageOf(relay.stage);
  return (
    <span className="block">
      <span className="flex items-baseline justify-end gap-1.5"><span className={cx("text-12", stage.level === "ok" ? "text-ink-3" : "text-ink-2")}>{stage.word}</span><span className="font-mono text-ink num">{size(relay.monthBytes)}</span></span>
      <span className="mt-1 block"><Bar share={relay.monthBytes / floorAt} level={stage.level} tick={fullSpeed / floorAt} /></span>
    </span>
  );
}

const num = (value: number | null, render: (v: number) => ReactNode = n) => value === null ? <span className="text-ink-4">-</span> : render(value);

type Sort = { key: SortKey; desc: boolean };
type FlagKind = OpsAccountFlag["kind"];
const sortRows = (rows: OpsAccountRow[], sort: Sort) => [...rows].sort((a, b) => (valueOf(b, sort.key) - valueOf(a, sort.key)) * (sort.desc ? 1 : -1));
const hasFlag = (row: OpsAccountRow, kinds: ReadonlySet<FlagKind>) => !kinds.size || (row.flags ?? []).some((flag) => kinds.has(flag.kind));
const nameOf = (row: OpsAccountRow) => row.accountId ? personName(row.accountId, row.email) : `account ${(row.ref ?? "").slice(0, 8)}`;
const nextSort = (s: Sort, key: SortKey): Sort => s.key === key ? { key, desc: !s.desc } : { key, desc: true };

const SORT_CHIPS: Array<{ key: SortKey; label: string }> = [
  { key: "relay", label: "relay gb" }, { key: "share", label: "relay share" }, { key: "cost", label: "cloud cost" }, { key: "awake", label: "cloud hours" }, { key: "emails", label: "emails" }, { key: "codes", label: "codes" },
];
const DOT: Record<FlagKind, string> = { abuse: "bg-bad", throttled: "bg-warn", check: "bg-accent" };
/** each flag's account count, for the filter toggles */
const flagCounts = (rows: OpsAccountRow[]) => Object.fromEntries((Object.keys(FLAG) as FlagKind[]).map((kind) => [kind, rows.filter((row) => row.flags?.some((flag) => flag.kind === kind)).length])) as Record<FlagKind, number>;

/** sort by one measure (a sliding pill, the direction said in words) and show only some flags (toggles with their counts) */
function Chips({ sort, onSort, flags, onFlags, counts }: { sort?: Sort; onSort?(s: Sort): void; flags: ReadonlySet<FlagKind>; onFlags(next: Set<FlagKind>): void; counts: Record<FlagKind, number> }) {
  const flip = (kind: FlagKind) => { const next = new Set(flags); if (next.has(kind)) next.delete(kind); else next.add(kind); onFlags(next); };
  const pill = usePill(), sortLabel = useId(), onlyLabel = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      {sort && onSort && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          <span id={sortLabel} className="text-12 text-ink-3">sort by</span>
          <div role="radiogroup" aria-labelledby={sortLabel} className="scroll-x inline-flex max-w-full shrink-0 rounded-full bg-card-2 p-1">
            {SORT_CHIPS.map((chip) => {
              const on = sort.key === chip.key;
              return (
                <button key={chip.key} type="button" role="radio" aria-checked={on} onClick={() => onSort(nextSort(sort, chip.key))}
                  className={cx("relative inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full pe-2.5 ps-3 text-13 font-medium transition-colors duration-150 ease-out", on ? "text-ink" : "text-ink-3 hover-link")}>
                  {on && <Pill id={pill} />}
                  <span className="relative">{chip.label}</span>
                  <span aria-hidden className={cx("relative grid size-3.5 place-items-center transition-opacity duration-150 ease-out", on ? "opacity-100" : "opacity-0")}>
                    <m.span className="grid place-items-center" initial={false} animate={{ rotate: on && !sort.desc ? 180 : 0 }} transition={SPRING}><ArrowDown size={12} strokeWidth={2} /></m.span>
                  </span>
                </button>
              );
            })}
          </div>
          <button type="button" onClick={() => onSort({ ...sort, desc: !sort.desc })} aria-label={`order: ${sort.desc ? "most first" : "least first"}. switch to ${sort.desc ? "least" : "most"} first`}
            className="press hover-ghost inline-flex h-8 w-[92px] shrink-0 items-center justify-center rounded-full text-12 text-ink-2">
            {sort.desc ? "most first" : "least first"}
          </button>
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span id={onlyLabel} className="text-12 text-ink-3">show only</span>
        <div role="group" aria-labelledby={onlyLabel} className="flex flex-wrap gap-1.5">
          {(Object.keys(FLAG) as FlagKind[]).map((kind) => {
            const on = flags.has(kind);
            return (
              <button key={kind} type="button" aria-pressed={on} onClick={() => flip(kind)}
                className={cx("press inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full ps-2.5 pe-3 text-13 transition-colors duration-150 ease-out", on ? cx(FLAG[kind].cls, "font-medium") : "hover-chip bg-card text-ink-2")}>
                <span aria-hidden className="grid size-3.5 place-items-center">{on ? <Check size={13} strokeWidth={2.25} /> : <span className={cx("size-2 rounded-full", DOT[kind])} />}</span>
                {FLAG[kind].word}
                <span className={cx("font-mono text-12 num", on ? "text-ink-2" : "text-ink-4")}>{n(counts[kind])}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** the accounts as a table; each header sorts, each row opens the person */
function AccountsTable({ rows, sort, onSort, fairUse, label, empty }: { rows: OpsAccountRow[]; sort: Sort; onSort(s: Sort): void; fairUse: OpsAccountsAnswer["fairUse"]; label: string; empty: string }) {
  const { fullSpeedBytes: fullSpeed, floorAtBytes: floorAt } = fairUse;
  return (
    <div role="region" className="scroll-x" tabIndex={0} aria-label={`${label}, scrolls sideways on a small screen`}>
      <div role="table" aria-label={label} className="min-w-[900px]">
        <div role="row" className={cx(COLS, "px-2.5 pb-1 pt-1 t-meta")}>
          <span role="columnheader">account</span>
          {COLUMNS.map((col) => {
            const active = sort.key === col.key;
            return (
              <span key={col.key} role="columnheader" aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"} className="text-end">
                <button type="button" onClick={() => onSort(nextSort(sort, col.key))} className={cx("hover-ghost -mx-1.5 inline-flex h-7 items-center gap-1 rounded-full px-1.5", active ? "text-ink-2" : "text-ink-3")}>
                  {col.label}<span aria-hidden className={cx("text-[10px]", !active && "opacity-0")}>{sort.desc ? "▼" : "▲"}</span>
                </button>
              </span>
            );
          })}
        </div>
        <AnimatePresence initial={false} mode="popLayout">
        {rows.length ? rows.map((row) => {
          const name = nameOf(row);
          return (
            <m.div key={row.accountId ?? row.ref ?? name} role="row" className={cx(COLS, "relative rounded-[12px] px-2.5 py-2", row.accountId && "hover-row")}
              layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.12, ease: EASE_OUT } }}
              transition={{ layout: { type: "spring", visualDuration: 0.26, bounce: 0 }, opacity: { duration: 0.18, ease: EASE_OUT } }}>
              <span role="rowheader" className="flex min-w-0 items-center gap-2.5">
                {row.accountId && <Avatar seed={row.accountId} size={20} customer account={{ id: row.accountId }} />}
                <span className="min-w-0">
                  {row.accountId
                    ? <PersonLink id={row.accountId} className="block truncate text-13 text-ink after:absolute after:inset-0 after:rounded-[12px]">{name}</PersonLink>
                    : <span className="block truncate text-13 text-ink">{name}</span>}
                  {row.plan && row.plan !== "none" && <span className="block truncate text-12 text-ink-3">{row.plan}</span>}
                </span>
              </span>
              <span role="cell" className="text-13"><RelayCell relay={row.relay} floorAt={floorAt} fullSpeed={fullSpeed} /></span>
              <span role="cell" className="text-end font-mono text-13 text-ink-2 num">{row.relay ? percent(row.relay.share) : <span className="text-ink-4">-</span>}</span>
              <span role="cell" className="text-end font-mono text-13 text-ink-2 num">{row.cloud ? `${n(Math.round(row.cloud.awakeHours))} h` : <span className="text-ink-4">-</span>}</span>
              <span role="cell" className={cx("text-end font-mono text-13 num", row.cloud?.costCents ? "text-money" : "text-ink-4")}>{row.cloud ? usd(row.cloud.costCents) : "-"}</span>
              <span role="cell" className="text-end font-mono text-13 text-ink-2 num">{num(row.emails)}</span>
              <span role="cell" className="text-end font-mono text-13 text-ink-2 num">{num(row.codes)}</span>
              <span role="cell" className="relative z-[1]"><Flags flags={row.flags} /></span>
            </m.div>
          );
        }) : <m.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><Empty>{empty}</Empty></m.div>}
        </AnimatePresence>
      </div>
    </div>
  );
}

const notReported = (data: OpsAccountsAnswer) => [!data.reported.relay && (data.range === "month" ? "relay" : "relay (kept for this month only)"), !data.reported.cloud && "madani cloud", !data.reported.mail && "emails"].filter(Boolean);

/** who uses the most this month: relay traffic on the fair use curve, madani cloud time and cost, emails sent to them */
export function TopAccounts() {
  const { data, error } = useAdmin<OpsAccountsAnswer>("/ops/accounts", 60_000);
  const me = useAdmin<{ live?: string | null }>("/me");
  const [sort, setSort] = useState<Sort>({ key: "relay", desc: true });
  const [flags, setFlags] = useState<Set<FlagKind>>(() => new Set());
  const rows = data ? sortRows(data.rows.filter((row) => hasFlag(row, flags)), sort) : [];
  const flagged = data ? data.rows.filter((row) => row.flags?.length).length : 0;
  const notYet = data ? notReported(data) : [];
  return (
    <Panel id="ops-accounts" title={`top accounts this month${data && data.data !== "own" ? `, ${data.data}` : ""}`}
      meta={<span className="inline-flex flex-wrap items-center gap-3">
        {data && <span>{n(data.total)} {data.total === 1 ? "account" : "accounts"} · {n(flagged)} flagged · fair use {size(data.fairUse.fullSpeedBytes)} to {size(data.fairUse.floorAtBytes)}</span>}
        {me.data?.live && <DataSwitch live={me.data.live} />}
      </span>}>
      {error && !data && <Empty>accounts can't be read right now: {error.message}</Empty>}
      {!data && !error && <div className="h-[360px] animate-pulse rounded-[12px] bg-card" />}
      {data && <>
        <div className="px-1.5 pb-2 pt-1"><Chips sort={sort} onSort={setSort} flags={flags} onFlags={setFlags} counts={flagCounts(data.rows)} /></div>
        <AccountsTable rows={rows.slice(0, TOP)} sort={sort} onSort={setSort} fairUse={data.fairUse} label="top accounts this month"
          empty={flags.size ? "no account has those flags this month." : "nobody has used the relay, a madani cloud or an email this month."} />
        <div className="flex flex-wrap items-center justify-between gap-3 px-2.5 pb-1.5 pt-2">
          <span className="text-12 text-ink-3">{notYet.length ? `${notYet.join(", ")}: not reported yet.` : rows.length > TOP ? `the top ${TOP} of ${n(rows.length)}.` : ""}</span>
          <Link to="/admin/ops/accounts" className="text-link text-13">see all accounts</Link>
        </div>
      </>}
    </Panel>
  );
}

const RANGES: Array<{ value: OpsAccountsRange; label: string }> = [{ value: "month", label: "this month" }, { value: "last-month", label: "last month" }, { value: "7d", label: "last 7 days" }];
const csvCell = (value: string | number | null) => { const text = value === null ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
export function accountsCsv(rows: OpsAccountRow[]) {
  const head = ["email", "account id", "plan", "relay gb", "relay step", "relay share %", "cloud hours", "cloud cost usd", "emails", "sign-in codes", "flags"];
  const lines = rows.map((row) => [row.email, row.accountId ?? row.ref, row.plan, row.relay ? Math.round(row.relay.monthBytes / 1e7) / 100 : null, row.relay ? stageOf(row.relay.stage).word : null,
    row.relay ? Math.round(row.relay.share * 1000) / 10 : null, row.cloud?.awakeHours ?? null, row.cloud ? (row.cloud.costCents / 100).toFixed(2) : null, row.emails, row.codes,
    (row.flags ?? []).map((flag) => `${flagOf(flag.kind).word}: ${flag.why}`).join("; ") || null].map(csvCell).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function NumberFilter({ label, unit, value, onChange }: { label: string; unit: string; value: string; onChange(v: string): void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="whitespace-nowrap text-13 text-ink-2">{label}</label>
      <input id={id} inputMode="decimal" autoComplete="off" value={value} placeholder="any" onChange={(e) => onChange(e.target.value)} className="field !h-9 !w-[84px] !px-3 font-mono !text-13" />
      <span className="text-13 text-ink-3">{unit}</span>
    </div>
  );
}

/** every account that used the relay, a madani cloud or an email in the range: filter, search, sort, export */
export function AccountsUsagePage() {
  const [range, setRange] = useState<OpsAccountsRange>("month");
  const { data, error, loading, reload } = useAdmin<OpsAccountsAnswer>(`/ops/accounts?all=1&range=${range}`, 60_000);
  const me = useAdmin<{ live?: string | null }>("/me");
  const [sort, setSort] = useState<Sort>({ key: "relay", desc: true });
  const [flags, setFlags] = useState<Set<FlagKind>>(() => new Set());
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState("");
  const [minGb, setMinGb] = useState("");
  const [minCost, setMinCost] = useState("");
  const [offset, setOffset] = useState(0);
  const planId = useId();
  const plans = useMemo(() => [...new Set((data?.rows ?? []).flatMap((row) => row.plan ? [row.plan] : []))].sort(), [data]);
  const gb = Number(minGb), cost = Number(minCost), needle = q.trim().toLowerCase();
  const rows = useMemo(() => !data ? [] : sortRows(data.rows.filter((row) => hasFlag(row, flags)
    && (!needle || (row.email ?? "").toLowerCase().includes(needle) || (row.accountId ?? "").toLowerCase().includes(needle))
    && (!plan || row.plan === plan)
    && (!minGb.trim() || !Number.isFinite(gb) || (row.relay?.monthBytes ?? 0) >= gb * 1e9)
    && (!minCost.trim() || !Number.isFinite(cost) || (row.cloud?.costCents ?? 0) >= cost * 100)), sort), [data, flags, needle, plan, minGb, gb, minCost, cost, sort]);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); };
  const notYet = data ? notReported(data) : [];
  const rangeLabel = RANGES.find((r) => r.value === range)!.label;
  return (
    <>
      <AdminHeader title="accounts usage"
        sub={data ? <>{data.from} to {data.to}{data.data !== "own" ? ` · ${data.data}` : ""} · {n(rows.length)} of {n(data.total)} {data.total === 1 ? "account" : "accounts"}</> : "every account's relay, madani cloud and email use"}
        action={<span className="flex flex-wrap items-center gap-2">
          {me.data?.live && <DataSwitch live={me.data.live} />}
          <Button size="sm" disabled={!rows.length} onClick={() => download(`madani-accounts-${data?.from ?? range}-${data?.to ?? ""}.csv`, accountsCsv(rows))}><Download size={15} strokeWidth={1.75} aria-hidden />export csv</Button>
        </span>} />
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<OpsAccountsRange> label="range" value={range} options={RANGES} onChange={reset(setRange)} />
          <SearchBox value={q} onChange={reset(setQ)} label="search accounts by email" placeholder="search by email" />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {data && <Chips flags={flags} onFlags={reset(setFlags)} counts={flagCounts(data.rows)} />}
          {plans.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor={planId} className="text-13 text-ink-2">plan</label>
              <select id={planId} value={plan} onChange={(e) => reset(setPlan)(e.target.value)} className="field !h-9 !w-[140px] !text-13">
                <option value="">any</option>
                {plans.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}
          <NumberFilter label="relay at least" unit="gb" value={minGb} onChange={reset(setMinGb)} />
          <NumberFilter label="cloud cost at least" unit="$" value={minCost} onChange={reset(setMinCost)} />
        </div>
      </div>
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading rows={10} />}
      {data && (
        <section aria-label="accounts" className="rounded-[24px] bg-card p-2">
          <div className="rounded-[18px] bg-pop p-1.5">
            <AccountsTable rows={rows.slice(offset, offset + PAGE)} sort={sort} onSort={reset(setSort)} fairUse={data.fairUse} label={`accounts, ${rangeLabel}`}
              empty={data.rows.length ? "no account matches these filters." : `nobody used the relay, a madani cloud or an email ${rangeLabel === "this month" ? "this month" : `in the ${rangeLabel}`}.`} />
          </div>
          {notYet.length > 0 && <p className="px-2.5 pb-1 pt-2 text-12 text-ink-3">{notYet.join(", ")}: not reported yet.</p>}
        </section>
      )}
      {data && <Pager offset={offset} limit={PAGE} total={rows.length} onChange={setOffset} />}
    </>
  );
}
