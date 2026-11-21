import { useEffect, useId, useState } from "react";
import { ago } from "../lib/format";
import { toast } from "../lib/toast";
import { Button, cx } from "../ui/kit";
import { adminCall, useAdmin } from "./api";
import { AdminHeader, Failed, Loading, Section, n, stamp } from "./ui";

type Status = "new" | "looking" | "fixed" | "wont-fix";
export interface BugReportRow {
  id: string; installId: string; source: string; description: string; appVersion: string; platform: string; contact: string | null;
  status: Status; fixedIn: string | null; receivedAt: number; updatedAt: number; notifiedAt: number | null; images?: number; theme?: string;
}
interface ThemeRow { theme: string; count: number; open: number }
interface ListAnswer { reports: BugReportRow[]; counts: Record<Status, number>; themes?: ThemeRow[]; themesCapped?: boolean; next: number | null }

export const STATUSES: Array<{ id: Status; label: string; wash: string }> = [
  { id: "new", label: "new", wash: "bg-wash-pink" },
  { id: "looking", label: "looking", wash: "bg-wash-lilac" },
  { id: "fixed", label: "fixed", wash: "bg-wash-sky" },
  { id: "wont-fix", label: "won't fix", wash: "bg-card-2" },
];
const STATUS = Object.fromEntries(STATUSES.map((s) => [s.id, s])) as Record<Status, (typeof STATUSES)[number]>;
const CHIP = "inline-flex h-6 items-center rounded-full bg-card-2 px-2.5 text-12 text-ink-2";
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

function Diagnostics({ id }: { id: string }) {
  const { data, error, loading, reload } = useAdmin<{ report: { diagnostics: string } }>(`/bug-reports/${encodeURIComponent(id)}`);
  if (error) return <Failed error={error} retry={reload} />;
  if (!data && loading) return <Loading rows={3} />;
  return <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[14px] bg-card-2 px-3.5 py-3 font-mono text-12 leading-[18px] text-ink-2">{data?.report.diagnostics || "no diagnostics came with this report."}</pre>;
}

function Report({ report, onChange, selected, onSelect }: { report: BugReportRow; onChange(next: BugReportRow): void; selected: boolean; onSelect(on: boolean): void }) {
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState(false);
  const [version, setVersion] = useState(report.fixedIn ?? "");
  const [busy, setBusy] = useState<Status | null>(null);
  const versionId = useId();
  const long = report.description.length > 600 || report.description.split("\n").length > 8;
  const set = async (status: Status) => {
    const fixedIn = status === "fixed" ? version.trim() : "";
    if (fixedIn && !VERSION.test(fixedIn)) { toast("a version looks like 0.1.150.", "bad"); return; }
    setBusy(status);
    try {
      const answer = await adminCall<{ report: BugReportRow }>(`/bug-reports/${encodeURIComponent(report.id)}`, { method: "PATCH", body: { status, ...(fixedIn ? { fixedIn } : {}) } });
      onChange(answer.report);
      toast(`${report.id} marked ${STATUS[status].label}${answer.report.fixedIn ? ` in ${answer.report.fixedIn}` : ""}.`);
    } catch (err) { toast((err as Error).message, "bad"); } finally { setBusy(null); }
  };
  return (
    <li className={cx("rounded-[18px] px-4 py-3.5", selected ? "bg-wash-sky" : "bg-card")}>
      <div className="flex flex-wrap items-center gap-2 text-12 text-ink-3">
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`select ${report.id}`} className="size-4 cursor-pointer rounded-[4px]" />
        <span className={cx("inline-flex h-6 items-center rounded-full px-2.5 text-12 text-ink", STATUS[report.status].wash)}>
          {STATUS[report.status].label}{report.status === "fixed" && report.fixedIn ? ` in ${report.fixedIn}` : ""}
        </span>
        {report.theme && <span className={cx(CHIP, "text-ink")}>{report.theme}</span>}
        {report.source === "feedback" && <span className={cx(CHIP, "text-ink")}>feedback</span>}
        <span className="font-mono text-ink-2">{report.id}</span>
        <time dateTime={new Date(report.receivedAt).toISOString()} title={stamp(report.receivedAt)}>{ago(report.receivedAt)}</time>
      </div>
      <p className={cx("mt-2 max-w-[80ch] whitespace-pre-wrap break-words text-14 leading-[22px] text-ink", long && !whole && "line-clamp-6")}>{report.description}</p>
      {long && <button type="button" onClick={() => setWhole(!whole)} className="mt-1 text-13 text-ink-2 hover:text-ink">{whole ? "show less" : "show all"}</button>}
      {report.images ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {Array.from({ length: report.images }, (_, i) => {
            const src = `/v1/admin/bug-reports/${encodeURIComponent(report.id)}/images/${i}`;
            return (
              <a key={i} href={src} target="_blank" rel="noreferrer" className="block size-20 overflow-hidden rounded-[12px] bg-card-2 hover:opacity-90">
                <img src={src} alt={`image ${i + 1} of ${report.images} with ${report.id}`} loading="lazy" className="size-full object-cover" />
              </a>
            );
          })}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={CHIP}>v{report.appVersion} · {report.platform}</span>
        <span className={CHIP} title={report.installId}>install {report.installId.slice(0, 10)}</span>
        {report.contact ? <a href={`mailto:${report.contact}?subject=${encodeURIComponent(`your madani bot report ${report.id}`)}`} className="hover-chip inline-flex h-6 items-center rounded-full px-2.5 text-12 text-ink-2 hover:text-ink">reply to {report.contact}</a>
          : <span className={cx(CHIP, "text-ink-3")}>no address</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <div role="group" aria-label={`status of ${report.id}`} className="flex flex-wrap gap-1">
          {STATUSES.map((s) => (
            <button key={s.id} type="button" aria-pressed={report.status === s.id} disabled={busy !== null} onClick={() => void set(s.id)}
              className={cx("inline-flex h-8 items-center rounded-full px-3 text-13 hover-chip disabled:opacity-60", report.status === s.id ? "bg-ink text-bg" : "bg-card-2 text-ink-2")}>
              {busy === s.id ? "saving…" : s.label}
            </button>
          ))}
        </div>
        <label htmlFor={versionId} className="ml-2 text-12 text-ink-3">fixed in</label>
        <input id={versionId} inputMode="decimal" autoComplete="off" value={version} placeholder="0.1.150" onChange={(e) => setVersion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void set("fixed"); }} className="field !h-8 !w-[96px] !px-3 font-mono !text-13" />
        {report.source !== "feedback" && <Button size="sm" variant="ghost" className="ml-auto !h-8" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "hide diagnostics" : "diagnostics"}</Button>}
      </div>
      {open && report.source !== "feedback" && <Diagnostics id={report.id} />}
    </li>
  );
}

