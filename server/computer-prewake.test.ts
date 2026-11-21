import { describe, expect, it, vi } from "vitest";
import { lastTurnUsedComputer, prewakeComputer, rememberComputerTurn, shouldPrewakeComputer, takeComputerLikely, type ComputerPrewakeInput } from "./computer-prewake.ts";
import { ComputerToolLists, createComputerRelay, type RelayBridge } from "./vps-computer-relay.ts";

const owner = { threadId: "thread", generation: "turn" };
const input: ComputerPrewakeInput = { place: "auto", ownComputer: true, enabled: true, message: "hello", history: [] };
const row = (id: string, turnId: string, tool?: string) => ({ id, turnId, role: "bot" as const, kind: "activity" as const, ...(tool ? { tool: { name: tool } } : {}) });

function mockRelay(asleep = true) { return { asleep: vi.fn(() => asleep), wake: vi.fn(async () => {}) }; }

describe("computer prewake", () => {
  it.each(["computer", "browser", "open", "website", "app", "tab", "screen", "download"])("wakes for %s without waiting", (keyword) => {
    const relay = mockRelay();
    relay.wake.mockImplementation(() => new Promise(() => {}));
    expect(prewakeComputer(relay, owner, { ...input, message: `Please ${keyword.toUpperCase()} now` })).toBeUndefined();
    expect(relay.wake).toHaveBeenCalledWith(owner);
  });

  it.each(["local", "vm", "off"] as const)("does not wake for the %s place", (place) => {
    const relay = mockRelay();
    prewakeComputer(relay, owner, { ...input, place, message: "open browser" });
    expect(relay.wake).not.toHaveBeenCalled();
  });

  it("skips unrelated chat, shared computers, disabled lifecycle and awake computers", () => {
    for (const override of [{}, { message: "application table" }, { message: "open", ownComputer: false }, { message: "open", enabled: false }]) {
      const relay = mockRelay();
      prewakeComputer(relay, owner, { ...input, ...override });
      expect(relay.wake).not.toHaveBeenCalled();
    }
    const relay = mockRelay(false);
    prewakeComputer(relay, owner, { ...input, message: "open" });
    expect(relay.wake).not.toHaveBeenCalled();
  });

  it("uses only the previous turn, including computer shell tools and persisted history", () => {
    const history = [row("1", "old", "mcp__computer__click"), row("2", "last", "computer_computer_exec"), row("3", "last")];
    expect(lastTurnUsedComputer(history)).toBe(true);
    const relay = mockRelay();
    prewakeComputer(relay, owner, { ...input, place: "cloud", history });
    expect(relay.wake).toHaveBeenCalledOnce();
    expect(lastTurnUsedComputer([...history, row("4", "new", "mcp__browser__navigate")])).toBe(false);
    expect(lastTurnUsedComputer([...history, row("4", "new", "Read")])).toBe(false);
    expect(lastTurnUsedComputer([...history, { id: "now", role: "user", kind: "text" }], "now")).toBe(true);
  });

  it("remembers the bot's last turn across threads and clears an older computer hint", () => {
    const botId = "cross-thread-fixture";
    rememberComputerTurn(botId, [row("other-thread", "other-turn", "mcp__computer__click")], "other-turn");
    const relay = mockRelay();
    prewakeComputer(relay, owner, { ...input, botId });
    expect(relay.wake).toHaveBeenCalledOnce();
    rememberComputerTurn(botId, [row("text-only", "newer-turn")], "newer-turn");
    prewakeComputer(relay, owner, { ...input, botId, history: [row("old-thread", "old-turn", "click")] });
    expect(relay.wake).toHaveBeenCalledOnce();
  });

  it("tells the turn being set up, once, whether its bot will likely use the computer", () => {
    shouldPrewakeComputer({ ...input, botId: "likely", message: "open madani.bot" });
    shouldPrewakeComputer({ ...input, botId: "unlikely", message: "what is 2 + 2" });
    expect([takeComputerLikely("likely"), takeComputerLikely("likely"), takeComputerLikely("unlikely"), takeComputerLikely("never")]).toEqual([true, false, false, false]);
  });

  it("absorbs a failed background wake", async () => {
    const relay = mockRelay();
    relay.wake.mockRejectedValue(new Error("offline"));
    prewakeComputer(relay, owner, { ...input, message: "open" });
    await Promise.resolve();
    expect(relay.wake).toHaveBeenCalledOnce();
  });

  it("shares one in-flight wake with a later real relay call", async () => {
    let resolve!: (bridge: RelayBridge) => void;
    const wake = vi.fn(() => new Promise<RelayBridge>(done => { resolve = done; }));
    const request = vi.fn(async () => ({ result: { content: [] } }));
    const relay = createComputerRelay({ lists: new ComputerToolLists(), open: () => ({ closed: false, request, close() {} }) });
    relay.open(owner, { bridge: () => null, wake, toolsKey: "fixture" });
    prewakeComputer(relay, owner, { ...input, message: "open browser" });
    const call = relay.request(owner, { method: "tools/call", params: { name: "screenshot" } });
    expect(wake).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    resolve({ command: "fixture", args: [], env: {} });
    expect(await call).toEqual({ result: { content: [] } });
    expect(wake).toHaveBeenCalledOnce();
    relay.close(owner);
  });

  it("keeps the original wake budget when a tool arrives later", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async () => ({ result: {} }));
      const relay = createComputerRelay({ lists: new ComputerToolLists(), budgetMs: 120_000,
        open: () => ({ closed: false, request, close() {} }) });
      relay.open(owner, { bridge: () => null, wake: () => new Promise(() => {}), toolsKey: "fixture" });
      prewakeComputer(relay, owner, { ...input, message: "open" });
      await vi.advanceTimersByTimeAsync(100_000);
      const call = relay.request(owner, { method: "tools/call", params: { name: "screenshot" } });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await call).toMatchObject({ error: expect.stringContaining("still starting") });
      expect(request).not.toHaveBeenCalled();
      relay.close(owner);
    } finally { vi.useRealTimers(); }
  });
});
