import { describe, expect, it } from "vitest";
import { ASLEEP_MS, asleepFresh, FRESH_MS, LOOK_MS, sleptOnWork, workingBot } from "./asleep-work";

const bot = (id: string, busy: boolean, hidden = false) => ({ id, name: id, hidden, tasks: [{ busy }] });

describe("a bot working when this computer slept", () => {
  it("names the bot mid-task, a visible one first", () => {
    expect(workingBot([bot("a", false)])).toBeNull();
    expect(workingBot([bot("madani", true, true), bot("quill", true)])).toEqual({ botId: "quill", name: "quill" });
    expect(workingBot([bot("madani", true, true)])).toEqual({ botId: "madani", name: "madani" });
  });

  it("is a long gap in the app's clock with a bot working before it", () => {
    const working = { botId: "quill", name: "Quill" };
    expect(sleptOnWork({ at: 0, working }, LOOK_MS * 2)).toBeNull();
    expect(sleptOnWork({ at: 0, working: null }, ASLEEP_MS * 3)).toBeNull();
    expect(sleptOnWork({ at: 0, working }, ASLEEP_MS)).toEqual({ ...working, wokeAt: ASLEEP_MS });
  });

  it("goes stale hours after the wake", () => {
    const slept = { botId: "q", name: "Q", wokeAt: 1000 };
    expect(asleepFresh(slept, 1000 + FRESH_MS - 1)).toBe(slept);
    expect(asleepFresh(slept, 1000 + FRESH_MS)).toBeNull();
  });
});
