import type { Case } from "./cases.ts";
import { familyOf, sendOf, type Call, type Send } from "./world.ts";

export type Step = { turn: number; kind: "call"; call: Call; result: string } | { turn: number; kind: "text"; text: string } | { turn: number; kind: "user"; text: string };
export interface Trace { caseId: string; steps: Step[]; turns: number; error?: string }

export const METRICS = ["destination", "tool", "steps", "asked", "focus", "draft"] as const;
export type Metric = (typeof METRICS)[number];
/** null: the metric does not apply to this case */
export type CaseScore = Record<Metric, boolean | null> & { pass: boolean; calls: number; sends: Array<Send & { turn: number }> };

const HOUSEKEEPING = new Set(["set_status"]);
const ASKS = /\?|\b(which|tell me|let me know|send me|paste|share)\b/i;

export function sendsIn(c: Case, trace: Trace): Array<Send & { turn: number }> {
  return trace.steps.flatMap((step) => {
    if (step.kind !== "call") return [];
    const send = sendOf(c.world, step.call);
    return send ? [{ ...send, turn: step.turn }] : [];
  });
}

const lastText = (trace: Trace, turn: number) => trace.steps.filter((s): s is Extract<Step, { kind: "text" }> => s.kind === "text" && s.turn === turn).map((s) => s.text).join("\n");

export function scoreCase(c: Case, trace: Trace): CaseScore {
  const calls = trace.steps.filter((s): s is Extract<Step, { kind: "call" }> => s.kind === "call" && !HOUSEKEEPING.has(s.call.name));
  const families = new Set(calls.map((s) => familyOf(s.call)));
  const sends = sendsIn(c, trace);
  const first = sends[0];
  const e = c.expect;
  const firstTurnSends = sends.filter((s) => s.turn === 1);
  const asked = firstTurnSends.length === 0 && (ASKS.test(lastText(trace, 1)) || calls.some((s) => s.turn === 1 && s.call.name === "show_widget"));

  let destination: boolean | null;
  if (e.destination === "any") destination = sends.every((s) => s.via !== "screen") ? true : false;
  else if (e.destination === "none") destination = sends.length === 0;
  else destination = !!first && first.to === e.destination && first.via !== "screen" && (!e.ask || first.turn > 1);

  const forbidden = (e.forbid ?? []).some((f) => families.has(f));
  const usedExpected = e.tool.some((f) => families.has(f));
  const delivered = !e.deliver || calls.some((s) => s.call.name === "attach_file");
  const tool = !forbidden && (usedExpected || e.ask === true) && delivered && !trace.error;
  const steps = calls.length <= e.budget;
  const askedScore = e.ask === undefined ? null : e.ask ? asked : !(asked && calls.filter((s) => s.turn === 1).every((s) => familyOf(s.call) === "madani"));
  const focus = e.files ? null : !families.has("files");
  const draft = e.draft ? !!first && first.turn > 1 && lastText(trace, first.turn - 1).length > 60 : null;

  const scores: Record<Metric, boolean | null> = { destination, tool, steps, asked: askedScore, focus, draft };
  return { ...scores, pass: METRICS.every((m) => scores[m] !== false), calls: calls.length, sends };
}

export interface Scorecard { cases: number; passed: number; metrics: Record<Metric, { pass: number; of: number }>; meanCalls: number }

export function scorecard(scores: CaseScore[]): Scorecard {
  const metrics = Object.fromEntries(METRICS.map((m) => {
    const applied = scores.filter((s) => s[m] !== null);
    return [m, { pass: applied.filter((s) => s[m] === true).length, of: applied.length }];
  })) as Scorecard["metrics"];
  const meanCalls = scores.length ? Math.round((scores.reduce((sum, s) => sum + s.calls, 0) / scores.length) * 10) / 10 : 0;
  return { cases: scores.length, passed: scores.filter((s) => s.pass).length, metrics, meanCalls };
}
