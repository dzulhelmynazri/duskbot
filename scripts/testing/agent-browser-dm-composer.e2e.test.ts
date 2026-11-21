// Two conversations of one bot sharing its agent-browser, against the pinned agent-browser and its Chrome: one reads a
// DM thread whose composer is a contenteditable the page swaps on focus and on re-render, the other opens a page of its
// own (a tab switch, which clears the engine's refs), and the first then clicks and types a multi-line draft with the
// refs it read before. A later turn of the same conversation keeps its refs, since its tab is already in front. Runs
// when agent-browser resolves (tools directory, MADANI_AGENT_BROWSER_PATH or PATH) or MADANI_UI_E2E=1 asks for the
// download; otherwise skipped.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentBrowserIntegration, closeBrowserSession, prepareBrowserSessionState, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { relay, RelayPorts, relayTarget } from "../../server/browser-relay.ts";
import { BrowserRuntime, browserRuntimeEnv, type BrowserSpawnSpec } from "../../server/browser-runtime.ts";
import { stepContext } from "../../server/browser-steps.ts";
import { openGate, type EgressGate } from "../../server/browser/egress/gate.ts";
import { refusalFor } from "../../server/browser/egress/policy.ts";
import { threadPage } from "../../server/browser/testing/dm-composer.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-madani-ui.ts";

const forced = process.env.MADANI_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) {
  console.log(`skipping agent-browser DM composer e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, MADANI_AGENT_BROWSER_PATH and PATH); set MADANI_UI_E2E=1 to install the pinned release`);
}
const run = enabled ? it : it.skip;
const posix = process.platform !== "win32";

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };

describe("a DM composer a bot types into with refs from before another conversation used its browser", () => {
  let server: Server;
  let base = "";
  let home = "";
  let sockets = "";
  let spec: BrowserSpawnSpec;
  let runtime: BrowserRuntime;
  let gate: EgressGate | undefined;
  const session = `madani-dm-${randomBytes(3).toString("hex")}`;

  beforeAll(async () => {
    if (!enabled) return;
    const browser = await ensureUiBrowser(process.env, () => {}, UI_TOOLS_DIR);
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(req.url === "/other" ? "<!doctype html><title>Other</title><button>Elsewhere</button>" : threadPage("page"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    home = mkdtempSync(join(tmpdir(), "madani-dm-e2e-"));
    // Unix socket paths must stay short (macOS temp paths are long).
    sockets = mkdtempSync(join(posix ? "/tmp" : tmpdir(), "madani-dm-"));
    mkdirSync(join(home, "tmp"), { recursive: true });
    gate = await openGate({ decide: (destination, addresses) => refusalFor(destination, addresses, {
      host: "desktop", ownPort: () => false, botPort: async () => false, localNetwork: true, allowed: () => false,
    }) });
    const integration = agentBrowserIntegration({
      binaryPath: browser.binary, session, encryptionKey: randomBytes(32).toString("hex"), persistent: false, egressPort: gate.port,
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...(browser.chrome ? { AGENT_BROWSER_EXECUTABLE_PATH: browser.chrome } : {}) },
    });
    spec = { ...integration, env: { ...integration.env, HOME: home, USERPROFILE: home, TMPDIR: join(home, "tmp"), AGENT_BROWSER_SOCKET_DIR: sockets } };
    await prepareBrowserSessionState(browser.binary, session, { env: spec.env, persistent: false });
    runtime = new BrowserRuntime({
      closeBrowser: (name, value) => closeBrowserSession(value.command, browserRuntimeEnv({ ...value.env, AGENT_BROWSER_SESSION: name })),
    });
  }, 600_000);

  afterAll(async () => {
    if (!enabled) return;
    await closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session })).catch(() => false);
    await runtime?.closeAll();
    await new Promise((resolve) => server?.close(resolve));
    await gate?.close();
    await removeTempDir(home);
    await removeTempDir(sockets);
  }, 60_000);

  const bot = { id: "bot-e2e", name: "E2E" };
  const call = (threadId: string, generation: string, name: string, args: Record<string, unknown> = {}) =>
    runtime.agentRpc(session, spec, "tools/call", { name: `agent_browser_${name}`, arguments: args }, undefined,
      stepContext(bot, { threadId, generation }, () => null)) as Promise<Result>;
  const text = (result: Result) => result.content.map((part) => part.text ?? "").join("\n");
  /** Read past the runtime, in the tab in front. */
  const page = async <T>(script: string): Promise<T> => {
    const port = await new RelayPorts().port(relayTarget(spec, session));
    if (!port) throw new Error("the browser's daemon has no relay port");
    return (await relay(port, { action: "evaluate", script }, { timeoutMs: 20_000 })).data?.result as T;
  };

  run("clicks and types a multi-line draft with refs read before another conversation switched tabs, and keeps them on a later turn", async () => {
    expect(text(await call("a", "g1", "open", { url: `${base}/thread` }))).toContain("Page observed after navigation.");
    const read = text(await call("a", "g1", "snapshot"));
    const composer = /textbox "Message" \[ref=(e\d+)\]/u.exec(read)?.[1];
    expect(composer, read).toBeTruthy();

    expect(text(await call("b", "g1", "open", { url: `${base}/other` }))).toContain("Page observed after navigation.");

    const clicked = await call("a", "g1", "click", { selector: `@${composer}` });
    expect(clicked.isError, text(clicked)).not.toBe(true);
    expect(await page<string>("document.title")).toBe("Messages");
    await page("dm.rerender()");
    const typed = await call("a", "g1", "type", { selector: `@${composer}`, text: "hey there\nsecond line" });
    expect(typed.isError, text(typed)).not.toBe(true);
    expect(await page<string>("dm.draft()")).toBe("hey there\nsecond line");
    expect(await page<string[]>("dm.sent")).toEqual([]);

    // A new turn of the same conversation: its tab is in front, so nothing clears the refs it holds.
    await page("dm.rerender()");
    const more = await call("a", "g2", "type", { selector: `@${composer}`, text: " and more" });
    expect(more.isError, text(more)).not.toBe(true);
    expect(await page<string>("dm.draft()")).toBe("hey there\nsecond line and more");

    // A ref with no single match after a switch is refused rather than sent to whatever the new numbering names.
    expect(text(await call("b", "g1", "snapshot"))).toContain("Elsewhere");
    const missing = await call("a", "g2", "click", { selector: "@e999" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("Take a fresh snapshot");
  }, 300_000);
});
