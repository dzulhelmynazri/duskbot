import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection } from "@muse-code/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { engineHomes } from "../engine-homes/engine-homes.ts";
import { audienceHome } from "../engine-homes/layout.ts";
import * as procs from "../procs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import {
  MuseCodeDriver, museApprovalMode, museCatalog, museChoice, museModelLabel, museQuestions, museServeArgs,
  museToolOutput, museToolStart,
} from "./muse-code.ts";
import { museMcpConfig } from "./muse-mcp.ts";
import { turnStdioMcpServers } from "./turn-mcp.ts";

const choices = [
  { choiceId: "c-once", label: "Allow once", decision: "approved", scope: "once" },
  { choiceId: "c-session", label: "Allow for this session", decision: "approvedForSession", scope: "session" },
  { choiceId: "c-abort", label: "Reject", decision: "abort", scope: "once" },
];

describe("Muse Code driver", () => {
  it("installs with Meta's installer, signs in with `muse login`, and starts on Muse Wonder", () => {
    expect(MuseCodeDriver.install?.command?.darwin).toBe("curl -fsSL https://dev.meta.ai/install.sh | bash");
    expect(MuseCodeDriver.install?.signInCommand).toBe("muse login");
    expect(MuseCodeDriver.defaultConfig()).toEqual({ cli: "muse" });
    expect(MuseCodeDriver.models.default).toBe("muse-wonder-1.0");
  });

  it("builds the picker from the account's own model list", () => {
    // Muse Code 1.4.9 without a sessionId: isActive marks a session's model, so it is false on every row.
    const listed = museCatalog({ models: [
      { modelId: "muse-wonder-1.0", displayLabel: "muse-wonder-1.0", isDefault: true, isActive: false, contextLimit: null },
      { modelId: "muse-wonder-full-1.0", displayLabel: "muse-wonder-full-1.0", isDefault: false, isActive: false },
      { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", isActive: false, contextLimit: 500_000 },
      { modelId: "muse-spark-1.3" }, { modelId: 7 }, null,
    ] });
    expect(listed).toEqual({ default: "muse-wonder-1.0", options: [
      { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", contextWindow: 1_048_576 },
      { id: "muse-wonder-full-1.0", label: "Muse Wonder Full 1.0", contextWindow: 1_048_576 },
      { id: "muse-spark-1.3", label: "Muse Spark 1.3", contextWindow: 500_000 },
    ] });
    expect(museCatalog({ models: [{ modelId: "muse-spark-1.3" }] }, "muse-next")?.default).toBe("muse-next");
    expect(museCatalog({ models: [] })).toBeNull();
    expect(museCatalog(null)).toBeNull();
    expect(museModelLabel("muse-spark-1.3-contributor")).toBe("Muse Spark 1.3 Contributor");
  });

  it("runs Full without asking or sandbox, and lets Muse ask on every other level", () => {
    expect(museApprovalMode("full")).toBe("allowAll");
    expect(museServeArgs("full")).toEqual(["serve", "--trust-workspace", "--disable-sandbox"]);
    for (const mode of ["ask", "auto", undefined] as const) {
      expect(museApprovalMode(mode)).toBe("promptUnmatched");
      expect(museServeArgs(mode)).toEqual(["serve", "--trust-workspace"]);
    }
  });

  it("answers an approval with the narrowest matching native choice", () => {
    expect(museChoice(choices, "allow")?.choiceId).toBe("c-once");
    expect(museChoice(choices, "allow", true)?.choiceId).toBe("c-session");
    // A shell ask offers no deny, only Reject.
    expect(museChoice(choices, "deny")?.choiceId).toBe("c-abort");
    expect(museChoice([...choices, { choiceId: "c-deny", label: "Deny", decision: "denied", scope: "once" }], "deny")?.choiceId).toBe("c-deny");
    expect(museChoice(choices.slice(2), "allow")).toBeUndefined();
  });

  it("shows a shell call as its command and reports its exit", () => {
    const item = { itemId: "i1", kind: "toolCall", status: "completed", tool: "bash", args: JSON.stringify({ command: "echo hi\nls" }), visibleOutput: "hi", exitCode: 0 };
    expect(museToolStart(item)).toMatchObject({ title: "bash", summary: "echo hi ls" });
    expect(museToolOutput(item)).toEqual({ ok: true, output: "hi" });
    expect(museToolOutput({ ...item, exitCode: 1 })).toMatchObject({ ok: false });
    expect(museToolOutput({ ...item, status: "failed", failureReason: "denied by policy", visibleOutput: undefined }))
      .toEqual({ ok: false, output: "denied by policy" });
    expect(museToolStart({ itemId: "i2", kind: "subagent", status: "inProgress", objective: "Review the diff" }).title).toBe("Review the diff");
  });

  it("turns Muse's questions into card questions keyed by Muse's ids", () => {
    const parsed = museQuestions([
      { id: "q1", header: "City", question: "Which city?", options: [{ label: "Pune" }, { label: "Mumbai" }], selection: { mode: "single" } },
      { id: "q2", header: "Days", question: "Which days?", options: [{ label: "Mon" }, { label: "Tue" }], selection: { mode: "multiple" } },
    ]);
    expect(parsed?.map(({ id, question }) => [id, question.question, question.multiSelect ?? false])).toEqual([
      ["q1", "Which city?", false], ["q2", "Which days?", true],
    ]);
    expect(museQuestions("nope")).toBeNull();
  });
});

const FAKE_MUSE_SERVE = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = (entry) => appendFileSync(process.env.FAKE_MUSE_LOG, JSON.stringify(entry) + "\\n");
log({ argv: process.argv.slice(2), home: process.env.HOME });
const { FAKE_MUSE_TURN, FAKE_MUSE_INTERRUPT, FAKE_MUSE_EXIT_DELAY_MS } = process.env;
const savedNames = process.env.FAKE_MUSE_SAVED_NAMES;
const resumeNames = process.env.FAKE_MUSE_RESUME_NAMES;
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
const input = createInterface({ input: process.stdin });
if (FAKE_MUSE_EXIT_DELAY_MS) input.on("close", () => setTimeout(() => process.exit(0), Number(FAKE_MUSE_EXIT_DELAY_MS)));
input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send({ id, result: { schema: { fingerprint: "sha256:fake" }, grantedCapabilities: savedNames ? ["sessionMcp"] : [] } });
  if (method === "model/list") return send({ id, result: { models: [{ modelId: "muse-fake-1.0", isDefault: true }] } });
  if (method === "session/read") {
    log({ method, params });
    return send({ id, ...(process.env.FAKE_MUSE_SESSION_READ ? JSON.parse(process.env.FAKE_MUSE_SESSION_READ)
      : { result: { session: { workspaceRoot: process.cwd() } } }) });
  }
  if (savedNames && ["session/start", "session/resume", "turn/start"].includes(method)) {
    log({ method, params });
    const occupied = JSON.parse(method === "session/resume" && resumeNames ? resumeNames : savedNames);
    if (Object.keys(params.config?.mcpServers ?? {}).some((name) => occupied.includes(name))) {
      return send({ id, error: { code: -32030, message: "session MCP server name conflicts with a host or plugin server",
        data: { kind: "commandRejected", reason: "session_mcp_name_conflict" } } });
    }
  }
  if (method === "session/resume" && process.env.FAKE_MUSE_RESUME_NOT_FOUND) {
    return send({ id, error: { code: -32020, message: "session not found", data: { kind: "sessionNotFound" } } });
  }
  if (method === "session/resume") {
    const workspaceRoot = process.env.FAKE_MUSE_RESUMED_WORKSPACE
      ?? JSON.parse(process.env.FAKE_MUSE_SESSION_READ ?? "{}").result?.session?.workspaceRoot ?? process.cwd();
    return send({ id, result: { commandId: params.commandId, session: { sessionId: params.sessionId, workspaceRoot } } });
  }
  if (method === "session/start") return send({ id, result: { session: { sessionId: "s-1", modelId: "muse-fake-1.0" } } });
  if (method === "turn/interrupt" && FAKE_MUSE_INTERRUPT === "refuse") {
    return send({ id, error: { code: -32000, message: "interrupt refused", data: { kind: "invalidState" } } });
  }
  if (method === "turn/interrupt" && FAKE_MUSE_INTERRUPT === "silent") return;
  send({ id, result: { commandId: params.commandId } });
  if (method !== "turn/start" || FAKE_MUSE_TURN === "hang") return;
  const { sessionId, commandId: turnId } = params;
  send({ method: "item/completed", params: { sessionId, item: { itemId: "m1", kind: "agentMessage", status: "completed", turnId, text: "hello" } } });
  send({ method: "turn/completed", params: { sessionId, turnId, terminal: "completed" } });
});
`;

describe("Muse Code's process", () => {
  let root = "";
  afterEach(async () => {
    engineHomes.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await removeTempDir(root);
  });

  const fakeMuse = () => {
    root = mkdtempSync(join(tmpdir(), "madani-muse-launch-"));
    const log = join(root, "launches.jsonl");
    writeFileSync(join(root, "fake-muse.mjs"), FAKE_MUSE_SERVE);
    const cli = join(root, process.platform === "win32" ? "muse.cmd" : "muse");
    const launcher = process.platform === "win32"
      ? `@"${process.execPath}" "%~dp0fake-muse.mjs" %*\r\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "fake-muse.mjs"))} "$@"\n`;
    writeFileSync(cli, launcher, { mode: 0o755 });
    vi.stubEnv("FAKE_MUSE_LOG", log);
    return { cli, log };
  };

  it.skipIf(process.platform === "win32")("starts through the shared launcher, in the conversation's engine home, and stops with the instance", async () => {
    const { cli, log } = fakeMuse();
    const home = join(root, "home");
    const dataDir = join(home, ".madanibot");
    mkdirSync(dataDir, { recursive: true });
    engineHomes.start({ dataDir, serverHome: home, audienceOf: () => "member:p_bob", threads: () => [], log: () => {} });
    const spawned = vi.spyOn(procs, "spawnCli");

    const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
      environment: { HOME: home }, config: MuseCodeDriver.decodeConfig({ cli }) });
    let engine: ReturnType<typeof procs.spawnCli> | undefined;
    try {
      const completed = new Promise<RuntimeEvent>((resolve) => instance.adapter.onEvent((event) => {
        if (event.type === "turn.completed") resolve(event);
      }));
      await engineHomes.within("t-bob", () => instance.adapter.sendTurn({ threadId: "t-bob", text: "hi", cwd: root }));
      expect(await completed).toMatchObject({ ok: true });

      const bot = spawned.mock.calls.findIndex((call) => call[3] === "bot");
      expect(bot).toBeGreaterThanOrEqual(0);
      expect(spawned.mock.calls[bot]![1]).toEqual(["serve", "--trust-workspace"]);
      expect(spawned.mock.calls[bot]![2]).toMatchObject({ cwd: root, box: { allowEnv: ["HOME"] } });
      engine = spawned.mock.results[bot]!.value;
      const launches = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; home: string });
      expect(launches.find((launch) => launch.argv.includes("--trust-workspace"))?.home).toBe(audienceHome(dataDir, "member:p_bob"));
    } finally {
      await instance.dispose();
    }
    expect(engine!.exitCode !== null || engine!.signalCode !== null).toBe(true);
  }, 20_000);

  describe("session MCP names", () => {
    const injected = { command: "fixture-mcp", args: ["serve"], env: { FIXTURE_MODE: "local", FIXTURE_FORMAT: "json" } };
    const remote = { type: "streamable-http", url: "https://example.invalid/mcp" };
    const retainedProject = { sentry: remote, sentry_madanibot: remote };
    const notFound = { error: { code: -32020, message: "session not found", data: { kind: "sessionNotFound" } } };
    const scenarios: Array<{
      name: string;
      saved: Record<string, unknown>;
      project?: Record<string, unknown>;
      linkedWorkspace?: boolean;
      legacyUser?: boolean;
      legacyProject?: Record<string, unknown>;
      resumeProject?: Record<string, unknown>;
      missingAt?: "read" | "resume";
      legacyNotFound?: boolean;
      scoped?: boolean;
      mounts: NonNullable<NonNullable<SendTurnInput["integrations"]>["custom"]>;
      expected: string[];
      resumeCursor?: string;
      system?: string;
      expectedSystem?: string;
    }> = [
      { name: "keeps a free name", saved: {}, mounts: { sentry: injected }, expected: ["sentry"] },
      { name: "reuses the same enabled stdio connection", saved: { sentry: { ...injected, env: { FIXTURE_FORMAT: "json", FIXTURE_MODE: "local" } } },
        mounts: { sentry: injected }, expected: [] },
      { name: "renames an injected connection with distinct settings", saved: { sentry: remote }, mounts: { sentry: injected },
        expected: ["sentry_madanibot"] },
      { name: "reserves names in legacy user settings", saved: { sentry: remote, sentry_madanibot: remote }, legacyUser: true,
        mounts: { sentry: injected }, expected: ["sentry_madanibot2"] },
      { name: "reuses equivalent legacy user settings", saved: { sentry: injected }, legacyUser: true,
        mounts: { sentry: injected }, expected: [] },
      { name: "reserves disabled names without reusing their connections", saved: { sentry: { ...injected, enabled: false } },
        mounts: { sentry: injected }, expected: ["sentry_madanibot"] },
      { name: "reserves names declared by the workspace", saved: {}, project: { sentry: remote },
        mounts: { sentry: injected }, expected: ["sentry_madanibot"] },
      { name: "checks the effective project entry before reusing a saved connection", saved: { sentry: injected },
        project: { sentry: remote, sentry_madanibot: remote }, mounts: { sentry: injected }, expected: ["sentry_madanibot2"] },
      { name: "resolves project overrides and suffixes through a linked workspace on resume", saved: { sentry: injected },
        project: { sentry: remote, sentry_madanibot: remote, sentry_madanibot2: remote }, linkedWorkspace: true,
        mounts: { sentry: injected }, expected: ["sentry_madanibot3"], resumeCursor: "s-1",
        system: "Use mcp__sentry__lookup.", expectedSystem: "Use mcp__sentry_madanibot3__lookup." },
      { name: "ignores the legacy key in a workspace", saved: {}, legacyProject: { sentry: remote },
        mounts: { sentry: injected }, expected: ["sentry"] },
      { name: "uses the modern workspace key when both are present", saved: {}, project: { sentry: remote },
        legacyProject: { sentry_madanibot: remote }, mounts: { sentry: injected }, expected: ["sentry_madanibot"] },
      { name: "keeps an empty modern workspace map empty when the legacy key has names", saved: {}, project: {},
        legacyProject: { sentry: remote }, mounts: { sentry: injected }, expected: ["sentry"] },
      { name: "skips occupied fallbacks and reserves all original injected names", saved: { sentry: remote, sentry_madanibot: remote, sentry_madanibot2: remote, metrics: remote },
        mounts: { sentry: injected, sentry_madanibot3: injected, metrics: injected }, expected: ["sentry_madanibot4", "sentry_madanibot3", "metrics_madanibot"] },
      { name: "uses the resolved names and tool references on resume", saved: { sentry: remote }, mounts: { sentry: injected, sentry_madanibot: injected },
        expected: ["sentry_madanibot2", "sentry_madanibot"], resumeCursor: "s-1",
        system: "Use mcp__sentry__lookup or mcp__sentry_madanibot__lookup. Unrelated: mcp__other__lookup.",
        expectedSystem: "Use mcp__sentry_madanibot2__lookup or mcp__sentry_madanibot__lookup. Unrelated: mcp__other__lookup." },
      { name: "uses the retained project instead of reusing its overridden user entry", saved: { sentry: injected },
        resumeProject: retainedProject, resumeCursor: "s-1", mounts: { sentry: injected }, expected: ["sentry_madanibot2"],
        system: "Use mcp__sentry__lookup.", expectedSystem: "Use mcp__sentry_madanibot2__lookup." },
      { name: "reserves a suffix from the retained workspace", saved: { sentry: remote },
        resumeProject: retainedProject, resumeCursor: "s-1", mounts: { sentry: injected }, expected: ["sentry_madanibot2"] },
      { name: "starts in the requested workspace when session read reports not found", saved: {}, project: { sentry: remote },
        missingAt: "read", resumeCursor: "s-1", mounts: { sentry: injected }, expected: ["sentry_madanibot"] },
      { name: "starts in the requested workspace on the compatible notFound kind", saved: {}, project: { sentry: remote },
        missingAt: "read", legacyNotFound: true, resumeCursor: "s-1", mounts: { sentry: injected }, expected: ["sentry_madanibot"] },
      { name: "rebuilds the requested mounts when the session disappears after reading it", saved: {}, project: { sentry: remote },
        resumeProject: retainedProject, missingAt: "resume", resumeCursor: "s-1", mounts: { sentry: injected }, expected: ["sentry_madanibot"],
        system: "Use mcp__sentry__lookup.", expectedSystem: "Use mcp__sentry_madanibot__lookup." },
      { name: "keeps the tool selection gate on a retained equivalent connection", saved: {}, resumeProject: { sentry: injected },
        scoped: true, resumeCursor: "s-1", mounts: { sentry: injected }, expected: ["sentry_madanibot"] },
    ];

    it.each(scenarios)("$name", async ({ saved, project, linkedWorkspace, legacyUser, legacyProject, resumeProject, missingAt, legacyNotFound, scoped, mounts, expected, resumeCursor, system, expectedSystem }) => {
      const { cli, log } = fakeMuse();
      const configHome = join(root, "config");
      mkdirSync(join(configHome, "muse"), { recursive: true });
      const settings = join(configHome, "muse", "settings.json");
      const contents = JSON.stringify({ schema_version: 1, [legacyUser ? "mcp_servers" : "mcpServers"]: saved });
      writeFileSync(settings, contents);
      const projectRoot = linkedWorkspace ? join(root, "repo") : root;
      let cwd = root;
      if (linkedWorkspace) {
        mkdirSync(join(projectRoot, ".git"), { recursive: true });
        const nested = join(projectRoot, "nested");
        mkdirSync(nested);
        cwd = join(root, "workspace");
        symlinkSync(nested, cwd, process.platform === "win32" ? "junction" : "dir");
      }
      const projectConfig = join(projectRoot, ".mcp.json");
      const projectContents = (project || legacyProject) && JSON.stringify({ mcpServers: project, mcp_servers: legacyProject });
      if (projectContents) writeFileSync(projectConfig, projectContents);
      const input: SendTurnInput = { threadId: "t-mcp", text: "hi", cwd, resumeCursor, system, integrations: { custom: mounts },
        ...(scoped ? { toolScope: { allow: ["mcp:sentry:lookup"] } } : {}) };
      const selected = scoped ? turnStdioMcpServers(input)[0] : undefined;
      const scopedMount = selected && { command: selected.command, args: selected.args, env: selected.env };
      const retained = join(root, "retained");
      const retainedContents = resumeProject && JSON.stringify({ mcpServers: scopedMount ? { sentry: scopedMount } : resumeProject });
      if (retainedContents) {
        mkdirSync(retained);
        writeFileSync(join(retained, ".mcp.json"), retainedContents);
        vi.stubEnv("FAKE_MUSE_RESUME_NAMES", JSON.stringify(Object.keys({ ...saved, ...resumeProject })));
        vi.stubEnv("FAKE_MUSE_SESSION_READ", JSON.stringify({ result: { session: { workspaceRoot: retained } } }));
      }
      if (missingAt === "read") vi.stubEnv("FAKE_MUSE_SESSION_READ", JSON.stringify(legacyNotFound
        ? { error: { ...notFound.error, data: { kind: "notFound" } } } : notFound));
      if (missingAt === "resume") vi.stubEnv("FAKE_MUSE_RESUME_NOT_FOUND", "1");
      vi.stubEnv("FAKE_MUSE_SAVED_NAMES", JSON.stringify(Object.keys({ ...saved, ...project })));
      const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
        environment: { HOME: root, XDG_CONFIG_HOME: configHome }, config: MuseCodeDriver.decodeConfig({ cli }) });
      try {
        const events: RuntimeEvent[] = [];
        const completed = new Promise<RuntimeEvent>((resolve) => instance.adapter.onEvent((event) => {
          events.push(event);
          if (event.type === "turn.completed") resolve(event);
        }));
        await instance.adapter.sendTurn(input);
        await completed;
        expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
        expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
        const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        const session = calls.find((call) => call.method === (resumeCursor && !missingAt ? "session/resume" : "session/start"));
        expect(Object.keys(session.params.config?.mcpServers ?? {})).toEqual(expected);
        for (const name of expected) {
          expect(session.params.config.mcpServers[name]).toEqual({ ...(scopedMount ?? injected), transport: "stdio", mode: "optional" });
        }
        const turn = calls.find((call) => call.method === "turn/start");
        expect(turn.params.input).toEqual([{ type: "text", text: expectedSystem ? `${expectedSystem}\n\nhi` : "hi" }]);
        const methods = calls.flatMap((call) => call.method ? [call.method] : []);
        if (resumeCursor) expect(calls.find((call) => call.method)).toMatchObject({ method: "session/read", params: { sessionId: resumeCursor, excludeItems: true } });
        if (missingAt === "read") expect(methods).toEqual(["session/read", "session/start", "turn/start"]);
        if (missingAt === "resume") {
          expect(methods).toEqual(["session/read", "session/resume", "session/start", "turn/start"]);
          const resume = calls.find((call) => call.method === "session/resume");
          expect(Object.keys(resume.params.config.mcpServers)).toEqual(["sentry_madanibot2"]);
        }
        expect(readFileSync(settings, "utf8")).toBe(contents);
        if (projectContents) expect(readFileSync(projectConfig, "utf8")).toBe(projectContents);
        if (retainedContents) expect(readFileSync(join(retained, ".mcp.json"), "utf8")).toBe(retainedContents);
      } finally {
        await instance.dispose();
      }
    });

    it.each([
      { name: "a session read error", reply: { error: { code: -32603, message: "fixture read failed", data: { kind: "internalError" } } }, hint: "could not read" },
      { name: "an unsupported metadata method", reply: { error: { code: -32601, message: "method not found", data: { kind: "methodNotFound" } } }, hint: "could not read" },
      { name: "invalid session read parameters", reply: { error: { code: -32602, message: "invalid sessionId", data: { kind: "invalidParams" } } }, hint: "could not read" },
      { name: "a missing workspace", reply: { result: { session: {} } }, hint: "saved session workspace" },
      { name: "a null workspace", reply: { result: { session: { workspaceRoot: null } } }, hint: "saved session workspace" },
      { name: "a relative workspace", reply: { result: { session: { workspaceRoot: "relative" } } }, hint: "saved session workspace" },
      { name: "an unavailable workspace", reply: undefined, hint: "saved session workspace" },
    ])("fails before mounting on $name", async ({ reply, hint }) => {
      const { cli, log } = fakeMuse();
      vi.stubEnv("FAKE_MUSE_SAVED_NAMES", "[]");
      vi.stubEnv("FAKE_MUSE_SESSION_READ", JSON.stringify(reply ?? { result: { session: { workspaceRoot: join(root, "missing") } } }));
      const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
        environment: { HOME: root, XDG_CONFIG_HOME: join(root, "config") }, config: MuseCodeDriver.decodeConfig({ cli }) });
      try {
        const events: RuntimeEvent[] = [];
        const completed = new Promise<RuntimeEvent>((resolve) => instance.adapter.onEvent((event) => {
          events.push(event);
          if (event.type === "turn.completed") resolve(event);
        }));
        await instance.adapter.sendTurn({ threadId: "t-mcp", text: "hi", cwd: root, resumeCursor: "s-1", integrations: { custom: { sentry: injected } } });
        expect(await completed).toMatchObject({ ok: false });
        expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining(hint) });
        const methods = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).method).filter(Boolean);
        expect(methods).toEqual(["session/read"]);
      } finally {
        await instance.dispose();
      }
    });

    it("fails before the turn when resume returns a different physical workspace", async () => {
      const { cli, log } = fakeMuse();
      const other = join(root, "other");
      mkdirSync(other);
      vi.stubEnv("FAKE_MUSE_SAVED_NAMES", "[]");
      vi.stubEnv("FAKE_MUSE_RESUMED_WORKSPACE", other);
      const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
        environment: { HOME: root, XDG_CONFIG_HOME: join(root, "config") }, config: MuseCodeDriver.decodeConfig({ cli }) });
      try {
        const events: RuntimeEvent[] = [];
        const completed = new Promise<RuntimeEvent>((resolve) => instance.adapter.onEvent((event) => {
          events.push(event);
          if (event.type === "turn.completed") resolve(event);
        }));
        await instance.adapter.sendTurn({ threadId: "t-mcp", text: "hi", cwd: root, resumeCursor: "s-1", integrations: { custom: { sentry: injected } } });
        expect(await completed).toMatchObject({ ok: false });
        expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("different workspace") });
        const methods = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).method).filter(Boolean);
        expect(methods).toEqual(["session/read", "session/resume"]);
      } finally {
        await instance.dispose();
      }
    });

    it.each([
      { methods: ["session/read"], reply: "success" },
      { methods: ["session/read"], reply: "sessionNotFound" },
      { methods: ["session/read"], reply: "notFound" },
      { methods: ["session/read", "session/resume"], reply: "sessionNotFound" },
      { methods: ["session/start"], reply: "success" },
      { methods: ["session/read", "session/resume", "session/start"], reply: "success" },
    ])("closes the host after Stop with $reply from $methods", async ({ methods, reply }) => {
      const { cli, log } = fakeMuse();
      const method = methods.at(-1);
      const resumeCursor = methods.includes("session/read") ? "s-1" : undefined;
      vi.stubEnv("FAKE_MUSE_SAVED_NAMES", "[]");
      if (methods.includes("session/resume")) {
        vi.stubEnv("FAKE_MUSE_RESUME_NOT_FOUND", "1");
      } else if (reply !== "success") {
        const error = reply === "sessionNotFound" ? notFound.error
          : { code: -32004, message: "session not found", data: { kind: "notFound" } };
        vi.stubEnv("FAKE_MUSE_SESSION_READ", JSON.stringify({ error }));
      }
      const spawned = vi.spyOn(procs, "spawnCli");
      let reachedReply!: () => void;
      let releaseReply!: () => void;
      const ready = new Promise<void>((resolve) => { reachedReply = resolve; });
      const released = new Promise<void>((resolve) => { releaseReply = resolve; });
      const request = Connection.prototype.request;
      vi.spyOn(Connection.prototype, "request").mockImplementation(function (this: Connection, requested, params) {
        const response = request.call(this, requested, params);
        if (requested !== method) return response;
        return response.finally(() => {
          reachedReply();
          return released;
        });
      });
      const command = vi.spyOn(Connection.prototype, "command");
      const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
        environment: { HOME: root, XDG_CONFIG_HOME: join(root, "config") }, config: MuseCodeDriver.decodeConfig({ cli }) });
      try {
        const completed = new Promise<RuntimeEvent>((resolve) => instance.adapter.onEvent((event) => {
          if (event.type === "turn.completed") resolve(event);
        }));
        await instance.adapter.sendTurn({ threadId: "t-mcp", text: "hi", cwd: root, resumeCursor, integrations: { custom: { sentry: injected } } });
        await ready;
        const index = spawned.mock.calls.findIndex((call) => call[3] === "bot");
        const closed = vi.fn();
        spawned.mock.results[index]!.value.once("close", closed);
        await instance.adapter.interruptTurn("t-mcp");
        expect(await completed).toMatchObject({ ok: false, stopReason: "interrupted" });
        releaseReply();
        await vi.waitFor(() => {
          expect(command.mock.calls.map(([called]) => called)).toEqual(methods.filter((called) => called !== "session/read"));
          expect(closed).toHaveBeenCalledOnce();
        }, { timeout: 5_000 });
        expect(instance.adapter.hasSession("t-mcp")).toBe(false);
        const wireMethods = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).method).filter(Boolean);
        expect(wireMethods).toEqual(methods);
      } finally {
        releaseReply();
        await instance.dispose();
      }
    });

    it.each([null, [], {}, { sentry: remote }].map((modern) => ({ modern })))("leaves conflicting user keys for Muse to reject with modern value $modern", ({ modern }) => {
      root = mkdtempSync(join(tmpdir(), "madani-muse-settings-"));
      const configHome = join(root, "config");
      mkdirSync(join(configHome, "muse"), { recursive: true });
      const settings = join(configHome, "muse", "settings.json");
      const contents = JSON.stringify({ schema_version: 1, mcpServers: modern, mcp_servers: { sentry: remote } });
      writeFileSync(settings, contents);
      const { config } = museMcpConfig([{ name: "sentry", ...injected }], root, { HOME: root, XDG_CONFIG_HOME: configHome }, true);
      expect(Object.keys(config?.mcpServers ?? {})).toEqual(["sentry"]);
      expect(readFileSync(settings, "utf8")).toBe(contents);
    });
  });

  describe.skipIf(process.platform === "win32")("Stop", () => {
    const runningTurn = async (interrupt: "ack" | "refuse" | "silent") => {
      const { cli } = fakeMuse();
      vi.stubEnv("FAKE_MUSE_TURN", "hang");
      vi.stubEnv("FAKE_MUSE_INTERRUPT", interrupt);
      const spawned = vi.spyOn(procs, "spawnCli");
      const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
        environment: {}, config: MuseCodeDriver.decodeConfig({ cli }) });
      const exited = () => {
        const bot = spawned.mock.calls.findIndex((call) => call[3] === "bot");
        const engine: ReturnType<typeof procs.spawnCli> = spawned.mock.results[bot]!.value;
        return engine.exitCode !== null || engine.signalCode !== null;
      };
      const settled: { started?: boolean; completed?: RuntimeEvent; hostExited?: boolean } = {};
      instance.adapter.onEvent((event) => {
        if (event.type === "turn.started") settled.started = true;
        if (event.type !== "turn.completed") return;
        settled.completed = event;
        settled.hostExited = exited();
      });
      await instance.adapter.sendTurn({ threadId: "t-stop", text: "work", cwd: root, approvalMode: "full" });
      await vi.waitFor(() => expect(settled.started).toBe(true));
      return { instance, settled, exited };
    };

    it("ends the host before it reports a turn stopped whose interrupt Muse refused", async () => {
      const { instance, settled } = await runningTurn("refuse");
      try {
        await instance.adapter.interruptTurn("t-stop");
        expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
        expect(settled.hostExited).toBe(true);
      } finally {
        await instance.dispose();
      }
    }, 20_000);

    it("waits for the same host shutdown when Stop is pressed again", async () => {
      vi.stubEnv("FAKE_MUSE_EXIT_DELAY_MS", "500");
      const { instance, settled, exited } = await runningTurn("refuse");
      try {
        const first = instance.adapter.interruptTurn("t-stop");
        await new Promise((resolve) => setTimeout(resolve, 50));
        await instance.adapter.interruptTurn("t-stop");
        expect(exited()).toBe(true);
        expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
        expect(settled.hostExited).toBe(true);
        await first;
      } finally {
        await instance.dispose();
      }
    }, 20_000);

    it("disposes only after a Stop's host shutdown ends", async () => {
      vi.stubEnv("FAKE_MUSE_EXIT_DELAY_MS", "500");
      const { instance, settled, exited } = await runningTurn("refuse");
      const stopped = instance.adapter.interruptTurn("t-stop");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await instance.dispose();
      expect(exited()).toBe(true);
      expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(settled.hostExited).toBe(true);
      await stopped;
    }, 20_000);

    it("ends the host when an acknowledged interrupt is never confirmed", async () => {
      const { instance, settled } = await runningTurn("ack");
      try {
        await instance.adapter.interruptTurn("t-stop");
        expect(settled.completed).toBeUndefined();
        await vi.waitFor(() => expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" }), { timeout: 8_000 });
        expect(settled.hostExited).toBe(true);
      } finally {
        await instance.dispose();
      }
    }, 20_000);

    it("waits for the shutdown of an acknowledged interrupt when Stop is pressed again", async () => {
      const { instance, settled } = await runningTurn("ack");
      try {
        await instance.adapter.interruptTurn("t-stop");
        await instance.adapter.interruptTurn("t-stop");
        expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
        expect(settled.hostExited).toBe(true);
      } finally {
        await instance.dispose();
      }
    }, 20_000);

    it("disposes after an acknowledged interrupt only once the host has ended", async () => {
      const { instance, settled } = await runningTurn("ack");
      await instance.adapter.interruptTurn("t-stop");
      await instance.dispose();
      expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(settled.hostExited).toBe(true);
    }, 20_000);

    it("ends the host before dispose reports a running turn stopped", async () => {
      const { instance, settled } = await runningTurn("ack");
      await instance.dispose();
      expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(settled.hostExited).toBe(true);
    }, 20_000);

    it("lets overlapping shutdowns and Stop wait for the same host shutdown", async () => {
      vi.stubEnv("FAKE_MUSE_EXIT_DELAY_MS", "500");
      const { instance, settled, exited } = await runningTurn("ack");
      const first = instance.adapter.stopAll();
      await Promise.all([instance.adapter.stopAll(), instance.adapter.interruptTurn("t-stop")]);
      expect(exited()).toBe(true);
      expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(settled.hostExited).toBe(true);
      await first;
      await instance.dispose();
    }, 20_000);

    it("ends the host when Muse never answers the interrupt", async () => {
      const { instance, settled } = await runningTurn("silent");
      try {
        await instance.adapter.interruptTurn("t-stop");
        expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
        expect(settled.hostExited).toBe(true);
      } finally {
        await instance.dispose();
      }
    }, 20_000);

    it("ends a host that finishes starting after Stop", async () => {
      const { cli } = fakeMuse();
      vi.stubEnv("FAKE_MUSE_INIT_DELAY_MS", "500");
      const spawned = vi.spyOn(procs, "spawnCli");
      const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
        environment: {}, config: MuseCodeDriver.decodeConfig({ cli }) });
      await instance.adapter.sendTurn({ threadId: "t-early", text: "hi", cwd: root });
      await vi.waitFor(() => expect(spawned.mock.calls.some((call) => call[3] === "bot")).toBe(true));
      const engine: ReturnType<typeof procs.spawnCli> = spawned.mock.results[spawned.mock.calls.findIndex((call) => call[3] === "bot")]!.value;
      try {
        await instance.adapter.interruptTurn("t-early");
        await instance.dispose();
        await vi.waitFor(() => expect(engine.exitCode !== null || engine.signalCode !== null).toBe(true), { timeout: 5_000 });
      } finally {
        engine.kill("SIGKILL");
      }
    }, 20_000);
  });
});
