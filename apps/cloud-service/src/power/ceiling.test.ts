// the monthly cost ceiling: its numbers per size, the book's arithmetic, the rails' cost rule, and the persisted ledger
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pooledCostProfile, pooledHourlyCents, POOLED_SIZES } from "./pooled-profile.ts";
import { createSpendLedger, memorySpendStore } from "../spend.ts";
import { advanceBook, applySpend, CEILING_FACTOR, ceilingFactor, monthlyCeilingCents, monthOf, openBook, slackCents, spentCents, worstStartCents } from "./ceiling.ts";
import { HOUR, MINUTE } from "./cost.ts";
import { costChargeRefusal, costStartRefusal, costStopRefusal } from "./rails.ts";

const profile = pooledCostProfile({ plan: "20" }), W = 7, N = 5;
const NOV = Date.UTC(2026, 10, 1), DEC = Date.UTC(2026, 11, 1);
const open = (rate = 1.8, extra: Partial<{ up: boolean; bytes: number; prepaid: boolean; before: boolean }> = {}) =>
  ({ e: "open" as const, rate, floor: 1.8, up: true, bytes: 0, prepaid: false, before: false, ...extra });

describe("the ceiling's numbers", () => {
  it("is $14.00 on small and scales with every size", () => {
    const cents = POOLED_SIZES.map(z => Math.round(monthlyCeilingCents(pooledHourlyCents(z))));
    expect(cents).toEqual([1400, 2800, 5600, 15556]);
    expect(CEILING_FACTOR).toBeCloseTo(1.0654, 4);
  });
  it("prices a month by its hours, but never more than 730 of them", () => {
    expect([2028, 2027].map(y => monthOf(Date.UTC(y, 1, 10)).hours)).toEqual([696, 672]);
    expect(monthOf(Date.UTC(2027, 0, 31, 23, 59)).hours).toBe(744);
    expect(monthlyCeilingCents(1.8, 744)).toBeCloseTo(1400, 6);
    expect(monthlyCeilingCents(1.8, 720)).toBeCloseTo(1380.8, 1);
    expect(monthlyCeilingCents(1.8, 672)).toBeCloseTo(1288.8, 1);
  });
  it("charges a start at the top extra tier: $0.07", () => {
    expect(worstStartCents(profile)).toBe(7);
    expect(worstStartCents(pooledCostProfile({ plan: "2000", scale: 0.01 }))).toBe(7);
  });
});

describe("a home's book", () => {
  it("always-on for a whole month ends under the ceiling, with the margin as slack throughout", () => {
    const b = openBook(DEC, open());
    const slack0 = slackCents(b);
    expect(slack0).toBeCloseTo(1400 - 744 * 1.8, 6);
    for (let t = DEC; t < Date.UTC(2027, 0, 1); t += 7 * HOUR) { advanceBook(b, t); expect(slackCents(b)).toBeCloseTo(slack0, 6); }
    const closed = advanceBook(b, Date.UTC(2027, 0, 1));
    expect(closed).toHaveLength(1);
    expect(spentCents(closed[0]!)).toBeCloseTo(1339.2, 6);
    expect(closed[0]!.ceilingCents).toBeCloseTo(1400, 6);
    expect(b.month).toBe("2027-01");
  });
  it("gains a stopped hour's compute while asleep, and spends a start's price", () => {
    const b = openBook(NOV, open());
    const s0 = slackCents(b);
    applySpend(b, { e: "down" }); advanceBook(b, NOV + 10 * HOUR);
    expect(slackCents(b) - s0).toBeCloseTo(10 * 1.8 * ceilingFactor(720) - 10 * (ceilingFactor(720) - 1) * 1.8, 6);
    applySpend(b, { e: "start", kind: "wake", cents: 7 });
    expect(b.unplanned).toBe(1);
  });
  it("a resize either way never moves the slack; the future is only counted at the cheapest size's margin", () => {
    const b = openBook(NOV, open(20));
    advanceBook(b, NOV + 100 * HOUR);
    const before = slackCents(b);
    applySpend(b, { e: "rate", rate: 1.8 });
    expect(slackCents(b)).toBeCloseTo(before, 6);
    applySpend(b, { e: "rate", rate: 7.2 });
    expect(slackCents(b)).toBeCloseTo(before, 6);
  });
  it("a stop pays for the next start; a voided start gives it back", () => {
    const b = openBook(NOV, open());
    applySpend(b, { e: "stop" });
    applySpend(b, { e: "start", kind: "wake", cents: 7 });
    expect([b.prepaid, b.unplanned]).toEqual([false, 0]);
    applySpend(b, { e: "settle", cents: 7, void: true });
    expect([b.prepaid, b.unplanned, b.startCents]).toEqual([true, 0, 0]);
    applySpend(b, { e: "start", kind: "wake", cents: 7 }); applySpend(b, { e: "start", kind: "wake", cents: 7 });
    expect(b.unplanned).toBe(1);
  });
  it("a home already running when its book opens is priced as always-on so far", () => {
    const at = NOV + 200 * HOUR, b = openBook(at, open(1.8, { before: true }));
    expect(b.computeCents).toBeCloseTo(360, 6);
    expect(slackCents(b)).toBeCloseTo(1.8 * 720 * (ceilingFactor(720) - 1), 6);
  });
});

