// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/testing/quiet-canceled-animations";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";
import { STATUS_EXIT_MS, STATUS_HOLD_MS, STATUS_QUIET_MS } from "./TurnPresence";
import { STATUS_MOUNT_MS } from "@/hooks/use-reached";
import { TYPING_MIN_MS } from "@/hooks/use-typing-hold";
import { LINE_BACK_AFTER_REPLY_MS } from "@/lib/turn-tail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: null, instances: [{ instanceId: "test", driverKind: "claudeAgent", displayName: "Test", snapshot: { state: "available" }, models: { default: "profile-default", options: [] } } as unknown as InstanceInfo] },
    dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { renderTrigger: (state: { open: boolean }) => unknown }) => props.renderTrigger({ open: false }),
}));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => null, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: (_props: ComponentProps<typeof ModelPicker>) => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (_props: ComponentProps<typeof ApprovalModeSelector>) => createElement("span") }));

const { ChatView } = await import("./ChatView");
const { noteTurnEvent, resetTurnLive } = await import("@/state/turn-status");
const { resetLandedReplies } = await import("@/hooks/use-landed-reply");
const { noteSentTurn, resetSentTurns } = await import("@/state/sent-turn");

const THREAD = "selected";
const started = Date.UTC(2026, 9, 23, 12, 0, 0);
const busyBot = (messages: Message[], busy = true): Bot => ({
  id: "bot", threadId: THREAD, name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy, activity: busy ? "working" : "idle", turnStartedAt: busy ? started : undefined, messages,
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: THREAD, title: "Dashboard", createdAt: 1, busy, activity: busy ? "working" : "idle", turnStartedAt: busy ? started : undefined,
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "full" }],
});
const ask: Message = { id: "ask", role: "user", kind: "text", at: started, text: "Build me a sales dashboard" };
const intro: Message = { id: "intro", role: "bot", kind: "text", at: started + 5_000, text: "I'll build the dashboard now.", turnId: "t1" };

let seq = 0;
const engine = (event: Partial<RuntimeEvent>) => act(() => noteTurnEvent({
  eventId: `e${++seq}`, provider: "claudeAgent", threadId: THREAD, createdAt: new Date().toISOString(), turnId: "t1", ...event,
} as RuntimeEvent));

let host: HTMLDivElement;
let root: Root;
const render = (shown: Bot) => act(() => root.render(createElement(ChatView, { bot: shown })));
const line = () => host.querySelector(".turn-presence");
/** The line as it reads: the phrase fading out is not part of it. */
const statusLine = () => {
  const line = host.querySelector("[data-turn-status]")?.cloneNode(true) as HTMLElement | undefined;
  line?.querySelectorAll("[data-word-out]").forEach((node) => node.remove());
  return line?.textContent?.replace(/\s+/g, " ").trim() ?? null;
};

