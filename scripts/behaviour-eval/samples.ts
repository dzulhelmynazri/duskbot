// Six sample conversations (casual chat, a task, a failure, a research ask, a reminder, a group room) run against one
// checkout in a sandbox, written as JSON for a before/after page. Same sandbox, proxy and gateway as run.ts.
//   node --experimental-strip-types scripts/behaviour-eval/samples.ts --repo <checkout> --model gpt-6.1-terra --out <file.json>
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { client } from "../memory-eval/client.ts";
import { gatewayFromEnv, launchSandbox } from "../memory-eval/sandbox.ts";
import { startProxy } from "../memory-eval/proxy.ts";

const { values } = parseArgs({ options: {
  repo: { type: "string" },
  model: { type: "string", default: "gpt-6.1-terra" },
  out: { type: "string" },
} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Line = { who: string; text: string };
const CHATS: Array<{ id: string; title: string; turns: string[] }> = [
  { id: "casual", title: "Casual chat", turns: ["hey! how's your day going", "haha same. long week"] },
  { id: "task", title: "A task", turns: ["Every weekday at 8am send me my top 3 priorities for the day."] },
  { id: "failure", title: "A failure", turns: ["Post this on my X account right now: \"Dark mode is live!\""] },
  { id: "research", title: "A longer research ask", turns: ["I'm choosing between a Kindle Paperwhite and a Kobo Clara for reading in bed at night. Which should I get and why?"] },
  { id: "reminder", title: "A reminder", turns: ["remind me at 6pm to call mom. also her bday is next week, any gift ideas under 2000 rupees?"] },
];

process.env.MADANI_NO_TEST_BOTS = "1";
const gateway = gatewayFromEnv(values.model!);
const proxy = await startProxy({ mode: "forward", gateway, port: 7300 + Math.floor(Math.random() * 90), models: [values.model!] });
const box = await launchSandbox(values.repo!, { ...gateway, url: proxy.url }, { captureQuietMs: 3_600_000 });
const api = client(box.url);
const out: Array<{ id: string; title: string; lines: Line[] }> = [];
const visible = (messages: Array<{ role: string; kind?: string; text?: string; from?: { name?: string } }>, me: string) =>
  messages.filter((m) => m.kind === "text" && m.text).map((m): Line => ({ who: m.role === "user" ? "You" : m.from?.name ?? me, text: m.text!.trim() }));

async function idle(threadId: string): Promise<void> {
  await sleep(600);
  for (let i = 0; i < 400; i++) {
    const job = await api.call("GET", `/api/threads/${threadId}/job?scope=turn`);
    if (["needs-input", "completed", "failed", "stalled", "idle"].includes(job.state)) return;
    await sleep(500);
  }
}

try {
  for (const chat of CHATS) {
    const bot = await api.createBot("Sage", values.model!);
    const threadId = await api.newThread(bot.id);
    for (const text of chat.turns) {
      await api.call("POST", `/api/bots/${bot.id}/messages`, { text, threadId });
      await idle(threadId);
    }
    out.push({ id: chat.id, title: chat.title, lines: visible((await api.call("GET", `/api/threads/${threadId}/messages?limit=200`)).messages, "Sage") });
    console.log("done", chat.id);
  }
  const ivy = await api.createBot("Ivy", values.model!);
  const rex = await api.createBot("Rex", values.model!);
  const { group } = await api.call("POST", "/api/groups", { name: "launch", memberIds: [ivy.id, rex.id] });
  await api.call("PATCH", `/api/groups/${group.id}/setup`, { action: "skip" });
  await api.call("POST", `/api/groups/${group.id}/messages`, { text: "@Ivy @Rex we ship dark mode on friday. one idea each for a tiny launch post?" });
  await sleep(5_000);
  for (let i = 0; i < 120; i++) {
    const bots = await api.bots() as Array<{ id: string; busy?: boolean }>;
    if (!bots.some((b) => (b.id === ivy.id || b.id === rex.id) && b.busy)) break;
    await sleep(1_000);
  }
  await sleep(3_000);
  const room = await api.call("GET", `/api/threads/${group.threadId}/messages?limit=200`);
  out.push({ id: "room", title: "A group room", lines: visible(room.messages, "bot") });
} finally {
  writeFileSync(values.out!, JSON.stringify(out, null, 2));
  await box.close();
  await proxy.close();
}
