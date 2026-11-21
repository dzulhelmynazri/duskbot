// What one chat turn costs in prompt before the person's words: a sandbox of the checkout answers through the echo
// proxy (no model, no cost) and the system prompt and turn text the engine received are measured.
//   node --experimental-strip-types scripts/behaviour-eval/prompt-size.ts --repo <checkout> [--dump <file>]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { client } from "../memory-eval/client.ts";
import { launchSandbox } from "../memory-eval/sandbox.ts";
import { startProxy } from "../memory-eval/proxy.ts";

const { values } = parseArgs({ options: { repo: { type: "string" }, dump: { type: "string" } } });
process.env.MADANI_NO_TEST_BOTS = "1";
const proxy = await startProxy({ mode: "echo", port: 7300 + Math.floor(Math.random() * 90), models: ["eval-model"] });
const box = await launchSandbox(values.repo!, { url: proxy.url, key: "echo", model: "eval-model" }, { captureQuietMs: 3_600_000 });
try {
  const api = client(box.url);
  const bot = await api.createBot("Sage", "eval-model");
  const ask = "Every weekday at 8am send me my top 3 priorities.";
  await api.say(bot.id, bot.threadId, ask);
  const chat = proxy.records.find((rec) => rec.kind === "chat" && rec.tools.length > 0);
  if (!chat) throw new Error("no chat request was recorded");
  const turnExtra = chat.user.replace(ask, "");
  if (values.dump) writeFileSync(values.dump, `${chat.system}\n\n=== turn ===\n${chat.user}`);
  const tokens = (chars: number) => Math.round(chars / 4);
  console.log(JSON.stringify({ systemChars: chat.system.length, systemTokens: tokens(chat.system.length), turnNoteChars: turnExtra.length, tools: chat.tools.length }, null, 2));
} finally {
  await box.close();
  await proxy.close();
}
