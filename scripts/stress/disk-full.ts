// A real full disk under a fake-engine fixture: run with TMPDIR on a small volume (a RAM disk), fill it, send messages,
// free it again and restart. The server must stay up, say plainly what failed, keep what it had, and recover.
//   TMPDIR=/Volumes/MadaniFull node --experimental-strip-types scripts/stress/disk-full.ts
import { closeSync, openSync, rmSync, statfsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchRestartableServer } from "../../server/testing/restartable-server.ts";

process.env.FAKE_CLAUDE_TOOL_CALLS = "[]";
const volume = tmpdir();
const server = await launchRestartableServer({ dataDirRoot: volume });
const api = async (method: string, path: string, body?: unknown) => {
  try {
    const res = await fetch(`${server.url}${path}`, { method, headers: { origin: server.url, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  } catch (error) { return { status: -1, error: error instanceof Error ? error.message : String(error) }; }
};
const until = async (check: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((d) => setTimeout(d, 250)); } return false; };
const free = () => { const s = statfsSync(volume); return Math.round(s.bavail * s.bsize / 1024); };
const filler = join(volume, "filler.bin");
const fill = () => {
  const fd = openSync(filler, "a");
  const block = Buffer.alloc(256 * 1024);
  try { for (;;) writeSync(fd, block); } catch {}
  const small = Buffer.alloc(4096);
  try { for (;;) writeSync(fd, small); } catch {}
  closeSync(fd);
};
const turn = async (bot: { id: string; threadId: string }, text: string) => {
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
  let job: any = {};
  await until(async () => { job = await api("GET", `/api/threads/${bot.threadId}/job?scope=turn`); return job.state !== "running"; }, 30_000);
  const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=10`);
  const tail = ((page.messages ?? []) as Array<{ role: string; kind: string; text?: string; tool?: { name: string } }>).filter((m) => m.kind !== "digest").slice(-2)
    .map((m) => `${m.role}/${m.kind}: ${String(m.text || m.tool?.name || "").slice(0, 160)}`);
  return { sent: sent.status, sendError: sent.error, job: job.state ?? job.error, tail };
};
const results: Record<string, unknown> = {};
try {
  const created = await api("POST", "/api/bots", { name: "Full" });
  const bot = created.bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
  results.before = await turn(bot, "first, with room");
  fill();
  results.freeKbWhenFull = free();
  results.whenFull = [await turn(bot, "second, disk full"), await turn(bot, "third, disk full")];
  results.serverUpWhenFull = (await api("GET", "/api/health")).status === 200;
  results.newBotWhenFull = (await api("POST", "/api/bots", { name: "Another" })).status;
  rmSync(filler, { force: true });
  results.freedKb = free();
  results.afterFreed = await turn(bot, "fourth, room again");
  await server.stop(); await server.start();
  const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`);
  results.afterRestart = ((page.messages ?? []) as Array<{ role: string; text?: string }>).filter((m) => m.role === "user").map((m) => m.text);
  results.afterRestartTurn = await turn(bot, "fifth, after restart");
} catch (error) {
  results.error = error instanceof Error ? error.stack : String(error);
} finally {
  rmSync(filler, { force: true });
  console.log(JSON.stringify(results, null, 2));
  console.error("log", server.logPath);
  await server.close();
}