beforeEach(() => {
  vi.useFakeTimers({ now: started + 72_000 });
  resetTurnLive();
  resetLandedReplies();
  resetSentTurns();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the working line", () => {
  it("is the bot's mascot and one word, Thinking from the first frame: no dots, no seconds", () => {
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    expect(line()).not.toBeNull();
    expect(statusLine()).toBe("Thinking");
    expect(line()!.querySelector(".turn-status-mark [data-working-mascot]"), "the mascot before the word").not.toBeNull();
    expect(line()!.querySelector("[data-madani-mark]"), "no engine-drawn mark, so no dots").toBeNull();
    const row = line()!.firstElementChild as HTMLElement;
    expect([...row.classList]).toEqual(expect.arrayContaining(["h-9", "ps-2"]));
    expect(row.title).toMatch(/^Working · /);
    expect(line()!.querySelector("[data-turn-status] .status-shimmer")).not.toBeNull();
    const slot = () => host.querySelector(".turn-status-slot")!;
    expect(slot().classList).not.toContain("-mt-3");

    engine({ type: "item.completed", itemType: "assistant_text", text: intro.text! } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro]));
    expect(slot().classList, "under the bot's own bubble it sits close, as one more part of the reply").toContain("-mt-3");
    expect(line(), "the bubble takes the line's place as it lands").toBeNull();
    engine({ type: "turn.progress", activity: "write", itemId: "toolu_write", file: "index.html", bytes: 14 * 1024 + 300 } as Partial<RuntimeEvent>);
    expect(statusLine(), "a named step brings the line back under it at once").toBe("Writing code");
  });

  it("gives way to a landing reply, is back under it while the turn goes on, and leaves when it ends, its words fading in 140ms", () => {
    const reply: Message = { id: "reply", role: "bot", kind: "text", at: started + 9_000, text: "Fair, quiet day", turnId: "t1" };
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    render(busyBot([ask, reply]));
    expect(line(), "the reply takes the line's place even before the turn's end arrives").toBeNull();
    act(() => void vi.advanceTimersByTime(LINE_BACK_AFTER_REPLY_MS));
    expect(line(), "a turn still running a while later shows the line again").not.toBeNull();
    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    render(busyBot([ask, reply], false));
    expect(host.querySelector(".turn-status-out"), "the line fades out, its mascot with it").not.toBeNull();
    expect(host.querySelector('.turn-status-out [data-working-mascot]')).not.toBeNull();
    expect(host.querySelector('[data-working-mascot][data-mood="done"]'), "no happy hop under the message").toBeNull();
    act(() => void vi.advanceTimersByTime(STATUS_EXIT_MS));
    expect(line()).toBeNull();
  });

  it("comes 0.55 to 1.2 s after the send with the mascot saying Thinking at once, never the dots", () => {
    vi.setSystemTime(started);
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    expect(line(), "nothing at first").toBeNull();
    act(() => void vi.advanceTimersByTime(STATUS_MOUNT_MS.min - 50));
    expect(line()).toBeNull();
    act(() => void vi.advanceTimersByTime(STATUS_MOUNT_MS.max - STATUS_MOUNT_MS.min + 60));
    expect(line(), "then the line, with its word").not.toBeNull();
    expect(line()!.querySelector("[data-working-mascot]")).not.toBeNull();
    expect(statusLine()).toBe("Thinking");
    act(() => void vi.advanceTimersByTime(STATUS_QUIET_MS.max + 1_500));
    expect(line()!.querySelector("[data-madani-mark]"), "never the dots").toBeNull();
    expect(statusLine(), "words all along").not.toBe("");
  });

  // the owner's "hi": the server answered the send 6.9 s after Enter, and the bot showed nothing until then
  it("shows within 100 ms of a send from this window, and stays put when the server's turn arrives seconds later", () => {
    vi.setSystemTime(started);
    const sentAsk: Message = { ...ask, id: "optimistic-s1", sendId: "s1" };
    act(() => noteSentTurn(THREAD, "s1", started));
    render(busyBot([sentAsk], false));
    act(() => void vi.advanceTimersByTime(100));
    expect(line(), "the bot is at it the moment the bubble is").not.toBeNull();
    act(() => void vi.advanceTimersByTime(6_800));
    const shown = line();
    expect(shown).not.toBeNull();
    engine({ type: "turn.started" });
    act(() => root.render(createElement(ChatView, { bot: { ...busyBot([sentAsk]), turnStartedAt: started + 6_900 } })));
    expect(line(), "no gap and no second opening when the server's turn starts").toBe(shown);
    expect(host.querySelector(".turn-status-out")).toBeNull();
  });

  it("says a quiet turn's notice once, in the working row, not in the chat as well", () => {
    const quiet: Message = { id: "quiet", role: "bot", kind: "activity", at: started + 75_000,
      tool: { name: "notice: Waiting on the model, no reply for 75 s. Slow models can take a while.", ok: true } };
    engine({ type: "turn.started" });
    render(busyBot([ask, quiet]));
    act(() => void vi.advanceTimersByTime(STATUS_QUIET_MS.max + 10));
    expect(statusLine()).toContain("Waiting on the model");
    expect(host.textContent!.split("Waiting on the model").length - 1, "one place only").toBe(1);
  });

  it("opens with the bot's own words when it set them at once, as a specific label beats Thinking", () => {
    vi.setSystemTime(started);
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    engine({ type: "turn.progress", activity: "tool", tool: "set_status", label: "Comparing standing desks" } as Partial<RuntimeEvent>);
    engine({ type: "item.started", itemType: "tool", itemId: "w1", title: "WebSearch" } as Partial<RuntimeEvent>);
    act(() => void vi.advanceTimersByTime(STATUS_MOUNT_MS.max + 10));
    expect(statusLine()).toBe("Comparing standing desks");
  });

  it("says Writing while the reply comes, by the mascot, never the dots", () => {
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    engine({ type: "content.delta", streamKind: "assistant_text", delta: "Hi" } as Partial<RuntimeEvent>);
    expect(line()!.querySelector("[data-working-mascot]")).not.toBeNull();
    expect(statusLine()).toBe("Writing");
  });

  it("shows the bot's own label for its phase, and keeps it until it sets another", () => {
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    engine({ type: "turn.progress", activity: "tool", tool: "set_status", label: "Comparing keyboard reviews" } as Partial<RuntimeEvent>);
    expect(statusLine()).toBe("Comparing keyboard reviews");
    engine({ type: "item.started", itemType: "tool", itemId: "w1", title: "WebSearch" } as Partial<RuntimeEvent>);
    engine({ type: "item.completed", itemType: "tool", itemId: "w1", ok: true } as Partial<RuntimeEvent>);
    expect(statusLine()).toBe("Comparing keyboard reviews");
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    engine({ type: "turn.progress", activity: "tool", tool: "set_status", label: "Drafting the summary" } as Partial<RuntimeEvent>);
    expect(statusLine()).toBe("Drafting the summary");
    expect(host.querySelector("[data-turn-now]")?.classList, "a new label crossfades in place, it does not rise").not.toContain("turn-label-in");
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    render(busyBot([ask], false));
    expect(host.querySelector(".turn-status-out"), "It leaves").not.toBeNull();
    expect(statusLine(), "with the bot's own words, not a stock phrase").toBe("Drafting the summary");
  });
});

