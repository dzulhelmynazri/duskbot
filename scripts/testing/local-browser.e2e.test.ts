import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlMadani, type VerificationServer } from "../control-madani.ts";

const binaryPath = process.env.MADANI_VERIFY_BROWSER_BINARY;
const executablePath = process.env.MADANI_VERIFY_BROWSER_CHROME;

it.skipIf(process.platform !== "darwin" || !binaryPath || !executablePath)("uses native local browser tools for a real form with no VPS or container commands", async () => {
  const page = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><title>Native browser fixture</title>
      <label>Name <input id="name"></label>
      <button id="greet" onclick="document.getElementById('result').textContent='Hello, '+document.getElementById('name').value">Say hello</button>
      <p id="result">Not submitted</p>`);
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
  let fixture: VerificationServer;
  try {
    fixture = await launchVerificationServer({ MADANI_TEST_LOCAL_BROWSER_GUARD: "1" }, undefined, undefined,
      { binaryPath: binaryPath!, executablePath: executablePath! }, { scripted: true });
  } catch (error) { await new Promise<void>((resolve) => page.close(() => resolve())); throw error; }
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  let evidence: unknown;
  try {
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "local-browser-guard.json"), "utf8"))).toEqual({ installed: true, platform: "darwin" });
    const config = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(config.vps?.sshAlias).toBeFalsy();
    expect(await api("GET", "/api/computers/vps")).toMatchObject({ configured: false, instances: [] });
    await api("PATCH", "/api/config", { features: { browser: true }, browserEngine: { engine: "agent-browser", egress: { allow: ["127.0.0.1"] } } });
    const bot = (await api("POST", "/api/bots", { name: "Native browser" })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: true, browserProfile: "guest", approvalMode: "full" });
    const steps = [
      { server: "browser", tool: "agent_browser_open", arguments: { url: origin } },
      { server: "browser", tool: "agent_browser_fill", arguments: { selector: "#name", text: "Native Mac" } },
      { server: "browser", tool: "agent_browser_click", arguments: { selector: "#greet" } },
      { server: "browser", tool: "agent_browser_get_text", arguments: { selector: "#result" } },
    ];
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [{ timeoutMs: 90_000, steps, reply: "LOCAL_BROWSER_VERIFIED" }] } }));
    await runControlMadani(["send", "--bot", bot.id, "--text", "Open the local form, enter Native Mac, submit and read the greeting.", "--url", fixture.info.url]);
    let turn: any;
    await expect.poll(() => {
      try { turn = JSON.parse(readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n")[0]!); return Boolean(turn); }
      catch { return false; }
    }, { timeout: 100_000, interval: 100 }).toBe(true);
    const actions = turn.evidence.filter((entry: any) => entry.step?.server === "browser");
    expect(actions.map((entry: any) => entry.step.tool)).toEqual(steps.map((step) => step.tool));
    for (const action of actions) expect(action.response.result?.isError, action.step.tool).not.toBe(true);
    const last = actions.at(-1).response.result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    expect(last).toContain("Hello, Native Mac");
    const dump = JSON.parse(readFileSync(join(fixture.info.dataDir, "fake-claude-dump.json"), "utf8"));
    const servers = Object.keys(dump.mcpConfig?.mcpServers ?? {});
    expect(servers).toContain("agents");
    expect(servers).toContain("browser");
    expect(servers).toContain("data");
    expect(servers).not.toContain("computer");
    expect(readFileSync(join(fixture.info.dataDir, "container-attempts.jsonl"), "utf8")).toBe("");
    evidence = { platform: process.platform, target: origin, actions: steps.map((step) => step.tool), readback: last,
      mountedServers: servers, configuredVps: false, containerCommands: 0, headlessBinary: executablePath };
  } finally {
    const path = `${fixture.info.logPath}.local-browser.json`;
    if (evidence) writeFileSync(path, JSON.stringify(evidence, null, 2));
    await promisify(execFile)(binaryPath!, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir,
      TMPDIR: join(fixture.info.dataDir, "tmp"), PATH: process.env.PATH }, timeout: 15_000 }).catch(() => {});
    await fixture.close();
    await new Promise<void>((resolve) => page.close(() => resolve()));
    expect(existsSync(fixture.info.dataDir)).toBe(false);
    console.info(JSON.stringify({ evidencePath: path, serverLog: fixture.info.logPath }));
  }
}, 130_000);

it.skipIf(process.platform !== "darwin" || !binaryPath || !executablePath)("runs a form in one batch call and waits out a self-clearing bot check, on the default engine", async () => {
  const pages: Record<string, string> = {
    "/": `<!doctype html><title>Sign up</title><label>Email <input id="email"></label>
      <button id="send" onclick="document.getElementById('result').textContent='Thanks, '+document.getElementById('email').value">Send</button>
      <p id="result">Not sent</p>`,
    "/gate": `<!doctype html><title>Just a moment...</title><div id="challenge-running">Checking if the site connection is secure</div>
      <script>setTimeout(() => location.replace("/inside"), 2500);</script>`,
    "/inside": `<!doctype html><title>Store</title><h1>Store front</h1><a href="/cart">Cart</a>`,
  };
  const page = createServer((req, res) => {
    const body = pages[new URL(req.url ?? "/", "http://fixture").pathname];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body ?? "missing");
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
  let fixture: VerificationServer;
  try {
    fixture = await launchVerificationServer({ MADANI_TEST_LOCAL_BROWSER_GUARD: "1" }, undefined, undefined,
      { binaryPath: binaryPath!, executablePath: executablePath! }, { scripted: true });
  } catch (error) { await new Promise<void>((resolve) => page.close(() => resolve())); throw error; }
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  try {
    await api("PATCH", "/api/config", { features: { browser: true }, browserEngine: { egress: { allow: ["127.0.0.1"] } } });
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).browserEngine?.engine).toBeUndefined();
    const bot = (await api("POST", "/api/bots", { name: "Batch browser" })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: true, browserProfile: "guest", approvalMode: "full" });
    const steps = [
      { server: "browser", tool: "agent_browser_batch", arguments: { steps: [
        { do: "open", url: origin }, { do: "fill", selector: "#email", text: "ada@example.com" }, { do: "click", selector: "#send" }, { do: "get_text", selector: "#result" },
      ] } },
      { server: "browser", tool: "agent_browser_open", arguments: { url: `${origin}/gate` } },
    ];
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [{ timeoutMs: 90_000, steps, reply: "BATCH_VERIFIED" }] } }));
    await runControlMadani(["send", "--bot", bot.id, "--text", "Sign up with ada@example.com, then open the store.", "--url", fixture.info.url]);
    let turn: any;
    await expect.poll(() => {
      try { turn = JSON.parse(readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n")[0]!); return Boolean(turn); }
      catch { return false; }
    }, { timeout: 100_000, interval: 100 }).toBe(true);
    const actions = turn.evidence.filter((entry: any) => entry.step?.server === "browser");
    expect(actions.map((entry: any) => entry.step.tool)).toEqual(["agent_browser_batch", "agent_browser_open"]);
    const text = (action: any) => action.response.result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    expect(actions[0].response.result.isError, text(actions[0])).not.toBe(true);
    expect(text(actions[0])).toMatch(/^Ran all 4 steps in \d+\.\d s\./);
    expect(text(actions[0])).toMatch(/4\. get_text: .*Thanks, ada@example\.com/);
    expect(actions[1].response.result.isError, text(actions[1])).not.toBe(true);
    expect(text(actions[1])).toMatch(/The site ran a Cloudflare bot check first; it cleared by itself after [2-5] s\./);
    expect(text(actions[1])).toContain(`link "Cart"`);
  } finally {
    await promisify(execFile)(binaryPath!, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir,
      TMPDIR: join(fixture.info.dataDir, "tmp"), PATH: process.env.PATH }, timeout: 15_000 }).catch(() => {});
    await fixture.close();
    await new Promise<void>((resolve) => page.close(() => resolve()));
  }
}, 130_000);
