// What a send looks like from the keyboard: Enter to the person's bubble, to the bot's working row, and to the first
// words of its reply, against the fake engine in a headless browser. --post-delay holds the send's answer that long, as
// the owner's server took 6.9 s to answer a "hi" to a bot with no AI chosen; the working row must not wait on it.
//   node --experimental-strip-types scripts/bench-send-timeline.mjs [--samples 4] [--post-delay 6900]
import { parseArgs } from "node:util";
import { launchVerificationServer, runControlMadani } from "./control-madani.ts";
import { fixtureApi, mountPreview } from "./testing/preview-fixture.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./testing/control-madani-ui.ts";
import { closeBrowserSession } from "../server/browser-engine.ts";

const { values } = parseArgs({ options: { samples: { type: "string", default: "4" }, "post-delay": { type: "string", default: "0" } } });
const count = Number(values.samples);
const postDelay = Number(values["post-delay"]);
if (!Number.isInteger(count) || count < 1 || count > 30) throw new Error("--samples must be between 1 and 30");
if (!Number.isFinite(postDelay) || postDelay < 0 || postDelay > 30_000) throw new Error("--post-delay must be 0 to 30000 ms");
const tools = await ensureUiBrowser();
const fixture = await launchVerificationServer({}, undefined, undefined, { binaryPath: tools.binary, executablePath: tools.chrome ?? "" });
const api = fixtureApi(fixture.info.url);
let preview, env;
const waitUntil = async (ready, ms = 30_000) => {
  const end = performance.now() + ms;
  while (!await ready()) {
    if (performance.now() > end) throw new Error("send timeline timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const round = (value) => value === null || value === undefined ? null : Math.round(value);
try {
  const created = await runControlMadani(["new-bot", "--name", "Pepper", "--url", fixture.info.url]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots.find((candidate) => candidate.id === created.bot.id);
  if (!bot?.threadId) throw new Error("fixture bot has no thread");
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
  preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__send-timeline.html", title: "Send timeline", logLevel: "error" });
  env = sessionEnv({ home: fixture.info.dataDir, session: `st-${fixture.info.pid}`, chrome: tools.chrome });
  const browser = (args, timeout) => agentBrowser(tools.binary, env, args, timeout);
  await browser(["open", preview.previewUrl], 120_000);
  const box = 'textarea[aria-label="Message Pepper"]';
  await waitUntil(async () => (await browser(["eval", `Boolean(document.querySelector('${box}'))`])).result);
  await browser(["eval", `(() => {
    const delay = ${postDelay};
    if (delay > 0) {
      const real = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const send = init?.method === 'POST' && /\\/api\\/bots\\/[^/]+\\/messages$/.test(url);
        return send ? new Promise((resolve) => setTimeout(resolve, delay)).then(() => real(input, init)) : real(input, init);
      };
    }
    const probe = window.__timeline = { runs: [] };
    document.querySelector('${box}').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) probe.runs.push({ enter: performance.now(), text: event.target.value, bubble: null, row: null, reply: null, replies: new Set([...document.querySelectorAll('[data-mid]')].map((n) => n.getAttribute('data-mid'))) });
    }, true);
    const look = () => {
      const run = probe.runs.at(-1);
      if (!run) return;
      const now = performance.now();
      if (run.bubble === null && [...document.querySelectorAll('[data-mid]')].some((n) => n.textContent?.includes(run.text))) run.bubble = now;
      if (run.row === null && document.querySelector('.turn-presence')) run.row = now;
      if (run.reply === null && [...document.querySelectorAll('[data-mid]')].some((n) => !run.replies.has(n.getAttribute('data-mid')) && !n.textContent?.includes(run.text) && n.textContent?.trim())) run.reply = now;
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;
  })()`]);
  for (let i = 0; i < count; i++) {
    await browser(["type", box, `Timeline fixture ${i}`]);
    await browser(["press", "Enter"]);
    await waitUntil(async () => (await browser(["eval", `Boolean(window.__timeline.runs[${i}]?.reply)`])).result);
    await runControlMadani(["wait", "--bot", bot.id, "--timeout", "30", "--url", fixture.info.url]);
    await waitUntil(async () => !(await browser(["eval", `Boolean(document.querySelector('.turn-presence'))`])).result, 10_000);
  }
  const { result } = await browser(["eval", "window.__timeline.runs.map((r) => ({ bubble: r.bubble - r.enter, row: r.row === null ? null : r.row - r.enter, reply: r.reply - r.enter }))"]);
  const samples = result.map((run, i) => ({ i, enterToBubbleMs: round(run.bubble), enterToWorkingRowMs: round(run.row), enterToFirstReplyMs: round(run.reply) }));
  console.log(JSON.stringify({ postDelayMs: postDelay, samples }, null, 2));
} finally {
  if (env) await closeBrowserSession(tools.binary, env);
  await preview?.close();
  await fixture.close();
}
