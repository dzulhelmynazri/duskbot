import { describe, expect, it } from "vitest";
import { toolTarget } from "./trail-events.ts";

describe("bot trail", () => {
  it("keeps a tool's host, never a path or free text", () => {
    expect(toolTarget("https://mail.google.com/mail/u/0/#inbox?x=1")).toBe("mail.google.com");
    expect(toolTarget("github.com")).toBe("github.com");
    expect(toolTarget("/Users/sidd/private/notes.md")).toBeUndefined();
    expect(toolTarget("notes.md")).toBeUndefined();
    expect(toolTarget("rm -rf my folder")).toBeUndefined();
    expect(toolTarget(undefined)).toBeUndefined();
  });
});

describe("runtime events in the trail", () => {
  it("a person's named send carries its id to the turn, and a tool keeps only its name, host and outcome", async () => {
    const { configureTrail } = await import("../electron/trail.mjs");
    const { traceRuntimeEvents } = await import("./trail-events.ts");
    const written: Array<Record<string, unknown>> = [];
    configureTrail({ src: "server", writer: { write: (event) => written.push(event), flush: async () => {}, flushSync() {}, close() {} } });
    let listener: (event: never) => void = () => {};
    const tracer = traceRuntimeEvents({ subscribe: (fn) => { listener = fn as never; } }, () => "b1");
    const base = { eventId: "e", provider: "claude", threadId: "t1", createdAt: "", turnId: "u1" };
    tracer.sendNamed("b1", "cid12345");
    listener({ ...base, type: "turn.started" } as never);
    listener({ ...base, type: "item.started", itemType: "tool", itemId: "i1", title: "browser_open", input: "secret input", step: { activity: "browse", target: "https://bank.example.com/login?u=me" } } as never);
    listener({ ...base, type: "item.completed", itemType: "tool", itemId: "i1", ok: true, output: "account 1234" } as never);
    listener({ ...base, type: "turn.completed", ok: true } as never);
    const events = written.filter((event) => String(event.ev).startsWith("bot."));
    expect(events.map((event) => event.ev)).toEqual(["bot.turn.start", "bot.tool", "bot.turn.end"]);
    expect(events[0]).toMatchObject({ cid: "cid12345", bot: "b1" });
    expect(events[2]).toMatchObject({ cid: "cid12345", ok: true });
    expect(events[1]).toMatchObject({ tool: "browser_open", host: "bank.example.com", ok: true });
    expect(JSON.stringify(events)).not.toMatch(/secret input|account 1234|login/);
  });
});

describe("a tool's name in the trail", () => {
  it("is the engine's tool name, never a command, script or file name its title carried", async () => {
    const { configureTrail } = await import("../electron/trail.mjs");
    const { traceRuntimeEvents, loggedToolName } = await import("./trail-events.ts");
    expect(loggedToolName("Bash", "echo hi", "command")).toBe("Bash");
    expect(loggedToolName("gws sheets get 1AbCdEfGhIjKlMn", "gws sheets get 1AbCdEfGhIjKlMn", "command")).toBe("shell");
    expect(loggedToolName("ls", "ls -la", "command")).toBe("shell");
    expect(loggedToolName("Read budget.xlsx", undefined, "read")).toBe("read");
    expect(loggedToolName("report.py", undefined, undefined)).toBe("tool");
    expect(loggedToolName("mcp__madani-browser__get_url", undefined, "fetch")).toBe("mcp__madani-browser__get_url");
    const written: Array<Record<string, unknown>> = [];
    configureTrail({ src: "server", writer: { write: (event) => written.push(event), flush: async () => {}, flushSync() {}, close() {} } });
    let listener: (event: never) => void = () => {};
    traceRuntimeEvents({ subscribe: (fn) => { listener = fn as never; } }, () => "b1");
    const base = { eventId: "e", provider: "antigravity", threadId: "t2", createdAt: "", turnId: "u2" };
    const command = "python3 export_sheet.py --sheet 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
    listener({ ...base, type: "item.started", itemType: "tool", itemId: "i2", title: command.slice(0, 80), summary: command } as never);
    listener({ ...base, type: "item.completed", itemType: "tool", itemId: "i2", ok: true } as never);
    listener({ ...base, type: "request.opened", requestType: "permission", requestId: "r1", tool: "cat ~/notes/diary.txt", summary: "cat", commandLine: "cat ~/notes/diary.txt" } as never);
    expect(written.find((event) => event.ev === "bot.tool")).toMatchObject({ tool: "shell" });
    expect(written.find((event) => event.ev === "bot.card.shown")).toMatchObject({ tool: "shell" });
    expect(JSON.stringify(written)).not.toMatch(/export_sheet|1BxiMVs0|python3|diary/);
  });
});
