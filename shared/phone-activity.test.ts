import { describe, expect, it } from "vitest";

import { nextTurnActivity, pushCategory, replyFirstLine, turnActivityStart, type TurnActivityEvent, type TurnActivityState } from "./phone-activity.ts";

const run = (events: TurnActivityEvent[], from: TurnActivityState = turnActivityStart(1000)) => events.reduce(nextTurnActivity, from);

describe("turn activity state", () => {
  it("counts steps and shows the running one", () => {
    expect(run([{ type: "step", activity: "web" }, { type: "step", activity: "read" }])).toEqual({ phase: "working", step: "read", steps: 2, startedAt: 1000 });
    expect(run([{ type: "step", activity: "web" }, { type: "thinking" }])).toEqual({ phase: "working", steps: 1, startedAt: 1000 });
  });

  it("waits on the person until their ask is answered, then works again", () => {
    const asked = run([{ type: "step", activity: "command" }, { type: "ask", kind: "approve", requestId: "r1" }]);
    expect(asked).toMatchObject({ phase: "needs-you", ask: { kind: "approve", requestId: "r1" } });
    expect(nextTurnActivity(asked, { type: "step", activity: "web" })).toBe(asked);
    expect(nextTurnActivity(asked, { type: "resolved", requestId: "other" })).toBe(asked);
    const resolved = nextTurnActivity(asked, { type: "resolved", requestId: "r1" });
    expect(resolved.phase).toBe("working");
    expect(resolved.ask).toBeUndefined();
  });

  it("returns the same state for an event that changes nothing", () => {
    const asked = run([{ type: "ask", kind: "answer", requestId: "r1" }]);
    expect(nextTurnActivity(asked, { type: "ask", kind: "answer", requestId: "r1" })).toBe(asked);
    const start = turnActivityStart(1000);
    expect(nextTurnActivity(start, { type: "thinking" })).toBe(start);
  });

  it("ends done or stopped and takes nothing after", () => {
    const done = run([{ type: "step", activity: "web" }, { type: "ask", kind: "approve", requestId: "r1" }, { type: "done", sealed: "s".repeat(90) }]);
    expect(done).toEqual({ phase: "done", steps: 1, startedAt: 1000, sealed: "s".repeat(90) });
    expect(nextTurnActivity(done, { type: "step", activity: "web" })).toBe(done);
    expect(run([{ type: "stopped" }, { type: "done" }]).phase).toBe("stopped");
  });

  it("cuts the reply to its first readable line", () => {
    expect(replyFirstLine("\n## Found **three** flights\nmore")).toBe("Found three flights");
    expect(replyFirstLine("- `a` item")).toBe("a item");
    expect([...replyFirstLine("x".repeat(300))]).toHaveLength(120);
  });
});

describe("push categories", () => {
  it("offers approve and deny only for an approval with its ask, reply only in a direct chat", () => {
    expect(pushCategory({ kind: "approval", requestId: "r" })).toBe("madani.approval");
    expect(pushCategory({ kind: "approval" })).toBeUndefined();
    expect(pushCategory({ kind: "question" })).toBe("madani.question");
    expect(pushCategory({ kind: "done" })).toBe("madani.message");
    expect(pushCategory({ kind: "mention", groupId: "g" })).toBeUndefined();
    expect(pushCategory({ kind: "spend" })).toBeUndefined();
  });
});
