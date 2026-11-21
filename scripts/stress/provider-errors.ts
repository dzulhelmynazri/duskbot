// What a person sees when the AI provider fails: each case launches a fake-engine fixture that fails one way (429, 500,
// 529, a timeout, a dropped connection, a usage limit, transient launch failures, a crash, garbage output, a silent
// hang), sends one message and reads what the chat shows. A case passes when the turn ends (never stuck), the chat holds
// no raw provider text, and a second message still works.
//   node --experimental-strip-types scripts/stress/provider-errors.ts [--only name]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { launchVerificationServer } from "../control-madani.ts";
import { fixtureApi } from "../testing/preview-fixture.ts";

const { values } = parseArgs({ options: { only: { type: "string" } } });
const scratch = mkdtempSync(join(tmpdir(), "madani-provider-errors-"));
const apiError = (text: string, kind: string, status?: number) => ({ FAKE_CLAUDE_MODE: "api-error", FAKE_CLAUDE_API_ERROR: text, FAKE_CLAUDE_API_ERROR_KIND: kind, ...(status ? { FAKE_CLAUDE_API_ERROR_STATUS: String(status) } : {}) });
const CASES: Record<string, Record<string, string>> = {
  "429": apiError(`API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50,000 input tokens per minute."},"request_id":"req_011CV1"}`, "rate_limit", 429),
  "500": apiError(`API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_011CV2"}`, "server_error", 500),
  "529": apiError("API Error: 529 Overloaded. This is a server-side issue, usually temporary.", "unknown", 529),
  timeout: apiError("API Error: Request timed out.", "unknown"),
  connection: apiError("API Error: Connection error.", "unknown"),
  "usage-limit": { FAKE_CLAUDE_MODE: "usage-limit" },
  "transient-launches": { FAKE_CLAUDE_TRANSIENTS: "2", FAKE_CLAUDE_STATE: join(scratch, "transients-clean") },
  "transient-after-output": { FAKE_CLAUDE_TRANSIENTS: "2", FAKE_CLAUDE_PARTIAL_FAILS: "1", FAKE_CLAUDE_STATE: join(scratch, "transients") },
  crash: { FAKE_CLAUDE_MODE: "exit-early" },
  malformed: { FAKE_CLAUDE_MODE: "malformed" },
  hang: { FAKE_CLAUDE_MODE: "hang", MADANI_TEST_STALL_CLOCK: "1" },
};
// what a person must never read in a chat: provider payloads, codes, stack traces, our process plumbing
const RAW = /API Error|rate_limit_error|api_error|request_id|req_011|\{"type"|overloaded_error|\bexit(?:ed)? (?:code|with)\b|fake-claude|\bat \S+\.(?:ts|js|mjs):\d+|ECONN|stderr|Internal server error/i;

const results: Record<string, unknown> = {};
for (const [name, env] of Object.entries(CASES)) {
  if (values.only && values.only !== name) continue;
  const fixture = await launchVerificationServer({ ...process.env, ...env });
  const url = fixture.info.url;
  const api = fixtureApi(url, { headers: { origin: url } });
  const row: Record<string, unknown> = {};
  try {
    const created = await api("POST", "/api/bots", { name: "Probe" });
    const bot = created.bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
    const turn = async (text: string, timeoutMs: number) => {
      const t0 = performance.now();
      await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
      if (name === "hang") setTimeout(() => writeFileSync(join(fixture.info.dataDir, "stall-turns"), ""), 3_000);
      let version: string | undefined, job: any;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const q = new URLSearchParams({ scope: "turn", ...(version ? { version, wait: "5000" } : {}) });
        job = await api("GET", `/api/threads/${bot.threadId}/job?${q}`);
        if (["needs-input", "completed", "failed", "stalled", "idle"].includes(job.state) && version !== undefined) break;
        if (Date.now() > deadline) break;
        version = String(job.version);
      }
      return { state: job.state, ms: Math.round(performance.now() - t0) };
    };
    const first = await turn("hello there", 90_000);
    if (name === "hang") rmSync(join(fixture.info.dataDir, "stall-turns"), { force: true });
    const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`);
    if (process.env.STRESS_DUMP) console.error(JSON.stringify(page.messages, null, 1));
    const shown = (page.messages as Array<{ role: string; kind?: string; text?: string; tool?: { name?: string } }>).filter((m) => m.role !== "user" && m.kind !== "digest").slice(1)
      .map((m) => String(m.text || m.tool?.name || ""));
    const busyAfter = (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
    Object.assign(row, {
      first, shown: shown.map((text) => text.slice(0, 160)), raw: shown.filter((text) => RAW.test(text)).map((text) => text.match(RAW)?.[0]),
      busyAfter: Boolean(busyAfter?.busy || busyAfter?.working),
    });
    // the engine still fails the same way: the next message must be taken and end too, never refused as busy
    if (name !== "hang") {
      row.second = await turn("are you there?", 60_000);
      const after = await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`);
      row.messagesAfterSecond = after.messages.length;
      if (process.env.STRESS_DUMP) console.error(JSON.stringify(after.messages.slice(-3), null, 1));
    }
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  } finally {
    await fixture.close();
  }
  results[name] = row;
  console.error(name, JSON.stringify(row));
}
rmSync(scratch, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
