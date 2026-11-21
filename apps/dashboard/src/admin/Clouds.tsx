import { useState } from "react";
import { Segmented } from "../ui/kit";
import { Nil, RowMenu, Table, Td, Th } from "../ui/table";
import { ago, duration } from "../lib/format";
import { PersonLink } from "./sheet";
import { useNow } from "../lib/now";
import { toast } from "../lib/toast";
import { adminCall, useAdmin, type CloudRow } from "./api";
import { AnimatePresence } from "../ui/motion";
import { AdminHeader, ConfirmAction, Failed, Loading, n, Status } from "./ui";

type Action = "pause" | "resume" | "delete" | "end-trial";
const COPY: Record<Action, { title: (name: string) => string; body: string; button: string; done: string }> = {
  pause: { title: (name) => `pause ${name}?`, body: "the machine powers off. the owner's bots stop answering until it's resumed, by you or by them.", button: "pause cloud", done: "paused" },
  resume: { title: (name) => `resume ${name}?`, body: "the machine starts again and its bots come back within a few minutes.", button: "resume cloud", done: "resuming" },
  "end-trial": { title: (name) => `end the update trial on ${name}?`, body: "the home update on trial is kept now instead of after its day of trial, once its self-test has passed, so the next release installs at the cloud's next quiet moment.", button: "end trial", done: "trial ended" },
  delete: { title: (name) => `delete ${name}?`, body: "this skips the retention wait and the owner's undo window. a final backup is taken, then the machine and its disk are deleted. it can't be undone.", button: "delete cloud", done: "deleting" },
};

export function CloudTable({ clouds, onChanged, owner = true }: { clouds: CloudRow[]; onChanged(): void; owner?: boolean }) {
  const now = useNow(30_000);
  const [pending, setPending] = useState<{ cloud: CloudRow; action: Action } | null>(null);
  const uptime = (c: CloudRow) => c.status === "running" ? duration(Math.max(60, (now - c.powerSince) / 1000)) : null;
  return (
    <>
      <Table label="clouds">
        <thead><tr><Th>cloud</Th>{owner && <Th>owner</Th>}<Th>state</Th><Th>plan</Th><Th>region</Th><Th>up for</Th><Th>created</Th><Th aria-label="actions" /></tr></thead>
        <tbody>
          {clouds.map((c) => (
            <tr key={c.id} className="hover-row">
              <Td className="max-w-[240px]"><span className="block truncate text-14 text-ink">{c.name}</span><span className="t-id block truncate !text-[12px] text-ink-3">{c.id}</span></Td>
              {owner && <Td className="max-w-[220px]">{c.owner ? <PersonLink id={c.accountId} className="text-link block truncate text-13">{c.owner}</PersonLink> : <span className="text-13 text-ink-4">deleted account</span>}</Td>}
              <Td><Status value={c.suspended ? "suspended" : c.status} label={c.suspended ? "suspended" : `${c.status.replace(/_/g, " ")}${c.setupStep && c.status === "provisioning" ? `, ${c.setupStep}` : ""}`} />{c.error && <span className="mt-0.5 block max-w-[220px] truncate text-12 text-bad" title={c.error}>{c.error}</span>}</Td>
              <Td className="whitespace-nowrap text-13 text-ink-2">{c.plan}{c.backend ? " · managed" : ""}<span className="block text-12 text-ink-3 num">{c.spec.vcpu} vcpu · {c.spec.ramGb} gb · {c.spec.diskGb} gb</span>{c.egress && <span className="block text-12 text-ink-3 num" title="internet upload this month">{(c.egress.bytes / 1e9).toFixed(1)} gb out{c.egress.state !== "ok" && <span className="text-warn"> · {c.egress.state}</span>}</span>}</Td>
              <Td className="whitespace-nowrap text-13 text-ink-2">{c.regionLabel}</Td>
              <Td className="whitespace-nowrap font-mono text-13 num">{uptime(c) ?? <Nil />}</Td>
              <Td className="whitespace-nowrap text-13 text-ink-3">{ago(c.createdAt, now)}{c.destroyAt ? <span className="block text-12 text-warn">deletes {new Date(c.destroyAt).toISOString().slice(0, 10)}</span> : null}</Td>
              <Td className="w-12 text-end">
                <RowMenu label={`actions for ${c.name}`} items={[
                  { label: "pause", disabled: !c.actions.pause, onSelect: () => setPending({ cloud: c, action: "pause" }) },
                  { label: "resume", disabled: !c.actions.resume, onSelect: () => setPending({ cloud: c, action: "resume" }) },
                  ...(c.actions.endTrial ? [{ label: "end update trial", onSelect: () => setPending({ cloud: c, action: "end-trial" }) }] : []),
                  { label: c.actions.delete ? "delete now" : "delete (ended managed clouds only)", danger: true, disabled: !c.actions.delete, onSelect: () => setPending({ cloud: c, action: "delete" }) },
                ]} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <AnimatePresence>{pending && (
        <ConfirmAction key="confirm" open onClose={() => setPending(null)} title={COPY[pending.action].title(pending.cloud.name)} body={COPY[pending.action].body} word={pending.cloud.name}
          action={COPY[pending.action].button} danger={pending.action === "pause" || pending.action === "delete"}
          onConfirm={async () => {
            await adminCall(`/clouds/${pending.cloud.id}/${pending.action}`, { body: { confirm: pending.cloud.name } });
            toast(`${pending.cloud.name}: ${COPY[pending.action].done}`);
            onChanged();
          }} />
      )}</AnimatePresence>
    </>
  );
}

const STATES = [{ value: "live", label: "live" }, { value: "running", label: "running" }, { value: "provisioning", label: "setting up" }, { value: "stopped", label: "stopped" }, { value: "all", label: "all" }] as const;

export function CloudsPage() {
  const [status, setStatus] = useState<(typeof STATES)[number]["value"]>("live");
  const { data, error, loading, reload } = useAdmin<{ clouds: CloudRow[]; now: number }>(`/clouds?status=${status}`, 30_000);
  return (
    <>
      <AdminHeader title="clouds" sub={data ? `${n(data.clouds.length)} shown · refreshes every 30 s` : "every madani cloud machine"} action={<Segmented<typeof status> label="state" value={status} options={[...STATES]} onChange={setStatus} />} />
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading />}
      {data && (data.clouds.length ? <CloudTable clouds={data.clouds} onChanged={reload} /> : <p className="rounded-[18px] bg-card px-4 py-6 text-center text-14 text-ink-3">no clouds in this state.</p>)}
    </>
  );
}