describe("the rails' cost rule", () => {
  const view = (slack: number, unplanned = 0, gain = 0) => ({ slackCents: slack, worstStartCents: W, reserveStarts: N, unplanned, gainCentsPerHour: gain });
  it("stops only with the reserve and the next start paid for", () => {
    expect(costStopRefusal(view(42), 0)).toBeNull();
    expect(costStopRefusal(view(41.99), 0)?.reason).toBe("cost_ceiling");
    expect(costStopRefusal(view(35, 1), 0)).toBeNull();
    expect(costStopRefusal(view(1000, 5), 0)?.reason).toBe("cost_reserve_used");
    expect(costStopRefusal(view(7), 0, true)).toBeNull();
    expect(costStopRefusal(view(6.9), 0, true)?.reason).toBe("cost_ceiling");
  });
  it("a person's start may use the reserve, a start we choose may not, a second machine needs its compute too", () => {
    expect(costStartRefusal(view(7), "wake", 0)).toBeNull();
    expect(costStartRefusal(view(6.9), "recover", 0)?.reason).toBe("cost_ceiling");
    expect(costStartRefusal(view(41.9), "routine", 0)?.reason).toBe("cost_ceiling");
    expect(costStartRefusal(view(42), "recover", 0)).toBeNull();
    expect(costStartRefusal(view(49), "recover", 0, 3.6)?.reason).toBe("cost_ceiling");
    expect(costStartRefusal(view(52.6), "recover", 0, 3.6)).toBeNull();
    expect(costChargeRefusal(view(45), 3, 0)).toBeNull();
    expect(costChargeRefusal(view(44.9), 3, 0)?.reason).toBe("cost_ceiling");
  });
  it("a refused start rechecks when the slack will have grown enough", () => {
    expect(costStartRefusal(view(0, 0, 1.8), "wake", 0)!.recheckAt).toBe(Math.ceil(7 / 1.8 * HOUR));
    expect(costStopRefusal(view(30, 0, 0), 0)!.recheckAt).toBe(HOUR);
  });
});

