// The wall clock jumps while a turn runs (set forward 30 minutes, then back 2 hours), as a manual change, a time sync or
// a wake does: the turn must not be stopped as stalled, must finish once released, and later messages must still read
// in the order they were sent. Fake engine, resume clock hook (server/testing/resume-clock-hooks.mjs).
//   node --experimental-strip-types scripts/stress/clock-changes.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchVerificationServer } from "../control-madani.ts";
import { fixtureApi } from "../testing/preview-fixture.ts";

const scratch = mkdtempSync(join(tmpdir(), "madani-clock-"));
const release = join(scratch, "release");
const fixture = await launchVerificationServer({ ...process.env, MADANI_TEST_RESUME_CLOCK: "1", FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: release });
const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
const skew = (ms: number) => writeFileSync(join(fixture.info.dataDir, "resume-clock-ms"), String(ms));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const job = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/job?scope=turn`)).state as string;
const results: Record<string, unknown> = {};
try {
  const created = await api("POST", "/api/bots", { name: "Clock" });
  const bot = created.bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "one, before the clock moves", threadId: bot.threadId });
  await sleep(2_000);
  skew(30 * 60_000);
  // the stall sweep runs every 60 s
  await sleep(70_000);
  results.afterForward30Min = await job(bot.threadId);
  skew(-2 * 60 * 60_000);
  await sleep(5_000);
  results.afterBack2h = await job(bot.threadId);
  writeFileSync(release, "");
  for (let i = 0; i < 60 && (await job(bot.threadId)) === "running"; i++) await sleep(500);
  results.afterRelease = await job(bot.threadId);
  rmSync(release);
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "two, sent with the clock two hours back", threadId: bot.threadId });
  await sleep(1_000);
  writeFileSync(release, "");
  for (let i = 0; i < 60 && (await job(bot.threadId)) === "running"; i++) await sleep(500);
  const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=20`);
  results.order = (page.messages as Array<{ role: string; kind: string; text?: string; tool?: { name: string } }>).filter((m) => m.kind !== "digest")
    .map((m) => `${m.role}: ${String(m.text || m.tool?.name || "").slice(0, 70)}`);
} catch (error) {
  results.error = error instanceof Error ? error.stack : String(error);
} finally {
  console.log(JSON.stringify(results, null, 2));
  await fixture.close();
  rmSync(scratch, { recursive: true, force: true });
}
