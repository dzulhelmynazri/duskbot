import { describe, expect, it } from "vitest";
import type { OpsRelayCard, OpsRelayStats } from "../../../src/admin/ops-types.ts";
import { linkAccountRef } from "../../link-grant.ts";
import { fairStage, rangeDays, topAccounts } from "./accounts.ts";

const GB = 1e9;
const card = (id: string, fair: Array<[string, number]>, monthOut = 100 * GB): OpsRelayCard => ({
  id, label: id, url: "https://x.test", at: 0, configured: true, ok: true, error: null,
  stats: { relay: id, now: { tunnels: 0, accounts: 0, bytesPerSecOut: 0, bytesPerSecIn: 0, cpu: null, rssMb: null }, today: { bytesOut: 0, bytesIn: 0 },
    month: { bytesOut: monthOut, bytesIn: 0, projectedBytesOut: 0, allowanceBytes: null }, limits: { accountFullSpeedBytes: 20 * GB, accountFloorAtBytes: 80 * GB }, top: [], busy: false,
    fairUse: { month: "2026-11", accounts: fair.map(([account, bytes]) => ({ account, tunnel: null, monthBytes: bytes, hereBytes: bytes, bytesPerSec: 1 })) } } as OpsRelayStats,
});

describe("top accounts", () => {
  it("puts each account on the fair use curve", () => {
    expect(fairStage(5 * GB, { fullSpeedBytes: 20 * GB, floorAtBytes: 80 * GB })).toBe("full");
    expect(fairStage(40 * GB, { fullSpeedBytes: 20 * GB, floorAtBytes: 80 * GB })).toBe("slowing");
    expect(fairStage(90 * GB, { fullSpeedBytes: 20 * GB, floorAtBytes: 80 * GB })).toBe("chat");
  });

  it("maps relay refs to accounts, takes the largest a node saw, and flags heavy use and code floods", () => {
    const accounts = [{ id: "acct_a", email: "a@x.test" }, { id: "acct_b", email: "b@x.test" }];
    const answer = topAccounts({ now: 0, month: "2026-11", data: "own", accounts,
      relays: [card("contabo", [[linkAccountRef("acct_a"), 90 * GB], [linkAccountRef("acct_b"), 10 * GB]]), card("oracle-in", [[linkAccountRef("acct_a"), 85 * GB], ["unknownref", 1 * GB]], 50 * GB)],
      infra: [{ day: "2026-11-02", cloudId: "c1", accountId: "acct_b", serverId: "s", runningSeconds: 7200, vcpuSeconds: 0, memGiBSeconds: 0, diskGiBSeconds: 0, egressBytes: 0, computeCents: 0, diskCents: 0, costCents: 340, collectedAt: 0 }],
      mail: [{ source: "mail", day: "2026-11-02", key: "acct_b", accountId: "acct_b", values: { sent: 33, codes: 31 } }] });
    const a = answer.rows.find(row => row.accountId === "acct_a")!, b = answer.rows.find(row => row.accountId === "acct_b")!;
    expect(a.relay).toMatchObject({ monthBytes: 90 * GB, stage: "chat", share: 0.6 });
    expect(a.email).toBe("a@x.test");
    expect(a.flags.map(flag => flag.kind)).toContain("abuse");
    expect(b.cloud).toEqual({ awakeHours: 2, costCents: 340, egressState: null });
    expect([b.emails, b.codes]).toEqual([33, 31]);
    expect(b.flags.map(flag => flag.kind)).toEqual(["abuse"]);
    expect(answer.rows.find(row => row.ref === "unknownref")).toMatchObject({ accountId: null, email: null });
    expect(answer.reported).toEqual({ relay: true, cloud: true, mail: true });
  });

  it("says what is not reported yet", () => {
    const answer = topAccounts({ now: 0, month: "2026-11", data: "madani.bot", accounts: [], relays: [], infra: null, mail: null });
    expect(answer.reported).toEqual({ relay: false, cloud: false, mail: false });
    expect(answer.fairUse).toEqual({ fullSpeedBytes: 20 * GB, floorAtBytes: 80 * GB });
  });

  it("covers this month, last month or the last 7 days", () => {
    const now = Date.UTC(2026, 10, 14, 12);
    expect(rangeDays("month", now)).toEqual({ from: "2026-11-01", to: "2026-11-14" });
    expect(rangeDays("last-month", now)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(rangeDays("7d", now)).toEqual({ from: "2026-11-08", to: "2026-11-14" });
    expect(rangeDays("last-month", Date.UTC(2026, 0, 3))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("names each account's plan when plans are known, and counts every account past the limit", () => {
    const accounts = [{ id: "acct_a", email: "a@x.test" }, { id: "acct_b", email: "b@x.test" }];
    const mail = accounts.map(a => ({ source: "mail", day: "2026-11-02", key: a.id, accountId: a.id, values: { sent: 2, codes: 1 } }));
    const answer = topAccounts({ now: Date.UTC(2026, 10, 14), month: "2026-11", data: "own", accounts, relays: [], infra: null, mail, plans: new Map([["acct_a", "pro"]]), limit: 1, range: "7d" });
    expect(answer.rows).toHaveLength(1);
    expect(answer.total).toBe(2);
    expect(answer.range).toBe("7d");
    expect(answer.rows[0]!.plan).toMatch(/^(pro|none)$/);
  });

  // live data (preview reading madani.bot) can carry rows with missing counters; none of them may fail the page
  it("counts missing or broken fields as nothing instead of failing", () => {
    const broken = card("contabo", [["ref1", 2 * GB]]);
    (broken.stats as { month?: unknown }).month = undefined;
    (broken.stats!.limits as Record<string, unknown>).accountFloorAtBytes = 0;
    const answer = topAccounts({ now: 0, month: "2026-11", data: "madani.bot", accounts: [{ id: "acct_b", email: "b@x.test" }], relays: [broken],
      infra: [{ day: "2026-11-02", accountId: "acct_b" } as never, null as never],
      mail: [{ source: "mail", day: "2026-11-02", key: "acct_b", accountId: "acct_b" } as never, { source: "mail", day: "2026-11-02", key: "x", accountId: "acct_b", values: { sent: "3" } } as never],
      suspects: [null as never, { key: "k", accountId: "acct_b", email: null, ip: null, score: undefined, signals: [], why: "" } as never] });
    expect(answer.fairUse.floorAtBytes).toBe(80 * GB);
    expect(answer.rows.find(row => row.ref === "ref1")?.relay).toMatchObject({ monthBytes: 2 * GB, share: 1 });
    const b = answer.rows.find(row => row.accountId === "acct_b");
    expect(b === undefined || (b.emails === 0 && b.cloud?.costCents === 0)).toBe(true);
    expect(JSON.stringify(answer)).not.toContain("NaN");
  });
});
