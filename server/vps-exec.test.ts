import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VpsCommandRunner } from "./vps-computer.ts";
import { pullVpsFile, VPS_PULL_MAX_BYTES, vpsContainerExec, vpsExecArgs, withVpsGuestFile } from "./vps-exec.ts";

const id = "a".repeat(64);
const markerOf = (args: string[]) => args.at(-1)!;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("vm_exec on a VPS desktop", () => {
  it("passes the command as one argv entry inside the box, as its desktop user, in the workspace", () => {
    const command = "echo $HOME; touch '/x y' && $(id) # not parsed here";
    const args = vpsExecArgs("workspace-vps", id, command, { seconds: 30, display: 4, marker: "m:" });
    expect(args.slice(0, 13)).toEqual(["-H", "ssh://workspace-vps", "exec", "-u", "cua", "-w", "/home/cua/workspace", "-e", "HOME=/home/cua", "-e", "DISPLAY=:4", id, "sh"]);
    expect(args.slice(-4)).toEqual(["madani-exec", "30", command, "m:"]);
  });
  it("reads the exit code from the in-box marker and keeps stderr clean", async () => {
    const runner = vi.fn<VpsCommandRunner>(async (args) => ({ stdout: "13264 dummy.pdf\n", stderr: `warn\n\n${markerOf(args)}3\n` }));
    const result = await vpsContainerExec("workspace-vps", id, "ls -l dummy.pdf", { timeoutSeconds: 999, runner });
    expect(result).toEqual({ exitCode: 3, stdout: "13264 dummy.pdf\n", stderr: "warn\n", timedOut: false });
    expect(runner.mock.calls[0]![0]).toContain("300");
    expect(runner.mock.calls[0]![1]).toMatchObject({ timeoutMs: 320_000 });
  });
  it("reports a time limit as timed out", async () => {
    const runner = vi.fn<VpsCommandRunner>(async (args) => ({ stdout: "", stderr: `\n${markerOf(args)}124\n` }));
    await expect(vpsContainerExec("workspace-vps", id, "sleep 99", { runner })).resolves.toMatchObject({ exitCode: 124, timedOut: true });
  });
  it("tells the model what to do when the box is asleep, without echoing transport detail", async () => {
    const runner = vi.fn<VpsCommandRunner>().mockRejectedValue(new Error("Error response from daemon: container abc is not running"));
    await expect(vpsContainerExec("workspace-vps", id, "ls", { runner })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("select_computer with surface cloud") });
    runner.mockRejectedValue(new Error("ssh: secret-host refused"));
    const failure: unknown = await vpsContainerExec("workspace-vps", id, "ls", { runner }).catch((error: unknown) => error);
    expect(String((failure as Error).message)).not.toContain("secret-host");
  });
  it("never claims a result whose marker was lost", async () => {
    const runner = vi.fn<VpsCommandRunner>().mockResolvedValue({ stdout: "", stderr: "" });
    await expect(vpsContainerExec("workspace-vps", id, "ls", { runner })).rejects.toMatchObject({ status: 502 });
  });
  it("refuses empty, oversized and forged input before running anything", async () => {
    const runner = vi.fn<VpsCommandRunner>();
    await expect(vpsContainerExec("workspace-vps", id, "  ", { runner })).rejects.toMatchObject({ status: 400 });
    await expect(vpsContainerExec("workspace-vps", id, "x".repeat(20_001), { runner })).rejects.toMatchObject({ status: 400 });
    await expect(vpsContainerExec("workspace-vps", "not-an-id", "ls", { runner })).rejects.toMatchObject({ status: 400 });
    await expect(vpsContainerExec("bad alias!", id, "ls", { runner })).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("attach_file from a VPS desktop", () => {
  const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "vps-pull-")); dirs.push(dir); return dir; };
  it("copies a /home/cua file to the same relative place and nothing outside it", async () => {
    const dir = scratch();
    const runner = vi.fn<VpsCommandRunner>().mockResolvedValue({ stdout: Buffer.from("a,b\n1,2\n").toString("base64"), stderr: "" });
    const local = await pullVpsFile("workspace-vps", id, "/home/cua/workspace/../workspace/posts.csv", dir, runner);
    expect(local).toBe(join(dir, "workspace", "posts.csv"));
    expect(readFileSync(local!, "utf8")).toBe("a,b\n1,2\n");
    expect(runner.mock.calls[0]![0]).toEqual(expect.arrayContaining(["/home/cua/workspace/posts.csv", String(VPS_PULL_MAX_BYTES)]));
    await expect(pullVpsFile("workspace-vps", id, "/etc/passwd", dir, runner)).resolves.toBeNull();
    await expect(pullVpsFile("workspace-vps", id, "/home/cua/../../etc/passwd", dir, runner)).resolves.toBeNull();
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it("says a missing or oversized file in words the model can act on", async () => {
    const runner = vi.fn<VpsCommandRunner>().mockRejectedValue(new Error("missing"));
    await expect(pullVpsFile("workspace-vps", id, "/home/cua/workspace/x.csv", scratch(), runner)).rejects.toMatchObject({ status: 404 });
    runner.mockRejectedValue(new Error("large 99999999"));
    await expect(pullVpsFile("workspace-vps", id, "/home/cua/workspace/x.csv", scratch(), runner)).rejects.toMatchObject({ status: 413 });
  });
  it("asks for the turn's desktop only for a /home/cua path", async () => {
    const desktop = vi.fn(async () => undefined);
    const use = vi.fn(async (guest?: unknown) => guest);
    await expect(withVpsGuestFile(desktop, "report.pdf", use)).resolves.toBeUndefined();
    expect(desktop).not.toHaveBeenCalled();
    await withVpsGuestFile(desktop, "/home/cua/workspace/report.pdf", use);
    expect(desktop).toHaveBeenCalledTimes(1);
  });
});
