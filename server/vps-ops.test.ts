import { DOCKER_NAMES } from "../electron/legacy-names.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectVpsOpsStatus, localDockerHost, parseVpsOpsArgs, redactOpsLogs, runOpsCommand, runVpsOps, type OpsCommandResult, type VpsOpsOptions } from "./vps-ops.ts";

const defaults = { port: 8799, dataDir: "/fixture/data" };
const options: VpsOpsOptions = { ...defaults, action: "status", service: "server", lines: 100, json: false };
const host = async () => ({ uptimeSeconds: 120, loadAverage: [0.1, 0.2, 0.3], memoryBytes: { free: 4 * 1024 ** 3, total: 8 * 1024 ** 3 }, diskBytes: { free: 12 * 1024 ** 3, total: 40 * 1024 ** 3 } });
const healthyFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ app: "madanibot" })));
const healthyCommand = vi.fn(async (command: string, args: string[]): Promise<OpsCommandResult> => command === "docker"
  ? { ok: true, stdout: "running\nexited\nrunning\n" }
  : { ok: true, stdout: `LoadState=loaded\nActiveState=active\nMainPID=${args[1] === "madanibot.service" ? 123 : 124}\nNRestarts=2\n` });

afterEach(() => vi.clearAllMocks());

describe("VPS operations arguments", () => {
  it("defaults to status and accepts bounded read-only operations", () => {
    expect(parseVpsOpsArgs([], defaults)).toMatchObject(options);
    expect(parseVpsOpsArgs(["doctor", "--json", "--port", "9000", "--data-dir", "/other"], defaults)).toMatchObject({ action: "doctor", json: true, port: 9000, dataDir: "/other" });
    expect(parseVpsOpsArgs(["logs", "--service", "link", "--lines", "500"], defaults)).toMatchObject({ action: "logs", service: "link", lines: 500 });
    expect(parseVpsOpsArgs(["--help"], defaults)).toMatchObject({ help: true });
  });

  it("rejects service names, shell fragments, invalid ports and unbounded log output", () => {
    for (const args of [["restart"], ["logs", "--follow"], ["logs", "--service", "../other"], ["logs", "--service", "server; reboot"], ["logs", "--lines", "0"], ["logs", "--lines", "501"], ["logs", "--lines", "1e2"], ["status", "--port", "70000"], ["status", "--port", "-1"], ["status", "--port"], ["doctor", "--service", "link"]]) {
      expect(parseVpsOpsArgs(args, defaults), args.join(" ")).toHaveProperty("error");
    }
    expect(parseVpsOpsArgs([], { ...defaults, port: NaN })).toHaveProperty("error");
  });
});

