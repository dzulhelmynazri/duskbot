// Security invariant: inside a bot desktop only these allowlisted folders are ever emptied, a folder whose path runs
// through a link is skipped, and find never follows links (-P) or leaves the volume (-xdev).
import { DISK_GUARD_PERCENT } from "./scratch.ts";
import { vpsDockerArgs } from "./vps-computer.ts";

/** Where a bot keeps screenshots, recordings, temp downloads and tool leftovers on its desktop. */
export const BOX_SCRATCH_DIR = "/home/cua/scratch";

const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** $1: "turn" empties the scratch folder, "sweep" deletes what is a day old; both then hold the disk under $2 percent.
 * Chromium's crash dumps are swept and guarded, never emptied at a turn's end. Prints "disk <percent> <full|ok>". */
export const BOX_SCRATCH_SCRIPT = [
  "set -u",
  "mode=\"$1\"; limit=\"$2\"",
  `scratch=${BOX_SCRATCH_DIR}`,
  "plain() { [ -d \"$1\" ] && [ ! -L \"$1\" ] && [ \"$(readlink -f -- \"$1\")\" = \"$1\" ]; }",
  "set -- \"$scratch\" \"/home/cua/.config/chromium/Crash Reports\"",
  "for d in /home/cua/.config/omb/screens/*/chromium; do set -- \"$@\" \"$d/Crash Reports\"; done",
  "roots=()",
  "for r in \"$@\"; do plain \"$r\" && roots+=(\"$r\"); done",
  "if [ \"$mode\" = turn ] && plain \"$scratch\"; then find -P \"$scratch\" -xdev -mindepth 1 -delete 2>/dev/null; fi",
  "if [ \"${#roots[@]}\" -gt 0 ]; then",
  "  find -P \"${roots[@]}\" -xdev -mindepth 1 ! -type d -mmin +1440 -delete 2>/dev/null",
  "  find -P \"${roots[@]}\" -xdev -mindepth 1 -type d -empty -mmin +1440 -delete 2>/dev/null",
  "fi",
  "used() { df -P /home/cua 2>/dev/null | awk 'NR==2 { sub(\"%\", \"\", $5); print $5 + 0 }'; }",
  "u=$(used); u=${u:-0}",
  "if [ \"$u\" -gt \"$limit\" ] && [ \"${#roots[@]}\" -gt 0 ]; then",
  "  n=0",
  "  while IFS= read -r -d '' entry; do",
  "    rm -f -- \"${entry#* }\"",
  "    n=$((n + 1))",
  "    if [ $((n % 20)) -eq 0 ]; then u=$(used); u=${u:-0}; [ \"$u\" -le \"$limit\" ] && break; fi",
  "  done < <(find -P \"${roots[@]}\" -xdev -mindepth 1 ! -type d -printf '%T@ %p\\0' 2>/dev/null | sort -z -n)",
  "  u=$(used); u=${u:-0}",
  "fi",
  "if [ \"$u\" -gt \"$limit\" ]; then echo \"disk $u full\"; else echo \"disk $u ok\"; fi",
].join("\n");

export type BoxScratchMode = "turn" | "sweep";

export function boxScratchArgs(alias: string, container: string, mode: BoxScratchMode, limit = DISK_GUARD_PERCENT): string[] {
  if (!CONTAINER_REF.test(container)) throw new Error("invalid bot desktop identity");
  return vpsDockerArgs(alias, ["exec", "-u", "cua", container, "bash", "-c", BOX_SCRATCH_SCRIPT, "madani-scratch", mode, String(limit)]);
}

export interface BoxScratchResult { usedPercent: number; full: boolean }

export function parseBoxScratch(stdout: string): BoxScratchResult | null {
  const match = /^disk (\d{1,3}) (full|ok)$/m.exec(stdout);
  return match ? { usedPercent: Number(match[1]), full: match[2] === "full" } : null;
}

export type BoxRunner = (args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string }>;

/** Null when the desktop could not be reached (asleep, gone): there is nothing to clear then. */
export async function clearBoxScratch(run: BoxRunner, alias: string, container: string, mode: BoxScratchMode): Promise<BoxScratchResult | null> {
  try {
    const { stdout } = await run(boxScratchArgs(alias, container, mode), { timeoutMs: 120_000 });
    return parseBoxScratch(stdout);
  } catch { return null; }
}

/** Remembers which desktops are still full after their scratch was cleared, for the turn's calm note. */
export class BoxDiskNotes {
  readonly #full = new Set<string>();
  record(owner: string, result: BoxScratchResult | null): void {
    if (!result) return;
    if (result.full) this.#full.add(owner); else this.#full.delete(owner);
  }
  note(owner: string): string {
    return this.#full.has(owner)
      ? " This bot's own desktop is nearly out of disk space, even after its temporary files were cleared. If a download or save fails for lack of space, tell the person calmly and suggest removing files they no longer need from it; never delete their files yourself."
      : "";
  }
}
