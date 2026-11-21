import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo] },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "cua-driver-unavailable", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
// the thread controls are not what this test is about
vi.mock("./ModelPicker", () => ({ ModelPicker: () => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: () => createElement("span") }));

// these cover live calls, which ship behind a switch that is off
vi.stubEnv("VITE_MADANI_LIVE_CALL", "1");
const { ChatView } = await import("./ChatView");
const { noteTurnEvent, resetTurnLive } = await import("@/state/turn-status");
const { resetLandedReplies } = await import("@/hooks/use-landed-reply");
afterAll(() => vi.unstubAllGlobals());

const message = (id: string, text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role: "user", kind: "text", text, at: 1_700_000_000_000, ...extra }) as Message;

const bot = (messages: Message[]): Bot => ({
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages,
  modelSelection: { instanceId: "test", model: "m" },
});

describe("via call label", () => {
  it("marks a request spoken on a Live call, and only that one", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, {
      bot: bot([message("m1", "typed words"), message("m2", "spoken words", { via: "call" })]),
    }));
    expect(markup).toContain("typed words");
    expect(markup).toContain("spoken words");
    expect(markup.match(/>Via call</g)).toHaveLength(1);
    expect(markup.indexOf(">Via call<")).toBeGreaterThan(markup.indexOf("spoken words"));
  });

  it("shows no label without a call", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: bot([message("m1", "typed words")]) }));
    expect(markup).toContain("typed words");
    expect(markup).not.toContain("Via call");
  });

  it("draws a finished call's row as its record, and keeps the spoken request inline", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, {
      bot: bot([
        message("m1", "spoken words", { via: "call", callId: "c1" }),
        message("r1", "call with Pepper · 0:42", {
          role: "bot",
          kind: "call",
          call: { callId: "c1", botId: "bot", client: "ios", startedAt: 1_700_000_000_000, endedAt: 1_700_000_042_000, seconds: 42, endReason: "hung-up" },
        }),
      ]),
    }));
    expect(markup).toContain('data-testid="call-record"');
    expect(markup).toContain("call with Pepper");
    expect(markup).toContain("spoken words");
    expect(markup.match(/>Via call</g)).toHaveLength(1);
    expect(markup).not.toContain("call with Pepper · 0:42");
  });
});

describe("a call's record at the end of a chat that is still working", () => {
  const record = message("r1", "call with Pepper · 0:42", {
    role: "bot",
    kind: "call",
    call: { callId: "c1", botId: "bot", client: "ios", startedAt: 1_700_000_000_000, endedAt: 1_700_000_042_000, seconds: 42, endReason: "hung-up" },
  });
  const spoken = message("m1", "run the tests", { via: "call", callId: "c1" });
  // each draw is a chat opened in the middle of its turn
  const drawWorking = (messages: Message[]) =>
    resetLandedReplies() ?? renderToStaticMarkup(createElement(ChatView, { bot: { ...bot(messages), busy: true } }));

  it("keeps naming the step that is running when the call ended under it", () => {
    const markup = drawWorking([
      spoken,
      message("a1", "", { role: "bot", kind: "activity", requestMessageId: "m1", tool: { name: "Bash", spoken: "running the tests", itemId: "item-a1" } }),
      record,
    ]);
    expect(markup).toContain('data-testid="call-record"');
    expect(markup).toContain("running the tests");
  });

  it("shows no working line for a reply that settled just before the call ended, once the turn has ended", () => {
    const settled = [spoken, message("b1", "All tests pass.", { role: "bot", requestMessageId: "m1" }), record];
    resetTurnLive();
    expect(drawWorking(settled), "the turn has not ended yet: the reply may be words mid-turn").toContain("data-turn-status");
    noteTurnEvent({ eventId: "end", provider: "claudeAgent", threadId: "t1", createdAt: "2026-10-23T12:00:00.000Z", turnId: "u1", type: "turn.completed", ok: true });
    const markup = drawWorking(settled);
    resetTurnLive();
    expect(markup).toContain("All tests pass.");
    expect(markup).not.toContain("data-turn-status");
  });

  it("draws a step with no outcome as running while the chat works, and not once it stops", () => {
    const work = [
      spoken,
      message("a1", "", { role: "bot", kind: "activity", requestMessageId: "m1", tool: { name: "Read", spoken: "Reading a file", itemId: "item-a1" } }),
      record,
    ];
    expect(drawWorking(work)).toContain('<span class="sr-only"> (Running)</span>');
    const stopped = renderToStaticMarkup(createElement(ChatView, { bot: bot(work) }));
    expect(stopped).toContain('data-testid="call-record"');
    expect(stopped).toContain("Reading a file");
    expect(stopped).not.toContain("(Running)");
  });

  it("still shows the working line for a request nobody has answered yet", () => {
    const markup = drawWorking([spoken, record]);
    expect(markup).toContain("data-turn-status");
  });
});

describe("a call's record in a chat whose older messages are not all loaded", () => {
  const spoken = message("m1", "run the tests", { via: "call", callId: "c1" });
  const step = message("a1", "", { role: "bot", kind: "activity", requestMessageId: "m1", tool: { name: "Bash", spoken: "running the tests", ok: true, itemId: "item-a1" } });
  const recordFrom = (startedAt: number) => message("r1", "call with Pepper · 4:10", {
    role: "bot",
    kind: "call",
    call: { callId: "c1", botId: "bot", client: "ios", startedAt, endedAt: 1_700_000_000_000, seconds: 250, endReason: "hung-up" },
  });
  const began = 1_700_000_000_000 - 250_000;
  const draw = (hasMore: boolean, earlier: Message[] = []) =>
    renderToStaticMarkup(createElement(ChatView, { bot: { ...bot([...earlier, spoken, step, recordFrom(began)]), hasMore } }));

  it("says its lines may be incomplete when the call began before the oldest loaded message", () => {
    const markup = draw(true);
    expect(markup).toContain('data-testid="call-record"');
    expect(markup).toContain("Some of this call may be in earlier messages");
  });

  it("says nothing once the whole conversation is loaded", () => {
    expect(draw(false)).not.toContain("Some of this call may be in earlier messages");
  });

  it("says nothing when the loaded messages reach back to before the call began, though older ones remain", () => {
    const typedEarlier = message("m0", "typed before the call", { at: began - 1_000 });
    expect(draw(true, [typedEarlier])).not.toContain("Some of this call may be in earlier messages");
  });
});
