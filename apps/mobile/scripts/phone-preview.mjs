import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const vitePath = fileURLToPath(new URL("../../../node_modules/.bin/vite", import.meta.url));
const children = new Set();
let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    stop(signal);
  });
}
process.once("exit", () => {
  for (const child of children) child.kill("SIGTERM");
});

function start(command, args, env) {
  const child = spawn(command, args, { cwd: repoRoot, env, stdio: ["inherit", "pipe", "pipe"] });
  children.add(child);
  child.stderr.pipe(process.stderr);
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  child.once("close", (code) => {
    children.delete(child);
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
  return child;
}

function portFromUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("workspace URL must use http or https");
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

/** what the fixture's fake engine says, in order, so every seeded chat reads like a real one */
const REPLIES = [
  "Morning! Three things need you today: the **launch note** draft, two invoices to approve, and a reply to Priya about Thursday.",
  "Drafted the launch note. It leads with the new phone app and keeps it under 150 words. Want me to send it to the team channel?",
  "Build is green again. The flaky test was a race in the upload retry; I pinned the timer and added a regression test.",
  "This month's spend is $1,284, up 6% on October. Most of it is the design tools renewal; nothing looks off.",
  "Inbox is down to 4. I archived the newsletters and flagged one from the bank that looks like it needs you.",
  "Booked the dentist for Tuesday at 9:30 and added it to your calendar with a 30 minute reminder.",
  "Found 3 flats under budget near the station. The second one has the balcony you wanted.",
  "Here is the plan for Friday: demo at 10, retro at 2, and I will collect everyone's notes before then.",
  "Here's the launch plan, step by step:\n\n1. **Thursday evening**: freeze the build and run the full test pass.\n2. **Friday 9:00**: I post the launch note to the team channel and the changelog.\n3. **Friday 10:00**: demo, then the phone app goes live in both stores.\n4. **Friday afternoon**: I watch sign-ups and crash reports and ping you if anything looks off.\n\nWant me to block the time in everyone's calendar?",
  "Done. Calendars are blocked for Friday 9:00 to 11:00, and I added the demo link to the invite. I'll send a short reminder on Thursday at 5pm so nobody forgets to freeze their branches.",
  "Three things stood out this week: sign-ups are up 18%, the onboarding drop-off moved from step two to step four, and support tickets about pairing halved after the new code screen. I'd look at step four first; most people who leave there never opened the camera.",
];

/** A believable team for the preview: bots with chats, two pinned, and one room. Nothing here runs outside the fixture. */
const TEAM = [
  { name: "Nova", color: "pink", text: "What needs my attention today?", pinned: true },
  { name: "Quill", color: "orange", text: "Draft a short note to the team about Friday's launch" },
  { name: "Rivet", color: "teal", text: "Check the build logs and tell me what broke", pinned: true },
  { name: "Tally", color: "brown", text: "Summarise this month's spend" },
  { name: "Echo", color: "purple", text: "Clean up my inbox" },
  { name: "Juno", color: "red", text: "Book the dentist for next week" },
  { name: "Basil", color: "green", text: "Find flats under 2,000 near the station" },
];

async function seedFixture(url) {
  const call = async (path, body, patch = false) => {
    const res = await fetch(new URL(path, url), { method: patch ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${patch ? "PATCH" : "POST"} ${path}: ${res.status}`);
    return res.json().catch(() => ({}));
  };
  const made = [];
  for (const bot of TEAM) {
    const { bot: created } = await call("/api/bots", { name: bot.name, color: bot.color });
    if (bot.pinned) await call(`/api/bots/${encodeURIComponent(created.id)}`, { pinned: true }, true).catch(() => {});
    made.push({ ...bot, id: created.id });
  }
  for (const bot of made) {
    await call(`/api/bots/${encodeURIComponent(bot.id)}/messages`, { text: bot.text });
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await call("/api/groups", { name: "Launch room", memberIds: made.filter((b) => ["Nova", "Quill", "Rivet"].includes(b.name)).map((b) => b.id) }).catch(() => {});
  console.log(`seeded ${made.length} bots with chats and a room`);
}

let fixtureUrl = null;

async function fixturePort() {
  const child = start(process.execPath, ["--experimental-strip-types", "scripts/control-madani.ts", "launch"], {
    ...process.env,
    FAKE_CLAUDE_REPLIES: JSON.stringify(REPLIES),
    FAKE_CLAUDE_REPLY_STATE: join(mkdtempSync(join(tmpdir(), "madani-phone-preview-")), "replies"),
  });
  return new Promise((resolve, reject) => {
    let output = "";
    // resolves with the port; `url` is kept for seeding
    const timeout = setTimeout(() => onError(new Error("fixture did not print its URL within 90 seconds")), 90_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error("fixture exited before printing its URL"));
    const onData = (chunk) => {
      output += chunk.toString();
      let info;
      try { info = JSON.parse(output); } catch { return; }
      if (typeof info.url !== "string") return;
      try {
        const port = portFromUrl(info.url);
        cleanup();
        fixtureUrl = info.url;
        resolve(port);
      } catch (error) { onError(error); }
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

try {
  const args = process.argv.slice(2);
  let fixture = false;
  let workspaceUrl;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--") continue;
    if (args[index] === "--fixture") fixture = true;
    else if (args[index] === "--url" && args[index + 1]) workspaceUrl = args[++index];
    else throw new Error(`unknown or incomplete argument: ${args[index]}`);
  }
  if (fixture && workspaceUrl) throw new Error("choose either --fixture or --url");
  const port = fixture ? await fixturePort() : workspaceUrl ? portFromUrl(workspaceUrl) : process.env.MADANI_PORT || "8799";
  if (fixture && fixtureUrl) await seedFixture(fixtureUrl).catch((error) => console.error(`seeding the fixture failed: ${error.message}`));
  if (!stopping) {
    const vite = start(vitePath, ["--config", "apps/mobile/vite.config.ts"], { ...process.env, MADANI_PORT: port });
    let output = "";
    let ready = false;
    vite.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk.toString();
      if (!ready && output.includes("ready in")) {
        ready = true;
        console.log(`phone preview: http://127.0.0.1:${Number(process.env.MADANI_MOBILE_PORT) || 5320}/phone.html`);
      }
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  stop();
}
