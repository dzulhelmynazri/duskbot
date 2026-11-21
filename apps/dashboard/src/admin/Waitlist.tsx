import { useEffect, useState, type ReactNode } from "react";
import { Download } from "@/icons";
import { Table, Td, Th } from "../ui/table";
import { useAdmin, useAdminRole, type WaitlistPage } from "./api";
import { AdminHeader, DayBars, Failed, Loading, n, Pager, SearchBox, Status, Tile, stamp } from "./ui";

const BREVO: Record<WaitlistPage["brevo"]["state"], string> = {
  synced: "in sync", behind: "behind the waitlist", error: "couldn't check", not_configured: "not connected",
};

export function WaitlistPage({ tabs }: { tabs?: ReactNode }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => { const timer = setTimeout(() => { setSearch(q.trim().toLowerCase()); setOffset(0); }, 220); return () => clearTimeout(timer); }, [q]);
  const { data, error, loading, reload } = useAdmin<WaitlistPage>(`/waitlist?q=${encodeURIComponent(search)}&offset=${offset}&limit=50`);
  const brevo = data?.brevo;
  const owner = useAdminRole() === "owner";
  return (
    <>
      <AdminHeader title="waitlist" sub="people waiting on madani.bot" tabs={tabs}
        action={owner && data?.configured ? <a href="/v1/admin/waitlist.csv" download className="press hover-btn inline-flex h-9 items-center gap-1.5 rounded-full bg-btn px-4 text-13 font-medium text-ink"><Download size={15} strokeWidth={1.75} aria-hidden /> export csv</a> : undefined} />
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading />}
      {data && !data.configured && <p className="rounded-[18px] bg-card px-4 py-6 text-center text-14 text-ink-3">the waitlist isn't connected here. it reads madani.waitlist when the service runs with MongoDB.</p>}
      {data?.configured && (
        <>
          <div className="grid grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,2fr)] gap-2.5 max-lg:grid-cols-3 max-sm:grid-cols-2">
            <Tile label="waiting" value={n(data.count)} />
            <Tile label="joined in 30 days" value={n(data.series?.reduce((a, b) => a + b, 0) ?? 0)} />
            <Tile label="brevo list" value={brevo?.listCount === null || brevo?.listCount === undefined ? "-" : n(brevo.listCount)} note={<Status value={brevo?.state ?? "not_configured"} label={BREVO[brevo?.state ?? "not_configured"]} />} tone={brevo?.state === "behind" ? "warn" : brevo?.state === "error" ? "bad" : undefined} />
            <div className="rounded-[18px] bg-card px-4 py-3 max-lg:col-span-3 max-sm:col-span-2">{data.days && data.series && <DayBars title="joins per day" days={data.days} values={data.series} height={52} />}</div>
          </div>
          {owner && <>
          <div className="mb-4 mt-8"><SearchBox value={q} onChange={setQ} label="search the waitlist" placeholder="email or source" /></div>
          {data.entries.length ? (
            <>
              <Table label="waitlist">
                <thead><tr><Th className="!text-end">#</Th><Th>email</Th><Th>source</Th><Th>ref</Th><Th>joined</Th></tr></thead>
                <tbody>
                  {data.entries.map((entry) => (
                    <tr key={entry.position} className="hover-row">
                      <Td className="w-16 text-end font-mono text-13 text-ink-3 num">{entry.position}</Td>
                      <Td className="max-w-[340px] truncate">{entry.email}</Td>
                      <Td className="text-13 text-ink-2">{entry.source ?? "-"}</Td>
                      <Td className="text-13 text-ink-2">{entry.ref ?? "-"}</Td>
                      <Td className="t-id whitespace-nowrap text-ink-3">{stamp(entry.createdAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pager offset={data.offset ?? 0} limit={data.limit ?? 50} total={data.total} onChange={setOffset} />
            </>
          ) : <p className="rounded-[18px] bg-card px-4 py-6 text-center text-14 text-ink-3">{search ? `nobody on the waitlist matches "${search}".` : "the waitlist is empty."}</p>}
          </>}
        </>
      )}
    </>
  );
}
