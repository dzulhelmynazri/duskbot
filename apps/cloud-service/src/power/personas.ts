// The usage personas the simulator runs (madani-ref LIFECYCLE-RESEARCH.md section 3.2), plus a normal Grok-style user.
// Every number is an assumption from that research, randomised per day: when sessions start, how many sends a session
// has and the gaps between them, how long a turn works, which routines run and when, and connector events that address
// the bot. Times are local; a user's time zone shifts them.
import { HOUR, MINUTE } from "./cost.ts";
import type { DayPlan, IntentEvent, Persona, SimRun } from "./sim.ts";

const normal = (rand: () => number) => (rand() + rand() + rand() + rand() - 2) * Math.sqrt(3);
const pick = (rand: () => number, lo: number, hi: number) => lo + (hi - lo) * rand();
const clock = (midnight: number, hours: number) => midnight + Math.round(hours * HOUR);

/** a turn's work: half a minute typical, now and then a task of minutes */
function work(rand: () => number, longShare: number, longMin: [number, number] = [2, 15]): number {
  if (rand() < longShare) return Math.round(pick(rand, longMin[0], longMin[1]) * MINUTE);
  return Math.round(Math.exp(Math.log(30_000) + 0.8 * normal(rand)));
}

/** one sitting: `sends` events, gaps of a few minutes, sometimes a step away of 10 to 40 minutes */
function session(rand: () => number, at: number, options: { sends: number; gapMin: number; away?: number; longShare?: number; kind?: IntentEvent["kind"] }): IntentEvent[] {
  const out: IntentEvent[] = [];
  let t = at;
  for (let i = 0; i < options.sends; i++) {
    out.push({ at: t, kind: options.kind ?? "user", workMs: work(rand, options.longShare ?? 0.08) });
    const stepAway = rand() < (options.away ?? 0.12);
    t += Math.round((stepAway ? pick(rand, 10, 40) : Math.max(0.3, -Math.log(1 - rand()) * options.gapMin)) * MINUTE);
  }
  return out;
}
const sessionAround = (rand: () => number, midnight: number, hour: number, sdHours: number, options: Parameters<typeof session>[2]) =>
  session(rand, clock(midnight, hour + normal(rand) * sdHours), options);

/** connector events addressing the bot: a Poisson stream over a window */
function connector(rand: () => number, midnight: number, fromHour: number, toHour: number, perDay: number, replies = 0): IntentEvent[] {
  const out: IntentEvent[] = [];
  const rate = perDay / ((toHour - fromHour) * HOUR);
  for (let t = clock(midnight, fromHour); ;) {
    t += Math.round(-Math.log(1 - rand()) / rate);
    if (t >= clock(midnight, toHour)) break;
    out.push({ at: t, kind: "connector", workMs: work(rand, 0.05, [1, 5]) });
    for (let r = 0; r < replies && rand() < 0.5; r++) out.push({ at: t + Math.round(pick(rand, 1, 6) * MINUTE), kind: "connector", workMs: work(rand, 0.02) });
  }
  return out;
}

const run = (midnight: number, hour: number, runMin: number, flexMin = 0): SimRun => ({ at: clock(midnight, hour), flexMs: flexMin * MINUTE, runMs: Math.round(runMin * MINUTE) });
/** every `everyMin` minutes from `fromHour` to before `toHour` */
const every = (midnight: number, everyMin: number, fromHour: number, toHour: number, runMin: number): SimRun[] => {
  const out: SimRun[] = [];
  for (let m = fromHour * 60; m < toHour * 60; m += everyMin) out.push({ at: midnight + m * MINUTE, flexMs: 0, runMs: Math.round(runMin * MINUTE) });
  return out;
};
const weekend = (weekday: number) => weekday === 0 || weekday === 6;
const plan = (events: IntentEvent[], runs: SimRun[]): DayPlan => ({ events: events.sort((a, b) => a.at - b.at), runs: runs.sort((a, b) => a.at - b.at) });