describe("each bubble's typing beat", () => {
  const fresh = (id: string, text: string): Message => ({ id, role: "bot", kind: "text", at: Date.now(), text, turnId: "t1" });
  const rows = () => [...host.querySelectorAll("[data-mid]")].map((row) => row.getAttribute("data-mid"));

  it("holds each bubble 500ms for its typing beat, the line staying for the turn", () => {
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    const ack = fresh("ack", "On it, checking reviews now.");
    render(busyBot([ask, ack]));
    expect(rows(), "held while the line types").toEqual(["ask"]);
    expect(statusLine(), "a short turn keeps its one phrase while the bubble types").toBe("Thinking");
    act(() => void vi.advanceTimersByTime(TYPING_MIN_MS - 10));
    expect(rows()).toEqual(["ask"]);
    act(() => void vi.advanceTimersByTime(10));
    expect(rows()).toEqual(["ask", "ack"]);
    expect(line(), "the bubble takes the line's place").toBeNull();
    act(() => void vi.advanceTimersByTime(LINE_BACK_AFTER_REPLY_MS));
    expect(line(), "and the line is back under it for the rest of the turn").not.toBeNull();
    expect(statusLine()).not.toBe("typing…");
  });

  it("gives two bubbles that come together a typing beat each", () => {
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    render(busyBot([ask, fresh("one", "First."), fresh("two", "Second.")]));
    act(() => void vi.advanceTimersByTime(TYPING_MIN_MS));
    expect(rows()).toEqual(["ask", "one"]);
    expect(statusLine(), "a short turn keeps its one phrase").toBe("Thinking");
    act(() => void vi.advanceTimersByTime(TYPING_MIN_MS));
    expect(rows()).toEqual(["ask", "one", "two"]);
  });

  it("ends a turn with the last bubble taking the line's place in the same frame, with nothing of the line under it", () => {
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    const last = fresh("last", "It's 441, so yes.");
    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    render(busyBot([ask, last], false));
    expect(statusLine(), "a short turn keeps its one phrase").toBe("Thinking");
    expect(rows()).toEqual(["ask"]);
    act(() => void vi.advanceTimersByTime(TYPING_MIN_MS));
    expect(rows()).toEqual(["ask", "last"]);
    expect(line(), "no line fading out below the reply").toBeNull();
    expect(host.querySelector("[data-turn-status]")).toBeNull();
    const bubble = host.querySelector('[data-mid="last"] [data-chat-bubble]');
    act(() => void vi.advanceTimersByTime(STATUS_EXIT_MS));
    expect(line()).toBeNull();
    expect(host.querySelector('[data-mid="last"] [data-chat-bubble]'), "the reply stays the same node").toBe(bubble);
  });

  it("never holds back the person's own words", () => {
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    const mine: Message = { id: "mine", role: "user", kind: "text", at: Date.now(), text: "also flag fraud" };
    render(busyBot([ask, fresh("ack", "On it."), mine]));
    expect(rows()).toEqual(["ask", "ack", "mine"]);
  });
});

