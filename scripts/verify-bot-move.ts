// "Bring your bots" on an isolated fake-engine server whose home holds OpenClaw (2026.3), Hermes Agent, Claude Code's
// and Gemini CLI's agents and commands, and a left-behind ~/.openmausbot, planted from server/testing/agent-app-fixtures.ts.
// The server runs as the desktop app's own (owner token), so the bots look answers; the preview's bridge marks the window
// as that computer's.
// Run: node --experimental-strip-types scripts/verify-bot-move.ts
import { randomBytes } from "node:crypto";
import { launchVerificationServer, verificationHome } from "./control-madani.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";
import { plantAgentTools, plantHermes, plantOpenClawList, plantOpenMausBot, plantRealShape } from "../server/testing/agent-app-fixtures.ts";

const owner = randomBytes(32).toString("base64url");
const env = { ...process.env, MADANI_TEST_DESKTOP_OWNER_TOKEN: owner };
// as the desktop app's own window: every request to the fixture carries the owner token
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-madani-desktop-owner": owner } });
const fixture = await launchVerificationServer(env);
const home = verificationHome(env, fixture.info.dataDir);
// MADANI_FIXTURE=real-shape: a home in the shape of a real desktop's, synthetic values only
if (process.env.MADANI_FIXTURE === "real-shape") plantRealShape(home);
else {
  plantOpenClawList(home);
  plantHermes(home);
  plantOpenMausBot(home);
  plantAgentTools(home);
}
// a new install: the welcome not yet seen, and the starter bot under its own name
const call = (path: string, method: string, body: unknown) => fetch(`${fixture.info.url}${path}`, {
  method, headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify(body),
});
await call("/api/config", "PUT", { onboarding: { completedAt: "", version: 0, hintsSeen: [] } });
const { bots } = await (await fetch(`${fixture.info.url}/api/bots`, { headers: { origin: fixture.info.url } })).json() as { bots: Array<{ id: string; defaultBot?: unknown }> };
for (const bot of bots.filter((one) => one.defaultBot)) await call(`/api/bots/${bot.id}/profile`, "PATCH", { name: "Madani" });
let ui: MountedPreview | undefined;
try {
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/bot-move-preview.tsx", route: "/__bot-move.html", title: "Isolated bot move",
    proxyHeaders: { "x-madani-desktop-owner": owner }, hmr: false,
  });
  console.log(JSON.stringify({ ...fixture.info, home, previewUrl: ui.previewUrl }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
