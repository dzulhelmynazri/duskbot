// A provider CLI's own browser sign-in ends on http://localhost:<port>/<path> on the machine running the CLI. When
// the browser is on another computer (madani cloud, the person's server), the desktop app listens on that same port
// there and hands the callback here over the authenticated link; this file checks it belongs to the sign-in and gives
// it to the CLI's own listener. The CLI does its own token exchange: no token ever crosses the link, and none is logged.
import { request } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Loopback {
  port: number;
  path: string;
  /** The state the provider sends back; a callback without it is not this sign-in's. */
  state: string | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The loopback a provider authorize link sends the browser back to, or null when it goes anywhere else. */
export function loopbackOf(authorizationUrl: string | null | undefined): Loopback | null {
  if (!authorizationUrl) return null;
  try {
    const url = new URL(authorizationUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const redirects = url.searchParams.getAll("redirect_uri");
    if (redirects.length < 1 || new Set(redirects).size !== 1) return null;
    const redirect = new URL(redirects[0]!);
    const port = Number(redirect.port);
    if (redirect.protocol !== "http:" || !LOOPBACK_HOSTS.has(redirect.hostname) || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
    const states = new Set(url.searchParams.getAll("state"));
    return { port, path: redirect.pathname || "/", state: states.size === 1 ? [...states][0]! : null };
  } catch {
    return null;
  }
}

/** Whether a pasted or relayed value is a loopback callback URL rather than a code. */
export function isLoopbackCallback(value: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\//i.test(value.trim());
}

type Get = (port: number, host: string, pathAndQuery: string) => Promise<{ status: number; location: string | null }>;

const get: Get = (port, host, pathAndQuery) => new Promise((resolve, reject) => {
  const req = request({ host, port, path: pathAndQuery, method: "GET", headers: { host: `localhost:${port}` }, timeout: 45_000 }, (res) => {
    res.resume();
    const location = typeof res.headers.location === "string" ? res.headers.location : null;
    res.once("end", () => resolve({ status: res.statusCode ?? 0, location }));
    res.once("error", reject);
  });
  req.once("timeout", () => req.destroy(new Error("timeout")));
  req.once("error", reject);
  req.end();
});

/** Hands a relayed callback to the CLI listening on this machine. Answers the https page the CLI sends the browser on
 * to, if any; its own same-port pages (Codex's /success) are fetched here so the CLI can finish, never shown. */
export function checkLoopbackCallback(expected: Loopback, callbackUrl: string): URL {
  if (callbackUrl.length > 16_384) throw new Error("The sign-in response is too long.");
  let callback: URL;
  try { callback = new URL(callbackUrl); } catch { throw new Error("This sign-in response is not valid. Start sign-in again."); }
  if (callback.protocol !== "http:" || !LOOPBACK_HOSTS.has(callback.hostname) || Number(callback.port) !== expected.port
    || callback.pathname !== expected.path || callback.username || callback.password
    || (expected.state !== null && callback.searchParams.get("state") !== expected.state)) {
    throw new Error("This sign-in response does not belong to the current sign-in. Start sign-in again.");
  }
  return callback;
}

export async function forwardLoopbackCallback(expected: Loopback, callbackUrl: string, fetchLoopback: Get = get): Promise<string | undefined> {
  const callback = checkLoopbackCallback(expected, callbackUrl);
  let target = `${callback.pathname}${callback.search}`;
  for (let hop = 0; hop < 3; hop++) {
    let answer: Awaited<ReturnType<Get>> | null = null;
    let lastError: unknown = null;
    // the CLI may listen on either loopback family
    for (const host of ["127.0.0.1", "::1"]) {
      try { answer = await fetchLoopback(expected.port, host, target); break; } catch (error) { lastError = error; }
    }
    if (!answer) throw Object.assign(new Error("The sign-in on the server stopped before it could finish. Start sign-in again."), { cause: lastError });
    if (answer.status >= 400) throw new Error("The provider did not accept this sign-in. Start sign-in again.");
    if (!answer.location) return undefined;
    let next: URL;
    try { next = new URL(answer.location, `http://localhost:${expected.port}`); } catch { return undefined; }
    if (next.protocol === "https:") return next.href;
    if (next.protocol !== "http:" || !LOOPBACK_HOSTS.has(next.hostname) || Number(next.port) !== expected.port) return undefined;
    target = `${next.pathname}${next.search}`;
  }
  return undefined;
}

/** A $BROWSER that records the link a CLI would open instead of opening anything, so a server never opens a window
 * and the app opens the link where the person is. POSIX only; Windows CLIs keep their own behaviour. */
export function browserRecorder(): { env: Record<string, string>; read(): string | null; dispose(): void } | null {
  if (process.platform === "win32") return null;
  const dir = mkdtempSync(join(tmpdir(), "madani-signin-"));
  chmodSync(dir, 0o700);
  const script = join(dir, "open");
  const file = join(dir, "link");
  writeFileSync(script, `#!/bin/sh\nprintf '%s' "$1" > "${file}.tmp" && mv "${file}.tmp" "${file}"\n`, { mode: 0o700 });
  return {
    env: { BROWSER: script },
    read: () => { try { return readFileSync(file, "utf8").trim() || null; } catch { return null; } },
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}