/** one status for every picked report; fixed takes the version it shipped in, and each reporter hears once they run it */
function BulkBar({ ids, onDone, onClear }: { ids: string[]; onDone(rows: BugReportRow[]): void; onClear(): void }) {
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState<Status | null>(null);
  const versionId = useId();
  const set = async (status: Status) => {
    const fixedIn = status === "fixed" ? version.trim() : "";
    if (fixedIn && !VERSION.test(fixedIn)) { toast("a version looks like 0.1.150.", "bad"); return; }
    setBusy(status);
    try {
      const answer = await adminCall<{ reports: BugReportRow[] }>("/bug-reports/bulk", { method: "POST", body: { ids, status, ...(fixedIn ? { fixedIn } : {}) } });
      onDone(answer.reports);
      toast(`${n(answer.reports.length)} reports marked ${STATUS[status].label}${fixedIn ? ` in ${fixedIn}` : ""}.`);
    } catch (err) { toast((err as Error).message, "bad"); } finally { setBusy(null); }
  };
  return (
    <div role="region" aria-label="change the picked reports" className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-1.5 rounded-[18px] bg-ink px-4 py-2.5 text-bg">
      <span className="mr-1 text-13">{n(ids.length)} picked</span>
      {STATUSES.map((s) => (
        <button key={s.id} type="button" disabled={busy !== null} onClick={() => void set(s.id)}
          className="inline-flex h-8 items-center rounded-full bg-bg/10 px-3 text-13 text-bg hover:bg-bg/20 disabled:opacity-60">{busy === s.id ? "saving…" : `mark ${s.label}`}</button>
      ))}
      <label htmlFor={versionId} className="ml-2 text-12 text-bg/70">fixed in</label>
      <input id={versionId} inputMode="decimal" autoComplete="off" value={version} placeholder="0.2.21" onChange={(e) => setVersion(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void set("fixed"); }} className="field !h-8 !w-[96px] !px-3 font-mono !text-13" />
      <button type="button" onClick={onClear} className="ml-auto text-13 text-bg/70 hover:text-bg">clear</button>
    </div>
  );
}