describe.each(["desktop", "phone"] as const)("the reply landing where the line was, on the %s", (layout) => {
  const fresh = (id: string, text: string): Message => ({ id, role: "bot", kind: "text", at: Date.now(), text, turnId: "t1" });
  /** The transcript's rows and the line's slot, top to bottom. */
  const order = () => [...host.querySelectorAll("[data-mid], .turn-status-slot")].map((el) =>
    el.classList.contains("turn-status-slot") ? (el.querySelector("[data-turn-status]") ? "line" : "slot") : el.getAttribute("data-mid"));
  beforeEach(() => { if (layout === "phone") document.documentElement.dataset.mobileApp = "ios"; });
  afterEach(() => { delete document.documentElement.dataset.mobileApp; });

  it("thinks in the slot right under the person's message, and the reply takes that slot even before the turn's end arrives", () => {
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    expect(order()).toEqual(["ask", "line"]);
    render(busyBot([ask, fresh("reply", "Three flats are under budget.")]));
    act(() => void vi.advanceTimersByTime(TYPING_MIN_MS));
    expect(order(), "the reply in the line's place, nothing of the line under it").toEqual(["ask", "reply", "slot"]);
    expect(host.querySelector(".turn-status-out"), "no line fading on under the new bubble").toBeNull();
    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    render(busyBot([ask, fresh("reply", "Three flats are under budget.")], false));
    expect(order()).toEqual(["ask", "reply", "slot"]);
  });

  it("lets a line under an earlier bubble of the turn fade out when the turn ends", () => {
    engine({ type: "turn.started" });
    const ack = fresh("ack", "On it.");
    render(busyBot([ask]));
    render(busyBot([ask, ack]));
    act(() => void vi.advanceTimersByTime(TYPING_MIN_MS));
    act(() => void vi.advanceTimersByTime(LINE_BACK_AFTER_REPLY_MS));
    expect(order()).toEqual(["ask", "ack", "line"]);
    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    render(busyBot([ask, ack], false));
    expect(host.querySelector(".turn-status-out"), "it leaves as on the desktop, not cut in one frame").not.toBeNull();
  });
});

describe("the line's people", () => {
  it("says Teammates working while the bot waits on its teammates", () => {
    const waiting = busyBot([ask, intro], false);
    render({ ...waiting, waitingForTeammates: true, tasks: waiting.tasks!.map((task) => ({ ...task, waitingForTeammates: true })) });
    act(() => void vi.advanceTimersByTime(STATUS_QUIET_MS.max));
    expect(statusLine()).toBe("Teammates working");
  });
});

describe("the mascot and its status line through a long turn", () => {
  it("hides while the bot waits on the person, and the next turn starts clean", () => {
    engine({ type: "turn.progress", activity: "edit", itemId: "toolu_edit", file: "app.ts", bytes: 2048 } as Partial<RuntimeEvent>);
    const asking = busyBot([ask, intro]);
    render({ ...asking, activity: "waiting-on-you", tasks: asking.tasks!.map((task) => ({ ...task, activity: "waiting-on-you" })) });
    expect(line()).toBeNull();

    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    const next: Message = { id: "next", role: "user", kind: "text", at: started + 90_000, text: "Add a chart" };
    render(busyBot([ask, intro, next]));
    expect(line(), "a new prompt shows the line before the new turn's first frame").not.toBeNull();
  });
});

describe("what the bot is doing right now", () => {
  const search: Message = { id: "search", role: "bot", kind: "activity", at: started + 4_000, turnId: "t1",
    tool: { name: "WebSearch", itemId: "s1", ok: true, step: { activity: "web", target: "Acme construction leads" } } };
  const bash: Message = { id: "bash", role: "bot", kind: "activity", at: started + 6_000, turnId: "t1",
    tool: { name: "Bash", itemId: "b1", step: { activity: "command", target: "scrape.py", detail: "python3 scrape.py --pages 40" } } };
  const toggle = () => host.querySelector<HTMLButtonElement>(".turn-presence button[aria-expanded]");
  const steps = () => [...host.querySelectorAll("[data-now-step]")].map((step) => `${step.getAttribute("data-now-step")}: ${step.querySelector("[dir=auto]")?.textContent}`);

  it("is one calm line with no steps to unfold, as grok shows none in the chat", () => {
    engine({ type: "turn.started" });
    engine({ type: "item.started", itemType: "tool", itemId: "b1", title: "Bash" } as Partial<RuntimeEvent>);
    engine({ type: "turn.progress", activity: "command", itemId: "b1", target: "scrape.py", quiet: { kind: "idle" } } as Partial<RuntimeEvent>);
    render(busyBot([ask, search, bash]));
    expect(statusLine(), "a chat opened mid-turn says the step at once").toBe("Running a command · Idle, no output yet");
    expect(toggle(), "the step list unfolds only with tool calls shown").toBeNull();
    expect(steps()).toEqual([]);
  });
});
