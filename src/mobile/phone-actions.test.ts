import { describe, expect, it } from "vitest";

import { phoneActionFrom } from "./phone-actions";

const madani = { madani: { id: "n1", kind: "approval", botId: "b1", threadId: "t1", requestId: "req-1" }, aps: { category: "madani.approval" } };

describe("phone actions", () => {
  it("approves or denies the exact ask, from the bot host's or the relay's block", () => {
    expect(phoneActionFrom({ actionId: "madani.approve", data: madani })).toEqual({ kind: "decide", target: { botId: "b1", threadId: "t1" }, requestId: "req-1", behavior: "allow" });
    expect(phoneActionFrom({ actionId: "madani.deny", data: { omb: madani.madani } })).toMatchObject({ kind: "decide", behavior: "deny" });
  });

  it("takes a Live Activity's ids at the top level", () => {
    expect(phoneActionFrom({ actionId: "madani.approve", data: { botId: "b1", threadId: "t1", requestId: "r2" } })).toMatchObject({ kind: "decide", requestId: "r2" });
  });

  it("opens the chat when the ask id is missing, for Answer, and for a plain tap", () => {
    expect(phoneActionFrom({ actionId: "madani.approve", data: { madani: { botId: "b1", threadId: "t1" } } })).toEqual({ kind: "open", target: { botId: "b1", threadId: "t1" } });
    expect(phoneActionFrom({ actionId: "madani.answer", data: madani })?.kind).toBe("open");
    expect(phoneActionFrom({ actionId: "tap", data: { madani: { groupId: "g1", threadId: "t2" } } })).toEqual({ kind: "open", target: { groupId: "g1", threadId: "t2" } });
  });

  it("replies with the typed text in a bot's own chat, never into a room", () => {
    expect(phoneActionFrom({ actionId: "madani.reply", inputValue: "  thanks  ", data: madani })).toEqual({ kind: "reply", target: { botId: "b1", threadId: "t1" }, text: "thanks" });
    expect(phoneActionFrom({ actionId: "madani.reply", inputValue: "   ", data: madani })?.kind).toBe("open");
    expect(phoneActionFrom({ actionId: "madani.reply", inputValue: "hi", data: { madani: { botId: "b1", groupId: "g1", threadId: "t1" } } })?.kind).toBe("open");
  });

  it("ignores data it cannot route", () => {
    expect(phoneActionFrom({ actionId: "madani.approve", data: {} })).toBeNull();
    expect(phoneActionFrom({ actionId: "madani.approve", data: { madani: { botId: "b/1", threadId: "t1" } } })).toBeNull();
  });
});