export const PERSONAS: Record<string, Persona> = {
  casual: { name: "P1 casual", plan(rand, m) {
    const events = rand() < 0.85 ? sessionAround(rand, m, 21, 1, { sends: 3 + Math.floor(rand() * 3), gapMin: 2 }) : [];
    return plan(events, [run(m, 7.5, 1.5)]);
  } },
  normal: { name: "P2 normal", plan(rand, m, wd) {
    const p = weekend(wd) ? 0.6 : 0.8, events: IntentEvent[] = [];
    for (const hour of [8, 13, 21]) if (rand() < p) events.push(...sessionAround(rand, m, hour + (weekend(wd) ? 1 : 0), 0.75, { sends: 4 + Math.floor(rand() * 4), gapMin: 3 }));
    if (rand() < 0.5) events.push(...connector(rand, m, 9, 22, 1));
    return plan(events, [run(m, 7.5, 2), ...(wd === 0 ? [run(m, 18, 3)] : [])]);
  } },
  digest: { name: "P3 daily digest", plan(rand, m, wd) {
    const events: IntentEvent[] = [];
    for (const hour of [7.5, 18]) if (rand() < 0.7) events.push(...session(rand, clock(m, hour + pick(rand, 0.05, 0.33)), { sends: 1 + Math.floor(rand() * 2), gapMin: 3, kind: "connector" }));
    if (rand() < 0.15) events.push(...sessionAround(rand, m, 20, 1, { sends: 3, gapMin: 2 }));
    return plan(events, [run(m, 7.5, 2), run(m, 18, 2), ...(wd === 0 ? [run(m, 10, 3)] : [])]);
  } },
  power: { name: "P4 power user", plan(rand, m, wd) {
    const events: IntentEvent[] = [], sessions = 6 + Math.floor(rand() * 3);
    for (let i = 0; i < sessions; i++) events.push(...session(rand, clock(m, pick(rand, 8, 23)), { sends: 5 + Math.floor(rand() * 8), gapMin: 3, longShare: 0.15, away: 0.15 }));
    events.push(...connector(rand, m, 8, 22, weekend(wd) ? 5 : 15, 1));
    const runs = [run(m, 7, 2), run(m, 11, 1), run(m, 15, 1), run(m, 19, 1)];
    if (!weekend(wd)) runs.push(run(m, 9, 2), run(m, 13, 2), run(m, 17, 2), run(m, 8.75, 3));
    return plan(events, runs);
  } },
  monitor: { name: "P5 monitor-heavy", plan(rand, m) {
    const events: IntentEvent[] = [];
    for (let i = 0, n = 1 + Math.floor(rand() * 2); i < n; i++) events.push(...session(rand, clock(m, pick(rand, 8, 22)), { sends: 2, gapMin: 3 }));
    return plan(events, every(m, 15, 0, 24, 1));
  } },
  team: { name: "P6 team bot", plan(rand, m, wd) {
    const events = [...connector(rand, m, 9, 18, weekend(wd) ? 3 : 30, 1)];
    for (let i = 0, n = 1 + Math.floor(rand() * 2); i < n; i++) events.push(...sessionAround(rand, m, i ? 16 : 10, 1, { sends: 4, gapMin: 3, longShare: 0.15 }));
    return plan(events, weekend(wd) ? [] : [run(m, 9, 3), run(m, 17.5, 3)]);
  } },
  dormant: { name: "P7 dormant payer", plan(rand, m) {
    return plan(rand() < 1 / 7 ? sessionAround(rand, m, 19, 2, { sends: 4, gapMin: 3 }) : [], []);
  } },
  grok: { name: "P8 normal Grok-style user", plan(rand, m, wd) {
    const events: IntentEvent[] = [], late = weekend(wd) ? 1.5 : 0;
    for (const [hour, p] of [[8.5, 0.7], [12.5, 0.5], [20.5, 0.8]] as const) if (rand() < p) events.push(...sessionAround(rand, m, hour + late, 0.75, { sends: 4 + Math.floor(rand() * 6), gapMin: 2.5, longShare: 0.1 }));
    if (!weekend(wd)) events.push(...connector(rand, m, 9, 18, 2));
    // a daily digest, a price watch every two hours by day, a news monitor every six hours
    return plan(events, [run(m, 7, 2), ...every(m, 120, 8, 23, 1), ...every(m, 360, 0, 24, 1.5)]);
  } },
};

/** the research's illustrative mix, with the Grok-style user taking a share of the casual and normal ones */
export const MIX: ReadonlyArray<readonly [keyof typeof PERSONAS, number]> = [
  ["casual", 0.2], ["normal", 0.2], ["digest", 0.1], ["power", 0.1], ["monitor", 0.05], ["team", 0.05], ["dormant", 0.1], ["grok", 0.2],
];
