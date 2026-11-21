import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { launchVerificationServer, runControlMadani } from "./control-madani.ts";
import { fixtureApi, mountPreview } from "./testing/preview-fixture.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./testing/control-madani-ui.ts";
import { closeBrowserSession } from "../server/browser-engine.ts";

const { values } = parseArgs({ options: { samples: { type: "string", default: "6" } } });
const count = Number(values.samples);
if (!Number.isInteger(count) || count < 1 || count > 30) throw new Error("--samples must be between 1 and 30");
const tools = await ensureUiBrowser();
const fixture = await launchVerificationServer({}, undefined, undefined,
  { binaryPath: tools.binary, executablePath: tools.chrome ?? "" });
const api = fixtureApi(fixture.info.url);
let preview, env;
const waitUntil = async (ready) => {
  const end = performance.now() + 15_000;
  while (!await ready()) {
    if (performance.now() > end) throw new Error("send benchmark timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const round = (value) => Math.round(value * 100) / 100;
try {
  const created = await runControlMadani(["new-bot", "--name", "Pepper", "--url", fixture.info.url]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots.find((candidate) => candidate.id === created.bot.id);
  if (!bot?.threadId) throw new Error("fixture bot has no thread");
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
  preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__send-benchmark.html", title: "Isolated send benchmark", logLevel: "error" });
  env = sessionEnv({ home: fixture.info.dataDir, session: `sb-${fixture.info.pid}`, chrome: tools.chrome });
  const browser = (args, timeout) => agentBrowser(tools.binary, env, args, timeout);
  await browser(["open", preview.previewUrl], 120_000);
  await waitUntil(async () => (await browser(["eval", `Boolean(document.querySelector('textarea[aria-label="Message Pepper"]'))`])).result);
  await browser(["eval", `(async () => {
    const events = await import('/src/lib/live-events.ts');
    const probe = window.__sendBenchmark = { sse: {}, dom: {}, send: [], replies: [] };
    const inspect = () => {
      for (const id of Object.keys(probe.sse)) {
        if (probe.dom[id] === undefined && document.querySelector('[data-mid="' + id + '"]')) probe.dom[id] = performance.now();
      }
    };
    events.listenLiveFrames({ onFrame(frame) {
      if (frame.kind === 'message' && frame.message?.kind === 'text' && frame.message.role === 'bot') {
        probe.sse[frame.message.id] = performance.now(); probe.replies.push(frame.message.id); inspect();
      }
    }});
    new MutationObserver(inspect).observe(document.body, { childList: true, subtree: true });
    return true;
  })()`]);
  for (let i = 0; i < count; i++) {
    await browser(["type", 'textarea[aria-label="Message Pepper"]', `Render latency fixture ${i}`]);
    await browser(["eval", "window.__sendBenchmark.send.push(performance.now())"]);
    await browser(["press", "Enter"]);
    await runControlMadani(["wait", "--bot", bot.id, "--timeout", "15", "--url", fixture.info.url]);
    await waitUntil(async () => (await browser(["eval", `(() => { const p = window.__sendBenchmark; const id = p.replies[${i}]; return Boolean(id && p.dom[id] !== undefined); })()`])).result);
  }
  const { result: data } = await browser(["eval", "window.__sendBenchmark"]);
  const samples = data.replies.map((id, i) => ({ i, sseToDomMs: round(data.dom[id] - data.sse[id]) }));
  const path = `${fixture.info.logPath}.renderer-send-profile.json`;
  writeFileSync(path, JSON.stringify({ fixture: fixture.info, samples }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ path, samples }, null, 2));
} finally {
  if (env) await closeBrowserSession(tools.binary, env);
  await preview?.close();
  await fixture.close();
}