/** every @devs report and piece of feedback the apps sent: the person's words, the bot's summary, and the facts their app gathered, redacted on their computer */
export function BugReportsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [theme, setTheme] = useState<string | null>(null);
  const query = [status ? `status=${status}` : "", theme ? `theme=${encodeURIComponent(theme)}` : ""].filter(Boolean).join("&");
  const { data, error, loading, reload, setData } = useAdmin<ListAnswer>(`/bug-reports${query ? `?${query}` : ""}`, 60_000);
  const [more, setMore] = useState<{ reports: BugReportRow[]; next: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { setMore(null); }, [data]);
  useEffect(() => { setPicked(new Set()); }, [status, theme]);
  const reports = [...(data?.reports ?? []), ...(more?.reports ?? [])];
  const next = more ? more.next : data?.next ?? null;
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : null;
  const loadMore = async () => {
    if (next === null) return;
    setBusy(true);
    try {
      const page = await adminCall<ListAnswer>(`/bug-reports?before=${next}${query ? `&${query}` : ""}`);
      setMore((before) => ({ reports: [...(before?.reports ?? []), ...page.reports], next: page.next }));
    } catch (err) { toast((err as Error).message, "bad"); } finally { setBusy(false); }
  };
  const changed = (row: BugReportRow) => {
    const before = reports.find((item) => item.id === row.id)?.status;
    setMore((m) => m && { ...m, reports: m.reports.map((item) => item.id === row.id ? row : item) });
    setData((d) => d && { ...d, reports: d.reports.map((item) => item.id === row.id ? row : item),
      counts: before && before !== row.status ? { ...d.counts, [before]: d.counts[before] - 1, [row.status]: d.counts[row.status] + 1 } : d.counts });
  };
  const options: Array<{ id: Status | null; label: string }> = [{ id: null, label: "all" }, ...STATUSES];
  const pick = (id: string, on: boolean) => setPicked((before) => { const next = new Set(before); if (on) next.add(id); else next.delete(id); return next; });

  return (
    <>
      <AdminHeader title="bug reports" sub="what people sent with @devs or give feedback in the app. each one is mailed to the alert address once. a fixed version shows up on their message, and they hear about it once they run it." />
      <div role="group" aria-label="which reports" className="mb-8 flex flex-wrap gap-1.5 max-sm:mb-6">
        {options.map((option) => {
          const count = !data ? null : option.id ? data.counts[option.id] : total;
          return (
            <button key={option.label} type="button" aria-pressed={status === option.id} onClick={() => setStatus(option.id)}
              className={cx("inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-14 hover-chip", status === option.id ? "bg-ink text-bg" : "bg-card text-ink-2")}>
              {option.label}
              {count !== null && <span className={cx("font-mono text-12 num", status === option.id ? "text-bg/70" : "text-ink-3")}>{n(count)}</span>}
            </button>
          );
        })}
      </div>
      {data?.themes?.length ? (
        <div role="group" aria-label="which theme" className="-mt-5 mb-8 flex flex-wrap gap-1.5 max-sm:-mt-3 max-sm:mb-6">
          {[{ theme: null as string | null, count: data.themes.reduce((s, t) => s + t.count, 0), open: data.themes.reduce((s, t) => s + t.open, 0) }, ...data.themes].map((row) => (
            <button key={row.theme ?? "all"} type="button" aria-pressed={theme === row.theme} onClick={() => setTheme(row.theme)}
              title={`${n(row.open)} still new or looking, of ${n(row.count)}`}
              className={cx("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-13 hover-chip", theme === row.theme ? "bg-ink text-bg" : "bg-card text-ink-2")}>
              {row.theme ?? "every theme"}
              <span className={cx("font-mono text-12 num", theme === row.theme ? "text-bg/70" : "text-ink-3")}>{n(row.open)}/{n(row.count)}</span>
            </button>
          ))}
          {data.themesCapped && <span className="self-center text-12 text-ink-3">themes count the newest 5,000 reports</span>}
        </div>
      ) : null}
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <Section title="newest first" action={reports.length ? (
          <button type="button" className="text-13 text-ink-2 hover:text-ink" onClick={() => setPicked(picked.size === reports.length ? new Set() : new Set(reports.map((r) => r.id)))}>
            {picked.size === reports.length ? "clear selection" : `select all ${n(reports.length)} shown`}
          </button>
        ) : undefined}>
          {picked.size > 0 && <BulkBar ids={[...picked]} onDone={(rows) => { for (const row of rows) changed(row); setPicked(new Set()); }} onClear={() => setPicked(new Set())} />}
          {reports.length ? (
            <ol className="flex flex-col gap-2">{reports.map((report) => <Report key={report.id} report={report} onChange={changed} selected={picked.has(report.id)} onSelect={(on) => pick(report.id, on)} />)}</ol>
          ) : <p className="rounded-[18px] bg-card px-4 py-6 text-center text-13 text-ink-2">{status ? `no ${STATUS[status].label} reports.` : "no reports yet. they come in when someone types @devs in a chat or sends feedback from the app."}</p>}
          {next !== null && <div className="mt-4 flex justify-center"><Button size="sm" disabled={busy} onClick={() => void loadMore()}>{busy ? "loading…" : "older reports"}</Button></div>}
        </Section>
      )}
    </>
  );
}
