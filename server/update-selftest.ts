// The self-test an install runs on the version it just started (shared/update-guard.ts): the server answers, a page opens
// in the bot's browser, and one cheap read-only call per connected connector goes through. A check that failed on the
// version before as well is this machine's own trouble (no browser, a revoked token), not the update's: only a check
// that passed before and fails now fails the test, so a broken connector never rolls a good update back.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CheckResult = "ok" | "failed" | "skipped";
export interface SelfTestResult { ok: boolean; at: number; checks: Record<string, CheckResult> }
export interface SelfTestChecks {
  /** the server's own state answers (its store reads) */
  health(): boolean | Promise<boolean>;
  /** a page opens in the bot's browser; null when this install has no browser to open */
  browser?(): Promise<boolean | null>;
  /** one read-only call per connected connector, keyed by app; empty when none is connected */
  connectors?(): Promise<Record<string, boolean>>;
}

const within = <T>(work: Promise<T>, ms: number, fallback: T) =>
  Promise.race([work.catch(() => fallback), new Promise<T>(resolve => { const t = setTimeout(() => resolve(fallback), ms); t.unref?.(); })]);

/** runs every check, at most `timeoutMs` each; `before` is the last result on the version before (null: none) */
export async function runSelfTest(checks: SelfTestChecks, before: SelfTestResult | null, options: { now?: () => number; timeoutMs?: number } = {}): Promise<SelfTestResult> {
  const timeoutMs = options.timeoutMs ?? 45_000, now = options.now ?? Date.now;
  const [health, browser, connectors] = await Promise.all([
    within(Promise.resolve().then(() => checks.health()), timeoutMs, false),
    checks.browser ? within(checks.browser(), timeoutMs, false as boolean | null) : Promise.resolve(null),
    checks.connectors ? within(checks.connectors(), timeoutMs, null as Record<string, boolean> | null) : Promise.resolve({}),
  ]);
  const results: Record<string, CheckResult> = { health: health ? "ok" : "failed", browser: browser === null ? "skipped" : browser ? "ok" : "failed" };
  if (connectors === null) results.connectors = "failed";
  else for (const [app, ok] of Object.entries(connectors)) if (/^[a-z0-9_-]{1,40}$/.test(app)) results[`connector:${app}`] = ok ? "ok" : "failed";
  // health always counts; any other check fails the test only when it worked on the version before
  const regressed = Object.entries(results).some(([name, result]) => result === "failed" && (name === "health" || before?.checks[name] === "ok"));
  return { ok: !regressed, at: now(), checks: results };
}

export const SELFTEST_MARK = "madani-selftest-page";

/**
 * Opens one page in the browser binary headless, in a throwaway profile (never the bot's own), and reads it back.
 * `binary` resolves the bot's browser, or null when there is none.
 */
export function browserPageCheck(binary: () => Promise<string | null>, options: { args?: string[]; timeoutMs?: number } = {}): () => Promise<boolean | null> {
  return async () => {
    const path = await binary().catch(() => null);
    if (!path) return null;
    const profile = mkdtempSync(join(tmpdir(), "madani-selftest-"));
    try {
      const page = `data:text/html,<title>ok</title><p>${SELFTEST_MARK}</p>`;
      return await new Promise<boolean>(resolve => {
        const child = spawn(path, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", `--user-data-dir=${profile}`, ...(options.args ?? []), "--dump-dom", page],
          { stdio: ["ignore", "pipe", "ignore"], timeout: options.timeoutMs ?? 30_000 });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => { out = (out + chunk.toString("utf8")).slice(-65_536); });
        child.once("error", () => resolve(false));
        child.once("close", () => resolve(out.includes(SELFTEST_MARK)));
      });
    } finally { rmSync(profile, { recursive: true, force: true }); }
  };
}