describe("the spend ledger", () => {
  const init = () => ({ rate: 1.8, up: true, bytes: 0, prepaid: false, before: false });
  it("replays to the same books after a restart, across a month boundary", () => {
    const store = memorySpendStore();
    let t = Date.UTC(2026, 10, 29);
    const make = () => createSpendLedger({ store, profile, reserveStarts: N, now: () => t });
    const a = make();
    a.view("c1", init);
    t += HOUR; a.record("c1", init, { e: "stop" }); t += MINUTE; a.mark("c1", init, false);
    t += 3 * 24 * HOUR; a.record("c1", init, { e: "start", kind: "wake", cents: 7 }); a.record("c1", init, { e: "settle", cents: 7 });
    t += HOUR; a.record("c1", init, { e: "bytes", bytes: 2e9 });
    const b = make(), x = a.book("c1"), y = b.book("c1");
    expect(y.current).toEqual(x.current);
    expect(y.current!.month).toBe("2026-12");
    expect(store.all.some(l => l.month === "2026-12" && l.line.includes("\"open\""))).toBe(true);
  });
  it("replays the log's own months even when the clock at boot is weeks off (regression)", () => {
    const store = memorySpendStore();
    let t = Date.UTC(2027, 1, 6);
    createSpendLedger({ store, profile, reserveStarts: N, now: () => t }).record("c1", init, { e: "start", kind: "wake", cents: 7 });
    t -= 20 * 24 * HOUR;
    const b = createSpendLedger({ store, profile, reserveStarts: N, now: () => t }).book("c1").current;
    expect([b?.month, b?.startCents]).toEqual(["2027-02", 7]);
  });
  it("persists to an append-only file that survives a torn last line", () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-spend-"));
    let t = NOV + HOUR;
    const alerts: string[] = [];
    const a = createSpendLedger({ dataDir: dir, profile, reserveStarts: N, now: () => t });
    a.record("c1", init, { e: "start", kind: "create", cents: 7 });
    const file = join(dir, "spend", "2026-11.jsonl"), lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    appendFileSync(file, "{\"t\":1,\"c\":\"c1\",\"e\":\"sta");
    t += HOUR;
    const b = createSpendLedger({ dataDir: dir, profile, reserveStarts: N, now: () => t, alert: (_c, text) => alerts.push(text) });
    expect(b.book("c1").current!.startCents).toBe(7);
    expect(alerts).toHaveLength(1);
    writeFileSync(file, "");
  });
  it("does not take a wall-clock jump as time passing", () => {
    let wall = NOV, mono = 0;
    const l = createSpendLedger({ store: memorySpendStore(), profile, reserveStarts: N, now: () => wall, mono: () => mono });
    l.view("c1", init);
    l.mark("c1", init, false);
    const s0 = l.view("c1", init).slackCents;
    wall += 10 * 24 * HOUR; mono += MINUTE;
    const s1 = l.view("c1", init).slackCents;
    expect(s1 - s0).toBeLessThan(0.1);
    wall -= 20 * 24 * HOUR; mono += MINUTE;
    expect(l.book("c1").current!.at).toBe(NOV + 2 * MINUTE);
  });
  it("tells the operator once when a home has used its reserve", () => {
    const alerts: string[] = [];
    const l = createSpendLedger({ store: memorySpendStore(), profile, reserveStarts: N, now: () => NOV, alert: (_c, text) => alerts.push(text) });
    for (let i = 0; i < 7; i++) l.record("c1", init, { e: "start", kind: "recover", cents: 0 });
    expect(alerts.filter(a => a.includes("stays up"))).toHaveLength(1);
  });
});

describe("the home's own disk", () => {
  it("counts in both spend and ceiling while its machine exists, so it is bounded without taking slack from compute", () => {
    const disk = 20 * 8 / 730, plain = openBook(NOV, open()), withDisk = openBook(NOV, { ...open(), disk });
    advanceBook(plain, NOV + 100 * HOUR); advanceBook(withDisk, NOV + 100 * HOUR);
    expect(withDisk.diskCents).toBeCloseTo(disk * 100, 6);
    expect(spentCents(withDisk) - spentCents(plain)).toBeCloseTo(disk * 100, 6);
    expect(withDisk.ceilingCents - plain.ceilingCents).toBeCloseTo(disk * 100, 6);
    expect(slackCents(withDisk)).toBeCloseTo(slackCents(plain), 6);
    // the machine deleted (an archived home): no more disk on either side
    applySpend(withDisk, { e: "disk", rate: 0 });
    advanceBook(withDisk, NOV + 200 * HOUR);
    expect(withDisk.diskCents).toBeCloseTo(disk * 100, 6);
    // a month that ends carries the rate and starts its own disk count
    applySpend(withDisk, { e: "disk", rate: disk });
    advanceBook(withDisk, DEC + HOUR);
    expect(withDisk.month).toBe("2026-12");
    expect(withDisk.diskCents).toBeCloseTo(disk, 6);
  });
  it("is replayed from the log", () => {
    const store = memorySpendStore();
    let t = NOV + HOUR;
    const make = () => createSpendLedger({ store, profile, reserveStarts: N, now: () => t });
    const a = make();
    a.record("c1", () => ({ rate: 1.8, up: true, bytes: 0, prepaid: false, before: false, disk: 0.2 }), { e: "disk", rate: 0.3 });
    t += 10 * HOUR;
    const before = a.book("c1").current!;
    const b = make().book("c1").current!;
    expect(b.disk).toBe(0.3);
    expect(b.diskCents).toBeCloseTo(before.diskCents, 6);
    expect(b.diskCents).toBeCloseTo(3, 6);
  });
});
