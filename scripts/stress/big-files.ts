// Big files against a fake-engine fixture: uploads at and past each limit, many at once, a retried and an abandoned
// upload, a message carrying them, a huge pasted message and a long transcript page, with the server's memory and
// responsiveness sampled throughout. Nothing real is touched.
//   node --experimental-strip-types scripts/stress/big-files.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { get, request } from "node:http";
import { join } from "node:path";
import { launchVerificationServer } from "../control-madani.ts";
import { fixtureApi } from "../testing/preview-fixture.ts";

const MB = 1024 * 1024;
const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TOOL_CALLS: "[]" });
const url = fixture.info.url;
const api = fixtureApi(url, { headers: { origin: url } });
const rss = () => Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(fixture.info.pid)], { encoding: "utf8" }).trim()) / 1024);
let peak = 0, lagMax = 0, sampling = true;
const sampler = (async () => {
  while (sampling) {
    const t0 = performance.now();
    await new Promise<void>((done) => get(`${url}/api/health`, { agent: false }, (res) => { res.resume(); res.on("end", () => done()); }).on("error", () => done()));
    lagMax = Math.max(lagMax, performance.now() - t0);
    peak = Math.max(peak, rss());
    await new Promise((done) => setTimeout(done, 100));
  }
})();

/** Raw upload; `abortAfter` bytes then the client hangs up. */
function upload(path: string, bytes: number, mime: string, abortAfter?: number): Promise<{ status: number; body: any; ms: number }> {
  const t0 = performance.now();
  return new Promise((done) => {
    const req = request(`${url}${path}`, { method: "POST", agent: false, headers: { origin: url, "content-type": mime, "content-length": String(bytes) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => { let body: any = text; try { body = JSON.parse(text); } catch {} done({ status: res.statusCode ?? 0, body, ms: Math.round(performance.now() - t0) }); });
    });
    req.on("error", (error) => done({ status: -1, body: error.message, ms: Math.round(performance.now() - t0) }));
    const chunk = Buffer.alloc(MB, 7);
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        if (abortAfter !== undefined && sent >= abortAfter) { req.destroy(); return; }
        const piece = chunk.subarray(0, Math.min(MB, bytes - sent));
        sent += piece.length;
        if (!req.write(piece)) { req.once("drain", pump); return; }
      }
      req.end();
    };
    pump();
  });
}
const files = (name: string, bytes: number, extra = "", abortAfter?: number) => upload(`/api/files?name=${encodeURIComponent(name)}${extra}`, bytes, "application/pdf", abortAfter);
const dirSizes = (dir: string) => { try { return readdirSync(dir).map((name) => statSync(join(dir, name)).size); } catch { return []; } };

const result: Record<string, unknown> = {};
try {
  const before = rss();
  const at = await files("at-limit.pdf", 25 * MB);
  const over = await files("over-limit.pdf", 25 * MB + 1);
  const image = await upload("/api/attachments", 10 * MB, "image/png");
  const imageOver = await upload("/api/attachments", 10 * MB + 1, "image/png");
  const id = randomUUID();
  const first = await files("retried.pdf", 5 * MB, `&uploadId=${id}`);
  const again = await files("retried.pdf", 5 * MB, `&uploadId=${id}`);
  const abandoned = await files("abandoned.pdf", 20 * MB, `&uploadId=${randomUUID()}`, 8 * MB);
  await new Promise((done) => setTimeout(done, 500));
  const concurrent0 = performance.now();
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) => files(`many-${i}.pdf`, 24 * MB)));
  result.uploads = {
    atLimit: [at.status, at.ms], overLimit: [over.status, over.body?.error], image: [image.status], imageOver: [imageOver.status, imageOver.body?.error],
    retriedSamePath: first.body?.path === again.body?.path, abandoned: abandoned.status,
    tenAt24MbMs: Math.round(performance.now() - concurrent0), tenStatuses: [...new Set(many.map((one) => one.status))],
    rssBeforeMb: before,
  };
  const storage = await api("GET", "/api/attachment-storage");
  result.storage = { usedMb: Math.round(storage.usedBytes / MB), maxMb: Math.round(storage.maxBytes / MB) };
  result.leftoverPartials = readdirSync(join(fixture.info.dataDir, "attachments")).filter((name) => /part|tmp/i.test(name));

  const created = await api("POST", "/api/bots", { name: "Files" });
  const bot = created.bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
  const attached = [at, ...many.slice(0, 4)].map((one, i) => `<attached-file path="${one.body.path}" name="file-${i}.pdf" />`).join("\n\n");
  const pasted = `<pasted-text index="1">\n${"a line of pasted log output that goes on for a while\n".repeat(40_000)}</pasted-text>`;
  const timedTurn = async (text: string) => {
    const t0 = performance.now();
    const sent = await fetch(`${url}/api/bots/${bot.id}/messages`, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify({ text, threadId: bot.threadId }) });
    if (!sent.ok) return { status: sent.status, error: (await sent.json().catch(() => ({}))).error, ms: Math.round(performance.now() - t0) };
    for (let i = 0; i < 300; i++) {
      const job = await api("GET", `/api/threads/${bot.threadId}/job?scope=turn`);
      if (["completed", "failed", "needs-input", "stalled", "idle"].includes(job.state)) return { status: sent.status, state: job.state, ms: Math.round(performance.now() - t0) };
      await new Promise((done) => setTimeout(done, 200));
    }
    return { status: sent.status, state: "still working after 60 s" };
  };
  result.turnWithFiles = await timedTurn(`please read these\n\n${attached}`);
  result.turnWithHugePaste = { chars: pasted.length, ...(await timedTurn(`summarise this\n\n${pasted}`)) };
  const t0 = performance.now();
  const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`);
  result.transcriptRead = { ms: Math.round(performance.now() - t0), bytes: JSON.stringify(page).length };
  const t1 = performance.now();
  await api("GET", "/api/bots?messages=200");
  result.bootReadMs = Math.round(performance.now() - t1);
  const dump = await import("node:fs").then((fs) => JSON.parse(fs.readFileSync(fixture.fixtureDumpPath, "utf8")));
  result.engineSawPromptChars = String(dump.prompt ?? "").length;
  result.attachmentFiles = dirSizes(join(fixture.info.dataDir, "attachments")).length;
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
} finally {
  sampling = false;
  await sampler;
  Object.assign(result, { peakRssMb: peak, afterRssMb: rss(), healthMaxMs: Math.round(lagMax) });
  console.log(JSON.stringify(result, null, 2));
  await fixture.close();
}
