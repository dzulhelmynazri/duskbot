import { useEffect, useId, useState } from "react";
import { Button, Segmented } from "../ui/kit";
import { Table, Td, Th } from "../ui/table";
import { navigate, useLocation } from "../lib/router";
import { PersonLink } from "./sheet";
import { useAdmin, type EventRow } from "./api";
import { AdminHeader, Failed, Loading, n, Section, stamp } from "./ui";

const WINDOWS = [{ value: "1", label: "24 h" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "400", label: "all kept" }] as const;
type Answer = { names: string[]; counts: Array<{ name: string; count: number }>; events: EventRow[]; next: number | null; untracked?: number | null };

function context(ctx: Record<string, unknown> | undefined) {
  if (!ctx) return "";
  const parts = [ctx.channel, ctx.referrer, ctx.country, ctx.device, ctx.os, (ctx.app as { platform?: string } | undefined)?.platform].filter((part): part is string => typeof part === "string");
  return parts.join(" · ");
}

export function EventsPage() {
  const { query } = useLocation();
  const [name, setName] = useState(query.get("name") ?? "");
  const [days, setDays] = useState<(typeof WINDOWS)[number]["value"]>("7");
  const [before, setBefore] = useState<number[]>([]);
  const account = query.get("account") ?? "";
  const selectId = useId();
  useEffect(() => setBefore([]), [name, days, account]);
  const cursor = before.at(-1);
  const path = `/events?days=${days}&limit=100${name ? `&name=${name}` : ""}${account ? `&account=${encodeURIComponent(account)}` : ""}${cursor ? `&before=${cursor}` : ""}`;
  const { data, error, loading, reload } = useAdmin<Answer>(path);
  const max = Math.max(1, ...(data?.counts.map((row) => row.count) ?? [1]));
  return (
    <>
      <AdminHeader title="events" sub={`what people did, newest first. counts and states only.${data?.untracked ? ` ${n(data.untracked)} accounts turned off help improve madani bot, so none of their events are here; signups and people elsewhere count every account.` : ""}`} action={<Segmented<typeof days> label="window" value={days} options={[...WINDOWS]} onChange={setDays} />} />
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={selectId} className="mb-1.5 block text-13 text-ink-2">event</label>
          <select id={selectId} value={name} onChange={(e) => setName(e.target.value)} className="field !h-10 !w-[220px] !text-14">
            <option value="">every event</option>
            {(data?.names ?? []).map((item) => <option key={item} value={item}>{item.replace(/_/g, " ")}</option>)}
          </select>
        </div>
        {account && (
          <span className="inline-flex h-10 items-center gap-2 rounded-full bg-card ps-4 pe-1.5 text-13 text-ink-2">
            one account <span className="t-id text-ink">{account}</span>
            <Button size="sm" variant="ghost" onClick={() => navigate("/admin/events")} aria-label="show every account">clear</Button>
          </span>
        )}
      </div>
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-10 max-lg:grid-cols-1">
          <div className="min-w-0">
            {data.events.length ? (
              <Table label="events">
                <thead><tr><Th>when (utc)</Th><Th>event</Th><Th>account</Th><Th>details</Th></tr></thead>
                <tbody>
                  {data.events.map((event) => (
                    <tr key={event.id} className="hover-row">
                      <Td className="t-id whitespace-nowrap text-ink-3">{stamp(event.at)}</Td>
                      <Td className="whitespace-nowrap text-14">{event.name.replace(/_/g, " ")}</Td>
                      <Td className="max-w-[220px]">{event.accountId ? <PersonLink id={event.accountId} className="text-link block truncate text-13">{event.email ?? event.accountId}</PersonLink> : <span className="text-13 text-ink-4">anonymous</span>}</Td>
                      <Td className="max-w-[320px] text-13 text-ink-3"><span className="block truncate font-mono !text-[12.5px]">{Object.entries(event.props).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}</span>{event.ctx && <span className="block truncate text-12 text-ink-4">{context(event.ctx)}</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : <p className="rounded-[18px] bg-card px-4 py-6 text-center text-14 text-ink-3">no events in this window{name ? ` named ${name.replace(/_/g, " ")}` : ""}.</p>}
            <div className="mt-4 flex gap-2">
              <Button size="sm" disabled={!before.length} onClick={() => setBefore((list) => list.slice(0, -1))}>newer</Button>
              <Button size="sm" disabled={data.next === null} onClick={() => data.next !== null && setBefore((list) => [...list, data.next!])}>older</Button>
            </div>
          </div>
          <Section title="in this window">
            <ul className="flex flex-col gap-1">
              {data.counts.map((row) => (
                <li key={row.name}>
                  <button type="button" onClick={() => setName(row.name === name ? "" : row.name)} aria-pressed={row.name === name} className={`hover-ghost w-full rounded-[12px] px-2.5 py-2 text-start ${row.name === name ? "bg-card-2" : ""}`}>
                    <span className="flex items-baseline justify-between gap-3 text-13"><span className="truncate text-ink-2">{row.name.replace(/_/g, " ")}</span><span className="font-mono text-ink num">{n(row.count)}</span></span>
                    <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-track" aria-hidden><span className="block h-full rounded-full bg-accent" style={{ width: `${(row.count / max) * 100}%` }} /></span>
                  </button>
                </li>
              ))}
              {!data.counts.length && <li className="text-13 text-ink-3">nothing yet.</li>}
            </ul>
          </Section>
        </div>
      )}
    </>
  );
}