describe("VPS status", () => {
  it("starts independent checks without waiting for another subprocess to finish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const command = vi.fn(async () => { await gate; return { ok: true, stdout: "LoadState=not-found\n" }; });
    const request = vi.fn<typeof fetch>(async () => { await gate; return new Response('{"app":"madanibot"}'); });
    const collected = collectVpsOpsStatus(options, { command, fetch: request, host });
    expect(command).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenCalledTimes(1);
    release();
    await collected;
  });

  it("checks independent health, services and computers together and returns only selected properties", async () => {
    const report = await collectVpsOpsStatus(options, { command: healthyCommand, fetch: healthyFetch, host });
    expect(report.healthy).toBe(true);
    expect(report.services.server).toEqual({ unit: "madanibot.service", state: "active", pid: 123, restarts: 2 });
    expect(report.computers).toEqual({ available: true, count: 3, running: 2, states: { running: 2, exited: 1 } });
    expect(healthyFetch).toHaveBeenCalledWith("http://127.0.0.1:8799/api/health", expect.objectContaining({ signal: expect.any(AbortSignal), redirect: "error" }));
    expect(healthyCommand.mock.calls).toEqual(expect.arrayContaining([
      ["systemctl", ["show", "madanibot.service", "--no-pager", "--property=LoadState,ActiveState,MainPID,NRestarts"]],
      ["docker", ["--host", "unix:///var/run/docker.sock", "ps", "--all", "--filter", `label=${DOCKER_NAMES.label("vps")}=1`, "--format", "{{.State}}"]],
    ]));
  });

  it("still diagnoses stopped services when HTTP and Docker are unavailable", async () => {
    const command = vi.fn(async (name: string, args: string[]): Promise<OpsCommandResult> => name === "docker"
      ? { ok: false, stdout: "", error: "command failed or access denied" }
      : { ok: true, stdout: `LoadState=loaded\nActiveState=${args[1] === "madanibot.service" ? "failed" : "inactive"}\nNRestarts=7\nEnvironment=SECRET=value\n` });
    const report = await collectVpsOpsStatus(options, { command, fetch: async () => { throw new Error("fixture offline"); }, host });
    expect(report.healthy).toBe(false);
    expect(report.services.server.state).toBe("failed");
    expect(report.hints.join("\n")).toContain("--service server");
    expect(report.hints.join("\n")).toContain("--service link");
    expect(report.hints.join("\n")).toContain("--service fence");
    expect(report.hints.join("\n")).toContain("Docker");
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("refuses redirects, foreign health answers and uninspectable services", async () => {
    const command = async (): Promise<OpsCommandResult> => ({ ok: false, stdout: "", error: "check timed out" });
    const report = await collectVpsOpsStatus(options, { command, fetch: async () => new Response(JSON.stringify({ app: "other" })), host });
    expect(report.http).toMatchObject({ ready: false, error: "a different service answered" });
    expect(report.healthy).toBe(false);
    expect(report.services.link.state).toBe("unknown");
    const oversized = await collectVpsOpsStatus(options, { command, fetch: async () => new Response("x".repeat(4097)), host });
    expect(oversized.http).toMatchObject({ ready: false, error: "health response exceeded 4 KiB" });
  });

  it("allows optional uninstalled link and fence while reporting a healthy server", async () => {
    const report = await collectVpsOpsStatus(options, {
      command: async (command, args) => args[1] === "madanibot.service" || command === "docker" ? healthyCommand(command, args) : { ok: true, stdout: "LoadState=not-found\nActiveState=inactive\n" },
      fetch: healthyFetch, host,
    });
    expect(report.healthy).toBe(true);
    expect(report.services.link.state).toBe("not-installed");
  });

  it("reports degraded readiness when local computers cannot be inspected", async () => {
    const report = await collectVpsOpsStatus(options, {
      command: async (command, args) => command === "docker" ? { ok: false, stdout: "", error: "command failed or access denied" } : healthyCommand(command, args),
      fetch: healthyFetch, host,
    });
    expect(report.http.ready).toBe(true);
    expect(report.services.server.state).toBe("active");
    expect(report.healthy).toBe(false);
    expect(report.hints.join("\n")).toContain("Docker");
  });
});

describe("VPS operations output", () => {
  it("redacts keys, short passwords, env values, pairing links and private keys before tailing", () => {
    const text = redactOpsLogs([
      "started", "password: p!", 'details={"token":"fake-short-secret", "state":"ready"}',
      "Authorization: Bearer abc", 'CUSTOM_SETTING="private setting"',
      "ANTHROPIC_API_KEY=sk-ant-fake-fake-fake-fake-fake", "open https://link.example/i/fake-install-secret?code=ABCD-EFGH-JKLM",
      "-----BEGIN PRIVATE KEY-----", "fake-private-key-body", "-----END PRIVATE KEY-----", "ready\u001b[31m\u0000",
    ].join("\n"), 100);
    for (const secret of ["p!", "fake-short-secret", "Bearer abc", "private setting", "sk-ant-fake", "fake-install-secret", "ABCD-EFGH-JKLM", "fake-private-key-body", "\u001b", "\u0000"]) expect(text).not.toContain(secret);
    expect(text).toContain('"state":"ready"');
    expect(redactOpsLogs("first\nsecond\nthird\n", 2)).toBe("second\nthird");
    expect(redactOpsLogs("-----BEGIN PRIVATE KEY-----\npartial-secret", 1)).not.toContain("partial-secret");
  });

  it("uses only a fixed journal unit and bounded lines and prints redacted JSON", async () => {
    const io = { log: vi.fn(), error: vi.fn() };
    const command = vi.fn(async () => ({ ok: true, stdout: "secret=fake-secret\nconnected\n" }));
    expect(await runVpsOps({ ...options, action: "logs", service: "link", lines: 10, json: true }, io, { platform: "linux", command })).toBe(0);
    expect(command).toHaveBeenCalledWith("journalctl", ["--unit", "madanibot-link.service", "--lines", "10", "--no-pager", "--output=cat", "--quiet"]);
    expect(JSON.parse(io.log.mock.calls[0]![0])).toEqual({ unit: "madanibot-link.service", text: "secret=[redacted]\nconnected" });
  });

  it("does not turn missing journal permissions into a successful empty log", async () => {
    const io = { log: vi.fn(), error: vi.fn() };
    expect(await runVpsOps({ ...options, action: "logs" }, io, { platform: "linux", command: async () => ({ ok: true, stdout: "", stderr: "You are currently not seeing messages from other users and the system." }) })).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining("access is limited"));
  });

  it("redacts every cookie value and private key fragments whose opener is outside the journal tail", () => {
    const orphaned = redactOpsLogs("prior log\nMIIFakeSecretPrivateKeyBody\n-----END RSA PRIVATE KEY-----\nserver ready", 100);
    expect(orphaned).toBe("[private key fragment redacted]\nserver ready");
    const noMarkers = redactOpsLogs(`ready\n${"A".repeat(64)}\n${"B".repeat(43)}=\nlistening`, 100);
    expect(noMarkers).not.toContain("A".repeat(20));
    expect(noMarkers).not.toContain("B".repeat(20));
    const cookies = redactOpsLogs([
      "Cookie: session=first-secret; csrf=second-secret",
      "Set-Cookie: session=third-secret; Path=/; HttpOnly",
      '{"headers":{"cookie":"a=fourth-secret; b=fifth-secret"}}',
      "Proxy-Authorization: Basic short-secret",
      "ready",
    ].join("\n"), 100);
    for (const secret of ["first-secret", "second-secret", "third-secret", "fourth-secret", "fifth-secret", "short-secret"]) expect(cookies).not.toContain(secret);
    expect(cookies.split("\n")).toHaveLength(5);
    expect(cookies.endsWith("ready")).toBe(true);
  });

  it("keeps help available on every platform and refuses operations off Linux", async () => {
    const io = { log: vi.fn(), error: vi.fn() };
    const command = vi.fn();
    expect(await runVpsOps({ ...options, help: true }, io, { platform: "darwin", command })).toBe(0);
    expect(await runVpsOps(options, io, { platform: "darwin", command })).toBe(1);
    expect(command).not.toHaveBeenCalled();
  });
});

describe("bounded operations process runner", () => {
  it("executes argv without a shell and bounds time and output", async () => {
    expect(await runOpsCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "value; $(never-execute)"])).toMatchObject({ ok: true, stdout: "value; $(never-execute)" });
    const timedOut = await runOpsCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 80);
    expect(timedOut).toEqual({ ok: false, stdout: "", error: "check timed out" });
    const tooLarge = await runOpsCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000))"]);
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge.stdout).toBe("");
    expect(await runOpsCommand("madanibot-fixture-command-does-not-exist", [])).toMatchObject({ ok: false, error: "command not installed" });
  });
});

describe("the local docker socket", () => {
  it("is the gate's when DOCKER_HOST names a local socket, never a remote host", () => {
    expect(localDockerHost({})).toBe("unix:///var/run/docker.sock");
    expect(localDockerHost({ DOCKER_HOST: "unix:///run/madanibot-docker/docker.sock" })).toBe("unix:///run/madanibot-docker/docker.sock");
    expect(localDockerHost({ DOCKER_HOST: "tcp://10.0.0.5:2375" })).toBe("unix:///var/run/docker.sock");
    expect(localDockerHost({ DOCKER_HOST: "ssh://vps" })).toBe("unix:///var/run/docker.sock");
  });
});
