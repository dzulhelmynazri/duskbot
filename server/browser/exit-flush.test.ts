import { describe, expect, it } from "vitest";

import { BROWSERS_FLUSH, BROWSERS_FLUSHED, createBrowsersFlush, type BrowsersFlushReply } from "./exit-flush.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("browsers flush before exit", () => {
  it("answers once the browsers have quit, and says whether the app is surely going", async () => {
    const replies: BrowsersFlushReply[] = [];
    const flushed: boolean[] = [];
    let quit!: () => void;
    const flush = createBrowsersFlush({ flush: (final) => { flushed.push(final); return new Promise<void>((resolve) => { quit = resolve; }); }, reply: (message) => replies.push(message) });
    expect(flush.receive({ type: BROWSERS_FLUSH, requestId: "a1", final: true })).toBe(true);
    await tick();
    expect(flushed).toEqual([true]);
    expect(replies).toEqual([]);
    quit();
    await tick();
    expect(replies).toEqual([{ type: BROWSERS_FLUSHED, requestId: "a1", ok: true }]);
  });

  it("answers a failed close as not ok, and keeps answering later requests", async () => {
    const replies: BrowsersFlushReply[] = [];
    let calls = 0;
    const flush = createBrowsersFlush({ flush: async () => { if (calls++ === 0) throw new Error("stuck"); }, reply: (message) => replies.push(message), log: () => {} });
    flush.receive({ type: BROWSERS_FLUSH, requestId: "a", final: false });
    flush.receive({ type: BROWSERS_FLUSH, requestId: "b", final: true });
    for (let i = 0; i < 5; i++) await tick();
    expect(replies).toEqual([{ type: BROWSERS_FLUSHED, requestId: "a", ok: false }, { type: BROWSERS_FLUSHED, requestId: "b", ok: true }]);
  });

  it("ignores other messages and refuses a malformed id without closing anything", async () => {
    let calls = 0;
    const flush = createBrowsersFlush({ flush: async () => { calls++; }, reply: () => {} });
    expect(flush.receive({ type: "madanibot:something-else" })).toBe(false);
    expect(flush.receive(null)).toBe(false);
    expect(flush.receive({ type: BROWSERS_FLUSH, requestId: "../../x" })).toBe(true);
    await tick();
    expect(calls).toBe(0);
  });
});
