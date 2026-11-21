// The desktop's own UI against an older server: launches that server from another checkout (a git worktree at an older
// commit or release) on a free port with its own built UI and the fake engine, adds a test bot there, then opens this
// checkout's built UI at that server's origin in a hidden Electron window (electron/local-ui.mjs) and drives the core
// flows: list bots, open a chat, attach a file, send, see the streamed reply.
//
//   node --experimental-strip-types scripts/testing/local-ui-old-server.mjs --old /tmp/madani-old --old-ui /tmp/old-dist --ui dist
//
// The old checkout needs its own node_modules; both UIs are prebuilt (`vite build --outDir ...`).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { old: { type: "string" }, "old-ui": { type: "string" }, ui: { type: "string", default: "dist" } } });
if (!values.old || !values["old-ui"]) throw new Error("--old and --old-ui are required");
const root = path.resolve(import.meta.dirname, "../..");
const oldRoot = path.resolve(values.old), oldUi = path.resolve(values["old-ui"]), newUi = path.resolve(root, values.ui);
for (const dir of [oldUi, newUi]) if (!existsSync(path.join(dir, "index.html"))) throw new Error(`${dir} has no built UI`);
if (readFileSync(path.join(oldUi, "index.html"), "utf8") === readFileSync(path.join(newUi, "index.html"), "utf8")) throw new Error("the two UIs are the same build");

function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    let info;
    try { info = statSync(file); } catch { continue; }
    if (!info.isDirectory() && !info.isFile()) continue;
    if (info.isDirectory()) filesUnder(file, out);
    else if (info.size < 20_000_000) { try { out.push({ name, text: readFileSync(file, "latin1") }); } catch {} }
  }
  return out;
}

const launcherFile = ["scripts/control-madani.ts", "scripts/control-omb.ts"].map((file) => path.join(oldRoot, file)).find(existsSync);
if (!launcherFile) throw new Error("the old checkout has no fixture launcher");
const launcher = await import(launcherFile);
const reply = "Local UI reply from the older server, streamed in small pieces so the page shows it arriving.";
const env = { ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify([reply]), FAKE_CLAUDE_STREAM_CADENCE: "2:120", FAKE_CLAUDE_TOOL_CALLS: "[]" };
// releases add optional parameters before the static UI folder, so it goes in by name
const params = /^[^(]*\(([\s\S]*?)\)\s*\{/.exec(launcher.launchVerificationServer.toString())[1]
  .replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((part) => part.trim().split(/[\s=]/)[0]).filter(Boolean);
const args = params.map((name) => (name === "parentEnv" ? env : name === "staticDir" ? oldUi : undefined));
if (!params.includes("staticDir")) throw new Error("the old launcher cannot serve a built UI");
const fixture = await launcher.launchVerificationServer(...args);
const server = fixture.info.url;
const described = await Promise.any(["madanibot", "openmausbot"].map(async (name) => { const response = await fetch(`${server}/.well-known/${name}/environment`); if (!response.ok) throw new Error(); return response.json(); })).catch(() => ({}));
console.log(`old server ${server} version ${described.version} data ${fixture.info.dataDir}`);
const api = async (method, route, body) => {
  const response = await fetch(`${server}${route}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${answer.error ?? ""}`);
  return answer;
};
let code = 1;
try {
  await api("PATCH", "/api/config", { language: "en" });
  const botName = "Pepper";
  const { bot } = await api("POST", "/api/bots", {});
  await api("PATCH", `/api/bots/${bot.id}`, { name: botName });
  const text = `hello from the new desktop UI ${Date.now().toString(36)}`;
  const electron = createRequire(import.meta.url)("electron");
  const child = spawn(electron, ["--use-mock-keychain", "--password-store=basic", path.join(root, "scripts/testing/local-ui-window")], {
    env: { ...process.env, LUI_SERVER: server, LUI_UI_DIR: newUi, LUI_BOT: botName, LUI_TEXT: text, LUI_REPLY: reply, ELECTRON_ENABLE_LOGGING: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  await new Promise((resolve) => child.on("exit", resolve));
  const line = out.split("\n").find((entry) => entry.startsWith("LUI_RESULT ") || entry.startsWith("LUI_FAILED "));
  if (!line?.startsWith("LUI_RESULT ")) throw new Error(line ?? `the window said nothing\n${out}`);
  const result = JSON.parse(line.slice("LUI_RESULT ".length));
  // what the server kept, read from its own data folder: the route that lists a chat differs between releases
  const kept = filesUnder(fixture.info.dataDir);
  result.serverGotMessage = kept.some((file) => file.text.includes(text));
  result.serverGotFile = kept.some((file) => file.text.includes("local ui upload fixture"));
  result.messageNamesFile = kept.some((file) => file.text.includes(text) && file.text.includes("local-ui-note.txt"));
  console.log(JSON.stringify(result, null, 2));
  const ok = result.origin === server && result.bundle && result.listedBots && result.openedChat && result.sent && result.replied && result.streamed && result.serverGotMessage && result.serverGotFile;
  console.log(ok ? "PASS: the new UI works against the older server" : "FAIL");
  code = ok ? 0 : 1;
} finally {
  await fixture.close();
}
process.exit(code);
