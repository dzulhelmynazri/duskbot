import assert from "node:assert/strict";
import { spawn } from "node:child_process";

export const driver = "/usr/local/libexec/madanibot/cua-driver";
export const socket = "/run/user/1000/madanibot-cua.sock";
const page = `<!doctype html><meta charset="utf-8"><title>Isolated browser fixture</title>
<style>body{padding:40px;font:24px sans-serif}input,button{font:inherit;margin:12px;padding:12px}</style>
<h1>Isolated fixture form</h1><form action="/submitted"><label>Fixture name <input name="name" aria-label="Fixture name"></label><button>Save fixture</button></form>`;
export const httpFixture = `from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from html import escape
import json
PAGE = ${JSON.stringify(page)}
class Handler(BaseHTTPRequestHandler):
    timeout = 5
    def do_GET(self):
        parsed = urlparse(self.path)
        cookie = None
        if parsed.path == "/cookie":
            value = parse_qs(parsed.query).get("value", [""])[0]
            cookie = "FixtureScreen=" + value + "; Path=/; SameSite=Strict; Max-Age=3600"
            content = "<!doctype html><title>Cookie set</title><h1>Cookie set " + escape(value) + "</h1>"
        elif parsed.path == "/observe":
            value = self.headers.get("Cookie", "")
            screen = parse_qs(parsed.query).get("screen", ["primary"])[0]
            if not screen.isdigit() or not 2 <= int(screen) <= 21:
                screen = "primary"
            Path("/tmp/cookie-" + screen + ".json").write_text(json.dumps({"cookie": value}))
            content = "<!doctype html><title>Cookie observed</title><h1>Cookie observed " + escape(value) + "</h1>"
        elif parsed.path == "/shared":
            value = Path("/home/cua/shared-fixture.txt").read_text()
            content = "<!doctype html><title>Shared file</title><h1>" + escape(value) + "</h1>"
        elif parsed.path == "/submitted":
            value = parse_qs(parsed.query).get("name", [""])[0]
            Path("/tmp/submission.json").write_text(json.dumps({"value": value}))
            content = "<!doctype html><title>Saved " + escape(value) + "</title><h1>Saved " + escape(value) + "</h1>"
        else:
            content = PAGE
        encoded = content.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(encoded)
    def log_message(self, *args):
        pass
server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
server.daemon_threads = True
server.serve_forever()
`;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function closeFixtureBrowser(binary, home, botId) {
  const { browserSessionId, closeBrowserSession } = await import("../../server/browser-engine.ts");
  assert.equal(await closeBrowserSession(binary, { ...process.env, HOME: home, USERPROFILE: home, AGENT_BROWSER_SESSION: browserSessionId(botId, "") }), true, "owned fixture browser daemon did not close");
}

export async function eventually(read, match, description, timeout = 15_000) {
  const deadline = performance.now() + timeout;
  let last;
  for (;;) {
    try { last = await read(); if (match(last)) return last; } catch (error) { last = error; }
    if (performance.now() >= deadline) throw new Error(`${description}: ${JSON.stringify(last)}`);
    await sleep(100);
  }
}

export async function connectMcp(container, endpoint = socket) {
  const child = spawn("docker", ["exec", "-i", "-u", "1000:1000", "-e", "CUA_DRIVER_RS_TELEMETRY_ENABLED=0", container,
    driver, "mcp", "--socket", endpoint], { stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 0;
  let buffer = "";
  const pending = new Map();
  child.stderr.resume();
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 25_000);
    pending.set(id, message => {
      clearTimeout(timer);
      pending.delete(id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "madani-desktop-fixture", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    list: () => rpc("tools/list", {}),
    async call(name, args) {
      const answer = await rpc("tools/call", { name, arguments: args });
      assert.notEqual(answer.isError, true, `${name}: ${JSON.stringify(answer.content)}`);
      if (answer.structuredContent) return answer.structuredContent;
      const output = answer.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
      return output ? JSON.parse(output) : null;
    },
    async close() {
      child.stdin.end();
      if (child.exitCode !== null) return;
      await Promise.race([new Promise(resolve => child.once("close", resolve)), sleep(1000)]);
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}
