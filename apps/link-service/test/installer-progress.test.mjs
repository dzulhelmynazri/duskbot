import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const source = (await readFile(new URL("../install.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");
const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TERM: "dumb" };
const setup = `
TMP=$1
PROGRESS=$TMP/progress
LOG=$TMP/log
: > "$LOG"
MS=0
VPS_TOKEN=fixture
SECRET=fixture
LINK_ID=fixture
PROTO="=http,https"
sha256sum() { node -e 'const fs=require("fs"),crypto=require("crypto"); console.log(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex")+"  "+process.argv[1])' "$1"; }
`;

async function fixture(body, action) {
  const dir = await mkdtemp(join(tmpdir(), "omb-installer-progress-"));
  try {
    const file = join(dir, "fixture.sh");
    await writeFile(file, source + setup + body);
    return await action({ dir, file, run: (args = []) => run("sh", [file, dir, ...args], { env, timeout: 15000 }) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function until(read, predicate) {
  const end = Date.now() + 4000;
  let value;
  while (Date.now() < end) {
    value = await read().catch(() => undefined);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Fixture condition timed out: ${JSON.stringify(value)}`);
}

async function downloadFixture({ cached, partial, disconnect = false, corrupt = false, fail = false } = {}) {
  const content = Buffer.from("verified fixture bytes ".repeat(8192));
  const sha = createHash("sha256").update(content).digest("hex");
  const requests = [];
  let transferred = 0;
  const server = createServer((req, res) => {
    requests.push({ range: req.headers.range, authorization: req.headers.authorization });
    if (fail) { res.writeHead(503); res.end("fixture unavailable"); return; }
    const offset = Number(/^bytes=([0-9]+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
    res.writeHead(offset ? 206 : 200, { "content-length": content.length - offset,
      ...(offset ? { "content-range": `bytes ${offset}-${content.length - 1}/${content.length}` } : {}) });
    if (disconnect && requests.length === 1) {
      const first = content.subarray(0, content.length / 2);
      transferred += first.length;
      res.write(first);
      setTimeout(() => res.destroy(), 30);
    } else {
      transferred += content.length - offset;
      res.end(content.subarray(offset));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  try {
    return await fixture(`
sleep() { printf 'sleep %s\\n' "$*" >> "$TMP/retries"; }
verified_download "$2" "$TMP/archive" "$3" "$4" 5 fixture
`, async ({ dir, run: execute }) => {
      if (cached) await writeFile(join(dir, "archive"), content);
      if (partial) await writeFile(join(dir, "archive.part"), corrupt ? Buffer.alloc(partial, 120) : content.subarray(0, partial));
      const result = await execute([url, sha, String(content.length)]).catch((error) => error);
      const archive = await readFile(join(dir, "archive")).catch(() => null);
      const part = await readFile(join(dir, "archive.part")).catch(() => null);
      const retries = await readFile(join(dir, "retries"), "utf8").catch(() => "");
      return { result, archive, part, content, requests, transferred, retries };
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("installer progress and repair", () => {
  it("reports actual bytes and quiet time without treating a heartbeat as progress", async () => {
    const events = await fixture(`
now_ms() { cat "$TMP/clock"; }
post_event() { printf '%s\\n' "$1" >> "$TMP/events"; }
STEP_ID=app
STEP_T0=1000
LAST_ACTIVITY=1000
printf 1000 > "$TMP/clock"
printf abcde > "$TMP/archive.part"
progress file "$TMP/archive.part" 20
stream_lines final
printf 4000 > "$TMP/clock"
stream_lines final
printf fghij >> "$TMP/archive.part"
printf 4500 > "$TMP/clock"
stream_lines final
printf 'partial command output' >> "$LOG"
printf 5000 > "$TMP/clock"
stream_lines final
printf 8000 > "$TMP/clock"
stream_lines final
`, async ({ dir, run: execute }) => {
      await execute();
      return (await readFile(join(dir, "events"), "utf8")).trim().split("\n").map(JSON.parse);
    });
    expect(events.map((event) => event.progress.receivedBytes)).toEqual([5, 5, 10, 10, 10]);
    expect(events.map((event) => event.heartbeat)).toEqual([false, true, false, false, true]);
    expect(events.map((event) => event.activity.quietMs)).toEqual([0, 3000, 0, 0, 3000]);
    expect(events.at(-1).activity.elapsedMs).toBe(7000);
    expect(events.every((event) => event.lines.length === 0)).toBe(true);
  });

  it("streams real slow-download bytes and reports the quiet interval while the transfer stalls", async () => {
    const bytes = Buffer.alloc(65536, 97);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const events = [];
    const timers = new Set();
    const server = createServer((req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => { events.push(JSON.parse(body)); res.end("{}"); });
        return;
      }
      res.writeHead(200, { "content-length": bytes.length });
      res.write(bytes.subarray(0, 16384));
      timers.add(setTimeout(() => res.write(bytes.subarray(16384, 32768)), 3500));
      timers.add(setTimeout(() => res.end(bytes.subarray(32768)), 4500));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fixture(`
LINK_BASE=$2
FIXTURE_SHA=$3
LOGS=$TMP
PH_T0=$(now_ms)
state_set() { :; }
do_fixture() { verified_download "$LINK_BASE/archive" "$TMP/archive" "$FIXTURE_SHA" 65536 10 fixture; }
step app do_fixture
`, async ({ dir, run: execute }) => {
        await execute([base, sha]);
        expect(await readFile(join(dir, "archive"))).toEqual(bytes);
      });
      const updates = events.filter((event) => event.progress?.kind === "download");
      expect(updates.some((event) => event.progress.receivedBytes === 16384)).toBe(true);
      expect(updates.some((event) => event.progress.receivedBytes === 32768 && event.heartbeat === false)).toBe(true);
      expect(updates.some((event) => event.heartbeat === true && event.activity.quietMs >= 2000 && event.progress.receivedBytes === 16384)).toBe(true);
      expect(events.at(-1)).toMatchObject({ step: "app", status: "done" });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("counts completed Docker operations rather than started operation numbers", async () => {
    await fixture("install_output build\n", async ({ dir, file }) => {
      const child = spawn("sh", [file, dir], { env, stdio: ["pipe", "ignore", "pipe"] });
      const done = new Promise((resolve) => child.on("exit", resolve));
      try {
        child.stdin.write("#1 [internal] load definition\n#2 [1/3] RUN slow command\n");
        const read = async () => JSON.parse(await readFile(join(dir, "progress.json"), "utf8"));
        expect(await until(read, (value) => value?.total === 2)).toMatchObject({ kind: "build", completed: 0, total: 2 });
        child.stdin.end("#1 DONE 0.1s\n#1 DONE 0.1s\n#2 CACHED\n");
        expect(await done).toBe(0);
        expect(await read()).toMatchObject({ completed: 2, total: 2 });
      } finally { child.kill(); }
    });
  });

  it("preserves Docker layer bytes and counts each completed layer once", async () => {
    await fixture("install_output layers\n", async ({ dir, file }) => {
      const child = spawn("sh", [file, dir], { env, stdio: ["pipe", "ignore", "pipe"] });
      const done = new Promise((resolve) => child.on("exit", resolve));
      try {
        child.stdin.write("abc1: Pulling fs layer\r\nabc2: Already exists\nabc1: Downloading [====>] 1.5MB/3MB\n");
        const read = async () => JSON.parse(await readFile(join(dir, "progress.json"), "utf8"));
        expect(await until(read, (value) => value?.receivedBytes === 1500000)).toMatchObject({ kind: "layers", completed: 1, total: 2, totalBytes: 3000000 });
        child.stdin.end("abc1: Download complete\nabc1: Extracting\nabc1: Pull complete\nabc1: Pull complete\n");
        expect(await done).toBe(0);
        expect(await read()).toMatchObject({ completed: 2, total: 2, receivedBytes: 3000000 });
      } finally { child.kill(); }
    });
  });

  it("resumes an interrupted real HTTP download and verifies the completed archive", async () => {
    const result = await downloadFixture({ disconnect: true });
    expect(result.result.code).toBeUndefined();
    expect(result.archive).toEqual(result.content);
    expect(result.part).toBeNull();
    expect(result.requests.map((request) => request.range)).toEqual([undefined, `bytes=${result.content.length / 2}-`]);
    expect(result.requests.every((request) => request.authorization === "Bearer fixture")).toBe(true);
    expect(result.transferred).toBe(result.content.length);
    expect(result.result.stdout).toContain("attempt 1/5 failed (curl 18)");
    expect(result.result.stdout).toContain("sha256 verified");
  });

  it("repairs a corrupt partial cache by verifying it and retrying from zero", async () => {
    const result = await downloadFixture({ partial: 100, corrupt: true });
    expect(result.archive).toEqual(result.content);
    expect(result.requests.map((request) => request.range)).toEqual(["bytes=100-", undefined]);
    expect(result.result.stdout).toContain("checksum did not match");
  });

  it("reuses verified archives and promotes complete partial archives without requests", async () => {
    const cached = await downloadFixture({ cached: true });
    expect(cached.requests).toHaveLength(0);
    expect(cached.archive).toEqual(cached.content);
    const complete = await downloadFixture({ partial: cached.content.length });
    expect(complete.requests).toHaveLength(0);
    expect(complete.archive).toEqual(complete.content);
    expect(complete.part).toBeNull();
  });

  it("reports repeated download failures and keeps a resumable partial archive", async () => {
    const result = await downloadFixture({ partial: 100, fail: true });
    expect(result.result.code).toBe(1);
    expect(result.requests).toHaveLength(5);
    expect(result.part).toEqual(result.content.subarray(0, 100));
    expect(result.result.stdout).toContain("could not be downloaded and verified after 5 attempts");
    expect(result.retries).toBe("sleep 2\nsleep 5\nsleep 10\nsleep 20\n");
  });

  it("tries a download again over ipv4 after a broken tls handshake, and stays on ipv4 for the run", async () => {
    const out = await fixture(`
sleep() { printf 'sleep %s\\n' "$*" >> "$TMP/calls"; }
curl() { printf 'curl %s\\n' "$*" | sed 's/ -[^4][^ ]*//g' >> "$TMP/calls"; n=$(cat "$TMP/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$TMP/n"; [ "$n" -ge 2 ] || return 35; }
fetch https://link.example/agent.mjs "$TMP/agent.mjs"
fetch https://link.example/docker-gate.mjs "$TMP/gate.mjs"
`, async ({ dir, run: execute }) => { const r = await execute(); return { stdout: r.stdout, calls: await readFile(join(dir, "calls"), "utf8") }; });
    expect(out.stdout).toContain("attempt 1/5 failed (exit 35); retrying over ipv4 in 2 seconds");
    const curls = out.calls.trim().split("\n");
    expect(curls[0]).not.toContain("-4");
    expect(curls[1]).toBe("sleep 2");
    expect(curls.slice(2).every((line) => line.startsWith("curl -4"))).toBe(true);
    expect(curls).toHaveLength(4);
  });

  it("gives up after five tries with the command's own exit code", async () => {
    const out = await fixture(`
sleep() { printf 'sleep %s\\n' "$*" >> "$TMP/calls"; }
curl() { echo try >> "$TMP/calls"; return 7; }
fetch https://link.example/agent.mjs "$TMP/agent.mjs" && echo fetched || echo "gave up $?"
`, async ({ dir, run: execute }) => { const r = await execute(); return { stdout: r.stdout, calls: await readFile(join(dir, "calls"), "utf8") }; });
    expect(out.stdout).toContain("gave up 7");
    expect(out.calls.match(/^try$/gm)).toHaveLength(5);
    expect(out.calls.match(/^sleep .*/gm)).toEqual(["sleep 2", "sleep 5", "sleep 10", "sleep 20"]);
  });

  it("keeps telling the app a step failed until it gets through, but not past an answer like 401", async () => {
    const out = await fixture(`
sleep() { :; }
curl() { n=$(cat "$TMP/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$TMP/n"; printf '%s\\n' "$*" >> "$TMP/posts"; [ "$n" -ge 3 ] || return 35; printf '{}\\n%s' "$CODE"; }
OFFLINE=0 DEMO="" LINK_BASE=https://link.example
CODE=200 report app failed "$LOG"; echo "posts $(cat "$TMP/n")"
rm -f "$TMP/n"; CODE=401 report app failed "$LOG"; echo "posts $(cat "$TMP/n")"
rm -f "$TMP/n"; CODE=200 report app running; echo "running posts $(cat "$TMP/n")"
`, async ({ dir, run: execute }) => { const r = await execute(); return { stdout: r.stdout, posts: await readFile(join(dir, "posts"), "utf8") }; });
    expect(out.stdout).toContain("posts 3\nposts 3\nrunning posts 1");
    expect(out.posts).toContain('"status":"failed"');
  });

  it("does not unpack or replace the kit when its download fails inside a condition", async () => {
    await fixture(`
KIT_DIR=$TMP/kits
KIT_SHA=fixture
verified_download() { return 1; }
x() { printf '%s\\n' "$*" > "$TMP/unpacked"; }
if get_kit; then echo unexpected-success; else echo expected-failure; fi
`, async ({ dir, run: execute }) => {
      expect((await execute()).stdout).toContain("expected-failure");
      expect(await readFile(join(dir, "unpacked")).catch(() => null)).toBeNull();
    });
  });

  it("shares apt metadata across step subshells and invalidates it after a source change", async () => {
    const calls = await fixture(`
dpkg() { return 1; }
retry() { printf '%s\\n' "$*" >> "$TMP/calls"; }
apt_get_install() { printf 'install %s\\n' "$*" >> "$TMP/calls"; }
( apt_install first )
( apt_install second )
rm -f "$TMP/apt-updated"
( apt_install third )
`, async ({ dir, run: execute }) => {
      await execute();
      return (await readFile(join(dir, "calls"), "utf8")).trim().split("\n");
    });
    expect(calls.filter((line) => line.endsWith(" update"))).toHaveLength(2);
    expect(calls.filter((line) => line.startsWith("install "))).toHaveLength(3);
  });

  it("installs only the missing engine and performs no npm work on warm repair", async () => {
    const calls = await fixture(`
SVC_HOME=$TMP/home
mkdir -p "$SVC_HOME/.local/bin"
touch "$SVC_HOME/.local/bin/claude"
chmod +x "$SVC_HOME/.local/bin/claude"
as_user() { printf '%s\\n' "$*" >> "$TMP/calls"; }
do_engines
touch "$SVC_HOME/.local/bin/codex"
chmod +x "$SVC_HOME/.local/bin/codex"
do_engines
`, async ({ dir, run: execute }) => {
      await execute();
      return (await readFile(join(dir, "calls"), "utf8")).trim().split("\n");
    });
    const npm = calls.filter((line) => line.startsWith("npm "));
    expect(npm).toHaveLength(1);
    expect(npm[0]).toContain("@openai/codex");
    expect(npm[0]).not.toContain("@anthropic-ai/claude-code");
    expect(calls.filter((line) => line.endsWith("/.local/bin/madanibot free-backup install"))).toHaveLength(2);
  });

  it("keeps going when the free backup ai cannot be downloaded", async () => {
    const out = await fixture(`
SVC_HOME=$TMP/home
mkdir -p "$SVC_HOME/.local/bin"
for cli in claude codex; do touch "$SVC_HOME/.local/bin/$cli"; chmod +x "$SVC_HOME/.local/bin/$cli"; done
RETRY_WAITS=""
as_user() { return 1; }
do_engines && echo engines-ok
`, async ({ run: execute }) => (await execute()).stdout);
    expect(out).toContain("the free backup ai is not installed yet");
    expect(out).toContain("engines-ok");
  });

  it("cuts off a free backup install that never finishes, once, and keeps going", async () => {
    const started = Date.now();
    const { out, calls, sub } = await fixture(`
SVC_HOME=$TMP/home
mkdir -p "$SVC_HOME/.local/bin"
for cli in claude codex; do touch "$SVC_HOME/.local/bin/$cli"; chmod +x "$SVC_HOME/.local/bin/$cli"; done
printf '#!/bin/sh\necho run >> "$TMP/calls"\nexec sleep 60\n' > "$SVC_HOME/.local/bin/madanibot"
chmod +x "$SVC_HOME/.local/bin/madanibot"
export TMP
FREE_BACKUP_SECS=1
as_user() { "$@"; }
do_engines && echo engines-ok
`, async ({ dir, run: execute }) => ({
      out: (await execute()).stdout,
      calls: (await readFile(join(dir, "calls"), "utf8")).trim().split("\n"),
      sub: await readFile(join(dir, "sub"), "utf8"),
    }));
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(calls).toEqual(["run"]);
    expect(sub.trim()).toBe("Installing the free backup AI");
    expect(out).toContain("installing the free backup ai (OpenCode)");
    expect(out).toMatch(/skipped for now, the server installs it when it starts/);
    expect(out).toContain("engines-ok");
  }, 30_000);

  it("stops only installer-owned children after an explicit app cancellation", async () => {
    const unrelated = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await fixture(`
LOGS=$TMP
PH_T0=$(now_ms)
curl() {
  case "$*" in *elapsedMs*) printf '{"code":"cancelled"}\\n410' ;; *) printf '{}\\n200' ;; esac
}
do_fixture() { sh -c 'trap "" TERM; echo $$ > "$1"; sleep 30' sh "$TMP/child-pid" & wait; }
trap on_stop INT TERM
step app do_fixture
`, async ({ dir, run: execute }) => {
        const result = await execute().catch((error) => error);
        expect(result.code).toBe(130);
        expect(result.stdout).toContain("Installed files were kept");
        const pid = Number(await readFile(join(dir, "child-pid"), "utf8"));
        await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, Boolean);
        expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      });
    } finally { unrelated.kill(); }
  });

  it("does not start another step after cancellation has already arrived", async () => {
    await fixture(`
touch "$TMP/cancelled"
do_fixture() { touch "$TMP/started"; }
step app do_fixture
`, async ({ dir, run: execute }) => {
      const result = await execute().catch((error) => error);
      expect(result.code).toBe(130);
      expect(await readFile(join(dir, "started")).catch(() => null)).toBeNull();
    });
  });
});
