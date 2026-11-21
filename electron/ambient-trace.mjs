// An opt-in timeline of the island and the dock, for when they behave differently on someone's Mac than anywhere they
// can be watched: MADANI_AMBIENT_TRACE=1 (or `trace: true` in ambient-prefs.json) writes one line per event, with its time
// to the millisecond, to ~/Library/Logs/Madani Bot/ambient-trace.log (the app's own logs folder elsewhere). Pointer
// crossings, open and close, CSS transitions, settled signals and every window action main takes. Off by default; no
// message text ever goes in.
import { appendFile, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TRACE_FILE = "ambient-trace.log";

export function traceFolder(platform = process.platform, logs = null) {
  return platform === "darwin" ? join(homedir(), "Library", "Logs", "Madani Bot") : logs ?? join(homedir(), ".madanibot", "logs");
}

/** Whether tracing is on: the environment, or the person's prefs file. */
export function traceWanted(env = process.env, prefs = null) {
  return env.MADANI_AMBIENT_TRACE === "1" || prefs?.trace === true;
}

/**
 * @param {{ folder: string, now?: () => number, write?: (file: string, line: string) => void }} options
 * @returns {(surface: string, event: string, detail?: string) => void}
 */
export function createTrace({ folder, now = Date.now, write = null }) {
  const file = join(folder, TRACE_FILE);
  let started = null, ready = false;
  const out = write ?? ((path, line) => {
    if (!ready) { try { mkdirSync(folder, { recursive: true }); } catch { /* the write below fails quietly too */ } ready = true; }
    appendFile(path, line, () => {});
  });
  return (surface, event, detail = "") => {
    const at = now();
    started ??= at;
    const stamp = new Date(at).toISOString().slice(11, 23);
    out(file, `${stamp} +${String(at - started).padStart(7)}ms ${surface.padEnd(6)} ${event}${detail ? ` ${detail}` : ""}\n`);
  };
}
