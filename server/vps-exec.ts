import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { guestWorkspaceToHost } from "./bot-attachment.ts";
import { clipExecOutput, VM_WORKSPACE_GUEST, type ContainerExecResult } from "./container-computer.ts";
import { defaultRunner, vpsDockerArgs, type VpsCommandRunner } from "./vps-computer.ts";

const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;
const DEFAULT_SECONDS = 60;
const MAX_SECONDS = 300;
const MAX_COMMAND = 20_000;
// the command runs as one argv entry inside the box: nothing the bot writes is parsed by a shell on the host
const WRAPPER = 'timeout -k 5 "$1" sh -lc "$2"; code=$?; printf "\\n%s%s\\n" "$3" "$code" >&2';

export const NO_EXEC_COMPUTER =
  "You have no Local VM or VPS desktop in this turn, so there is nowhere to run this command. For work on a computer, call select_computer first; otherwise use your own shell tool.";
export const VPS_EXEC_CHANGED = "Your VPS computer changed during this call, so the command did not run. Retry once.";

function refusal(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** The argv for one shell command inside a bot's VPS desktop, as its desktop user, in its workspace. */
export function vpsExecArgs(alias: string, containerId: string, command: string, opts: { seconds: number; display: number; marker: string }): string[] {
  if (!CONTAINER_ID.test(containerId)) throw refusal("invalid VPS computer identity", 400);
  return vpsDockerArgs(alias, [
    "exec", "-u", "cua", "-w", VM_WORKSPACE_GUEST,
    "-e", "HOME=/home/cua", "-e", `DISPLAY=:${opts.display}`,
    containerId,
    "sh", "-c", WRAPPER, "madani-exec", String(opts.seconds), command, opts.marker,
  ]);
}

/** Runs a bot's shell command on its own VPS desktop and reports the exit code; the limit is enforced inside the box. */
export async function vpsContainerExec(
  alias: string,
  containerId: string,
  command: string,
  options: { timeoutSeconds?: number; display?: number; runner?: VpsCommandRunner; signal?: AbortSignal } = {},
): Promise<ContainerExecResult> {
  if (typeof command !== "string" || !command.trim()) throw refusal("command is required", 400);
  if (command.length > MAX_COMMAND) throw refusal("command is too long", 400);
  if (options.timeoutSeconds !== undefined && !Number.isFinite(options.timeoutSeconds)) throw refusal("timeout_seconds must be finite", 400);
  const seconds = Math.min(Math.max(Math.floor(options.timeoutSeconds ?? DEFAULT_SECONDS), 1), MAX_SECONDS);
  const marker = `madani-exit-${randomBytes(8).toString("hex")}:`;
  const args = vpsExecArgs(alias, containerId, command, { seconds, display: options.display ?? 1, marker });
  let out: { stdout: string; stderr: string };
  try {
    out = await (options.runner ?? defaultRunner)(args, { timeoutMs: (seconds + 20) * 1000, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    if ((error as { name?: unknown }).name === "AbortError") throw error;
    const detail = error instanceof Error ? error.message : "";
    throw refusal(/is not running|No such container/i.test(detail)
      ? "Your VPS computer is not running, so the command did not run. Call select_computer with surface cloud to wake it, then retry once."
      : "The command could not reach your VPS computer, so it did not run. Retry once; if it fails again, tell the person the computer is unreachable.", 502);
  }
  const at = out.stderr.lastIndexOf(marker);
  if (at < 0) throw refusal("The command's result was lost on the way back from your VPS computer. Check its effect before running it again.", 502);
  const exitCode = Number.parseInt(out.stderr.slice(at + marker.length), 10);
  const stderr = out.stderr.slice(0, at).replace(/\n$/, "");
  const code = Number.isInteger(exitCode) ? exitCode : 1;
  return { exitCode: code, stdout: clipExecOutput(out.stdout), stderr: clipExecOutput(stderr), timedOut: code === 124 || code === 137 };
}

const GUEST_HOME = "/home/cua";
// base64 of this many bytes stays inside the Docker-over-SSH reader's 16 MiB stdout window
export const VPS_PULL_MAX_BYTES = 12 * 1024 * 1024;
const PULL = 'f="$1"; [ -f "$f" ] && [ ! -L "$f" ] || { echo missing >&2; exit 3; }; s=$(stat -c %s "$f"); [ "$s" -le "$2" ] || { echo "large $s" >&2; exit 4; }; base64 -w0 "$f"';

/** Copies one file from a bot's VPS desktop home into `hostDir` at the same relative path; the caller owns `hostDir`. */
export async function pullVpsFile(alias: string, containerId: string, guestPath: string, hostDir: string, runner: VpsCommandRunner = defaultRunner): Promise<string | null> {
  const local = guestWorkspaceToHost(guestPath, GUEST_HOME, hostDir);
  if (!local) return null;
  if (!CONTAINER_ID.test(containerId)) throw refusal("invalid VPS computer identity", 400);
  const guest = posix.join(GUEST_HOME, ...relative(hostDir, local).split(sep));
  let stdout: string;
  try {
    ({ stdout } = await runner(vpsDockerArgs(alias, ["exec", "-u", "cua", containerId, "sh", "-c", PULL, "madani-pull", guest, String(VPS_PULL_MAX_BYTES)]), { timeoutMs: 60_000 }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (/^missing$/m.test(detail)) throw refusal(`No file was found at ${guest} on your VPS computer. Save it under /home/cua/workspace and pass its exact path.`, 404);
    if (/^large \d+$/m.test(detail)) throw refusal(`That file is larger than ${VPS_PULL_MAX_BYTES} bytes, too large to bring from your VPS computer. Compress it or split it, then attach the parts.`, 413);
    throw refusal("The file could not be read from your VPS computer. Retry once.", 502);
  }
  await mkdir(dirname(local), { recursive: true });
  await writeFile(local, Buffer.from(stdout.trim(), "base64"), { mode: 0o600 });
  return local;
}

/** Runs `use` with the guest mapping attach_file needs for a /home/cua path on the turn's VPS desktop, then forgets the copy. */
export async function withVpsGuestFile<T>(desktop: () => Promise<{ alias: string; containerId: string } | undefined>, guestPath: string, use: (guest?: { root: string; host: string }) => Promise<T>): Promise<T> {
  const vps = guestWorkspaceToHost(guestPath, GUEST_HOME, "/") ? await desktop() : undefined;
  if (!vps) return use();
  const dir = await mkdtemp(join(tmpdir(), "madani-vps-file-"));
  try {
    await pullVpsFile(vps.alias, vps.containerId, guestPath, dir);
    return await use({ root: GUEST_HOME, host: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
