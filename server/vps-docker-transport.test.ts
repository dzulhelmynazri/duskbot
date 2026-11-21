import { describe, expect, it, vi } from "vitest";
import { COMPUTER_UNREACHABLE, plainComputerFailure } from "../shared/computer-unreachable.ts";
import { failedTurnTool, failedTurnCause } from "../shared/failed-turn.ts";
import { computerSkippedNote, continuesWithoutComputer } from "./surface.ts";
import { SERVER_REPAIR_COMMAND, dockerUnreachableProblem, gateDockerHost, isGateSocket, isTransientDockerTransport, retryTransient } from "./vps-docker-transport.ts";

const GATE_EOF = 'error during connect: Get "http://%2Frun%2Fopenmausbot-docker%2Fdocker.sock/v1.56/images/ghcr.io/madanibotai/madani-desktop:v6/json": EOF';
const RAW = `Docker over SSH failed while checking the VPS: ${GATE_EOF}`;

describe("docker transport failures on a VPS", () => {
  it("reads a dropped gate connection, a restarting gate or daemon and the gate's own 502 as transient", () => {
    for (const message of [
      GATE_EOF,
      "Cannot connect: dial unix /run/madanibot-docker/docker.sock: connect: no such file or directory",
      "dial unix /run/madanibot-docker/docker.sock: connect: connection refused",
      "Error response from daemon: docker gate: docker closed the connection before answering; try again",
      "Docker-over-SSH command timed out",
      "read: connection reset by peer",
    ]) expect(isTransientDockerTransport(message), message).toBe(true);
    for (const message of ["Permission denied (publickey)", "Error response from daemon: docker gate: HostConfig.Privileged is not allowed", "No such image: x"]) {
      expect(isTransientDockerTransport(message), message).toBe(false);
    }
  });

  it("retries a transient EOF and answers, gives up after its delays, and never retries a refusal", async () => {
    let calls = 0;
    await expect(retryTransient(async () => { if (++calls < 3) throw new Error(GATE_EOF); return "ok"; }, [0, 0])).resolves.toBe("ok");
    expect(calls).toBe(3);
    const always = vi.fn(async () => { throw new Error(GATE_EOF); });
    await expect(retryTransient(always, [0, 0])).rejects.toThrow("EOF");
    expect(always).toHaveBeenCalledTimes(3);
    const refused = vi.fn(async () => { throw new Error("Permission denied (publickey)"); });
    await expect(retryTransient(refused, [0, 0])).rejects.toThrow("Permission denied");
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("says one plain sentence with a way on, and logs the raw words", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const here = dockerUnreachableProblem(GATE_EOF, { thisServer: true, alias: "this-server" }, () => true);
      expect(here).toBe(`${COMPUTER_UNREACHABLE} If it keeps happening, run ${SERVER_REPAIR_COMMAND} on the server.`);
      expect(dockerUnreachableProblem(GATE_EOF, { thisServer: true, alias: "this-server" }, () => false)).toBe(COMPUTER_UNREACHABLE);
      for (const text of [here, dockerUnreachableProblem(GATE_EOF, { thisServer: false, alias: "vps" })]) {
        expect(text).not.toMatch(/%2F|docker\.sock|EOF|error during connect|openmausbot/);
      }
      expect(warn.mock.calls.at(-1)?.[0]).toContain("%2Frun%2Fopenmausbot-docker");
    } finally {
      warn.mockRestore();
    }
  });

  it("finds the docker gate under either name: an install from before the rename and a new one", () => {
    const old = "unix:///run/openmausbot-docker/docker.sock", renamed = "unix:///run/madanibot-docker/docker.sock";
    const only = (path: string) => (candidate: string) => candidate === path;
    expect(gateDockerHost(old, only("/run/openmausbot-docker/docker.sock"))).toBe(old);
    expect(gateDockerHost(old, only("/run/madanibot-docker/docker.sock"))).toBe(renamed);
    expect(gateDockerHost(renamed, only("/run/openmausbot-docker/docker.sock"))).toBe(old);
    expect(gateDockerHost(renamed, () => false)).toBe(renamed);
    expect(gateDockerHost("unix:///var/run/docker.sock", () => false)).toBe("unix:///var/run/docker.sock");
    expect(gateDockerHost(undefined)).toBeUndefined();
    expect([old, renamed, "unix:///var/run/docker.sock", undefined].map(isGateSocket)).toEqual([true, true, false, false]);
  });
});

describe("a bot's computer that could not be reached, in a chat", () => {
  it("never reaches a chat card or a teammate's result as raw docker words", () => {
    expect(plainComputerFailure(RAW)).toBe(COMPUTER_UNREACHABLE);
    expect(plainComputerFailure("Docker-over-SSH command timed out")).toBe(COMPUTER_UNREACHABLE);
    expect(failedTurnCause(failedTurnTool(RAW).name)).toBe(COMPUTER_UNREACHABLE);
    expect(plainComputerFailure("Claude Code is signed out")).toBe("Claude Code is signed out");
  });

  it("goes on without the computer when it was unreachable, for any turn; a cancelled setup still ends the turn", () => {
    expect(continuesWithoutComputer({ incident: false, unreachable: true, cancelled: false })).toBe(true);
    expect(continuesWithoutComputer({ incident: true, unreachable: false, cancelled: false })).toBe(true);
    expect(continuesWithoutComputer({ incident: false, unreachable: false, cancelled: false })).toBe(false);
    expect(continuesWithoutComputer({ incident: true, unreachable: true, cancelled: true })).toBe(false);
  });

  it("tells the bot it has no computer this turn without quoting the error", () => {
    const note = computerSkippedNote(RAW, false);
    expect(note).toContain("no computer is mounted this turn");
    expect(note).not.toMatch(/docker|EOF|%2F/i);
    expect(computerSkippedNote("the VPS is down", true)).toContain("Team incidents report");
    const gone = computerSkippedNote(RAW, false, true);
    expect(gone).toContain("set it up again in Settings > Computers");
    expect(gone).not.toMatch(/try again in a minute|docker|EOF/i);
  });
});
