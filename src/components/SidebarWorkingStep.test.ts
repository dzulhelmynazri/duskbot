import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ value: { ended: false, status: null } as Record<string, unknown> }));
vi.mock("@/state/turn-status", () => ({ useTurnLive: () => live.value }));

import { SIDEBAR_WORD_MAX, SidebarWorkingStep, SidebarWorkingWord, sidebarWorkingWord, useWorkingLabel } from "./SidebarWorkingStep";
import { WORD_POOLS, funWords, poolWords, type PoolName } from "@/lib/friendly-activity";

const bot = { threadId: "trip", tasks: [{ threadId: "trip", title: "Trip", createdAt: 1, busy: true }] };
const Label = ({ working }: { working: boolean }) => useWorkingLabel(bot, working) ?? "none";

describe("the bot's own status label", () => {
  it("is what a working row says when the bot set one, and nothing otherwise", () => {
    live.value = { ended: false, status: { activity: "thinking" }, label: "  is drafting the itinerary " };
    expect(renderToStaticMarkup(createElement(Label, { working: true }))).toBe("is drafting the itinerary");
    expect(renderToStaticMarkup(createElement(Label, { working: false }))).toBe("none");
    expect(renderToStaticMarkup(createElement(SidebarWorkingStep, { bot }))).toContain(">is drafting the itinerary</span>");
    live.value = { ended: false, status: { activity: "thinking" }, label: " " };
    expect(renderToStaticMarkup(createElement(Label, { working: true }))).toBe("none");
    expect(renderToStaticMarkup(createElement(SidebarWorkingStep, { bot }))).not.toContain("drafting");
  });
});

describe("a working row's one short word", () => {
  it("is just a plain word in the sidebar, never the dots, and the phone list's has the mascot at work before it", () => {
    live.value = { ended: false, status: { activity: "web", itemId: "s1" } };
    const working = { ...bot, id: "b", color: "green" as const };
    const markup = renderToStaticMarkup(createElement(SidebarWorkingWord, { bot: working }));
    expect(markup).not.toContain("data-working-mascot");
    expect(markup).toContain(">Searching</span>");
    expect(markup).not.toMatch(/status-pulse|…/);
    expect(renderToStaticMarkup(createElement(SidebarWorkingWord, { bot: working, mascot: 20 }))).toContain("data-working-mascot");
  });

  it("never truncates: every word it can say fits the narrowest sidebar, and it is never a fun word", () => {
    const fun = new Set(funWords());
    const pools = Object.keys(WORD_POOLS) as PoolName[];
    const said = [
      sidebarWorkingWord(null, undefined),
      sidebarWorkingWord({ activity: "thinking" }, undefined),
      sidebarWorkingWord({ activity: "command", itemId: "c" }, undefined),
      sidebarWorkingWord({ activity: "web", itemId: "s" }, undefined),
      sidebarWorkingWord(null, undefined, { id: "m", role: "bot", kind: "activity", at: 1, tool: { name: "mcp__computer__screenshot" } }),
      sidebarWorkingWord(null, undefined, { id: "m", role: "bot", kind: "activity", at: 1, tool: { name: "mcp__composio__GOOGLECALENDAR_LIST_EVENTS" } }),
      ...pools.flatMap((name) => poolWords(name)).map((word) => sidebarWorkingWord(null, word)),
    ];
    for (const word of said) {
      expect(word.length, word).toBeLessThanOrEqual(SIDEBAR_WORD_MAX);
      expect(fun.has(word), word).toBe(false);
    }
    expect(sidebarWorkingWord(null, undefined)).toBe("Thinking");
    expect(sidebarWorkingWord(null, undefined, { id: "m", role: "bot", kind: "activity", at: 1, tool: { name: "mcp__madani__plan_launch" } }), "a step with no word of its own").toBe("Working");
    expect(sidebarWorkingWord({ activity: "thinking" }, "Booking flights"), "a short label of its own wins").toBe("Booking flights");
    expect(sidebarWorkingWord({ activity: "thinking" }, "Comparing every standing desk on the market"), "a long one gives way").toBe("Thinking");
  });
});
