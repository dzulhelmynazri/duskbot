import type { ReactNode } from "react";
import { Table, Td, Th } from "../ui/table";
import { ago, duration } from "../lib/format";
import { useNow } from "../lib/now";
import { useAdmin, type AuditEntry, type Health } from "./api";
import { AdminHeader, Failed, Loading, n, Section, stamp, Status } from "./ui";

function Row({ label, state, children }: { label: string; state: "ok" | "error" | "not_configured" | "behind"; children: ReactNode }) {
  return (
    <li className="grid min-h-14 grid-cols-[180px_150px_minmax(0,1fr)] items-center gap-4 py-2 max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-y-1">
      <span className="text-14 text-ink">{label}</span>
      <span className="max-md:justify-self-end"><Status value={state} label={state === "ok" ? "healthy" : state === "error" ? "needs a look" : state === "behind" ? "stale" : "not set up"} /></span>
      <span className="min-w-0 text-13 text-ink-3 max-md:col-span-2">{children}</span>
    </li>
  );
}

export function HealthPage() {
  const { data, error, loading, reload } = useAdmin<Health>("/health", 30_000);
  const now = useNow(30_000);
  return (
    <>
      <AdminHeader title="system health" sub={data ? `${data.service.environment} · version ${data.service.version ?? "unknown"} · checked ${ago(data.now, now)}` : "the account service and what it depends on"} />
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <ul className="">
            <Row label="account service" state="ok">up {duration(data.service.uptimeSec)} · node {data.service.node} · {n(data.service.rssMb)} mb memory</Row>
            <Row label="database" state={data.database.ok ? "ok" : "error"}>{data.database.detail}</Row>
            <Row label="analytics store" state={data.analytics.ok && !data.analytics.failed ? "ok" : "error"}>
              {data.analytics.detail}{data.analytics.latencyMs !== null ? ` · ping ${data.analytics.latencyMs} ms` : ""} · {n(data.analytics.written)} written, {n(data.analytics.failed)} failed, {n(data.analytics.dropped)} dropped for opt-outs since start
            </Row>
            <Row label="database backup" state={!data.backup.configured ? "not_configured" : data.backup.ok ? "ok" : data.backup.at ? "behind" : "error"}>
              {!data.backup.configured ? "no backup folder set (MADANI_BACKUP_DIR)" : data.backup.at ? `newest ${data.backup.ageHours} h old, ${stamp(data.backup.at)}` : "no backup found in the folder, or it can't be read"}
            </Row>
            <Row label="errors" state={data.errors.service.hour > 0 ? "error" : "ok"}>
              service {n(data.errors.service.hour)} this hour, {n(data.errors.service.day)} today · pages {n(data.errors.page.hour)} this hour, {n(data.errors.page.day)} today · {n(data.errors.spooled)} waiting in the error spool
            </Row>
            {data.checks.map((check) => (
              <Row key={check.name} label={check.name} state={check.ok ? "ok" : "error"}>
                <span className="font-mono !text-[12.5px]">{check.url}</span> · {check.status === null ? "no answer" : `status ${check.status}`}{check.latencyMs !== null ? ` in ${check.latencyMs} ms` : ""}
              </Row>
            ))}
          </ul>
          {!data.checks.length && <p className="mt-4 text-13 text-ink-3">add other services to watch with MADANI_ADMIN_HEALTH_URLS, like link=https://link.madani.bot/health.</p>}
        </>
      )}
    </>
  );
}

const ACTIONS: Record<string, string> = { "cloud.pause": "paused a cloud", "cloud.resume": "resumed a cloud", "cloud.delete": "deleted a cloud", "waitlist.export": "exported the waitlist", "user.view": "opened a user" };

export function AuditPage() {
  const { data, error, loading, reload } = useAdmin<{ entries: AuditEntry[] }>("/audit");
  return (
    <>
      <AdminHeader title="audit log" sub="every action taken here, and every user record opened. kept for good." />
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading />}
      {data && (data.entries.length ? (
        <Section title={`latest ${data.entries.length}`}>
          <Table label="audit log">
            <thead><tr><Th>when (utc)</Th><Th>who</Th><Th>what</Th><Th>target</Th><Th>result</Th></tr></thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.id}>
                  <Td className="t-id whitespace-nowrap text-ink-3">{stamp(entry.at)}</Td>
                  <Td className="max-w-[220px] truncate text-13 text-ink-2">{entry.actorEmail ?? entry.actor}</Td>
                  <Td className="text-14">{ACTIONS[entry.action] ?? entry.action}</Td>
                  <Td className="t-id max-w-[240px] truncate text-ink-3">{entry.target ?? "-"}</Td>
                  <Td>{entry.detail.ok === false ? <Status value="failed" label={`failed${entry.detail.code ? `, ${entry.detail.code}` : ""}`} /> : <Status value="ok" label={entry.detail.rows !== undefined ? `${entry.detail.rows} rows` : "done"} />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>
      ) : <p className="rounded-[18px] bg-card px-4 py-6 text-center text-14 text-ink-3">nothing yet. actions you take in this panel show up here.</p>)}
    </>
  );
}
