import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = (await readFile(new URL("../install.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");
const desktopConstants = await readFile(new URL("../../../shared/bot-desktop.ts", import.meta.url), "utf8");
const currentImage = /^export const BOT_DESKTOP_IMAGE = "([^"]+)";/m.exec(desktopConstants)[1];

async function provision(scenario, image = "fixture:1", cachedImage = image) {
  const dir = await mkdtemp(join(tmpdir(), "omb-install-"));
  try {
    const file = join(dir, "fixture.sh");
    await writeFile(file, `${script}
calls=$1
scenario=$2
BOT_DESKTOP_IMAGE=$3
cached_image=$4
built=0
docker() {
  printf 'docker %s\\n' "$*" >> "$calls"
  case "$*" in
    info|--version) return 0 ;;
    'image inspect '*) { [ "$scenario" = cached ] && [ "$3" = "$cached_image" ]; } || [ "$built" = 1 ] ;;
    'buildx version') return 1 ;;
    *) return 90 ;;
  esac
}
systemctl() { printf 'systemctl %s\\n' "$*" >> "$calls"; }
apt_install() { printf 'apt_install %s\\n' "$*" >> "$calls"; }
state_set() { printf 'state %s\\n' "$*" >> "$calls"; }
pull_with_progress() { printf 'pull %s\\n' "$*" >> "$calls"; [ "$scenario" = pulled ]; }
get_kit() { printf 'kit\\n' >> "$calls"; KIT=/fixture; [ "$scenario" != no-kit ]; }
build_with_progress() { printf 'build %s\\n' "$*" >> "$calls"; built=1; }
[ "$cached_image" = "$BOT_DESKTOP_IMAGE" ] || docker image inspect "$cached_image" || exit 1
do_docker
code=0
do_desktop || code=$?
printf 'result %s\\n' "$code" >> "$calls"
`);
    const calls = join(dir, "calls");
    await run("sh", [file, calls, scenario, image, cachedImage], { env: { PATH: "/usr/bin:/bin", TERM: "dumb" } });
    return (await readFile(calls, "utf8")).trim().split("\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("desktop installer work", () => {
  it("requests the new desktop image when only the retired v1 image is cached", async () => {
    expect(currentImage).toMatch(/^ghcr\.io\/madanibotai\/madani-desktop:v\d+$/);
    const oldImage = "ghcr.io/sidddevz/omb-bot-desktop:v1";
    const calls = await provision("cached", currentImage, oldImage);
    expect(calls).toContain(`docker image inspect ${oldImage}`);
    expect(calls).toContain(`docker image inspect ${currentImage}`);
    expect(calls).toContain(`pull ${currentImage}`);
    expect(calls).toContain(`build ${currentImage} /fixture/deploy/bot-desktop`);
    expect(calls).toContain("state desktop built");
    expect(calls).not.toContain("state desktop present");
    expect(calls.some((line) => /docker (rm|rmi|stop|update)|volume rm/.test(line))).toBe(false);
    expect(calls).toContain("result 0");
  });

  it("reuses a cached image without installing build tools or pulling", async () => {
    const calls = await provision("cached");
    expect(calls.filter((line) => /^(apt_install|pull|build|kit)/.test(line))).toEqual([]);
    expect(calls).toContain("state desktop present");
    expect(calls).toContain("result 0");
  });

  it("pulls a published image without installing build tools or building", async () => {
    const calls = await provision("pulled");
    expect(calls.filter((line) => /^(apt_install|build|kit)/.test(line))).toEqual([]);
    expect(calls.filter((line) => line.startsWith("pull "))).toEqual(["pull fixture:1"]);
    expect(calls).toContain("state desktop pulled");
    expect(calls).toContain("result 0");
  });

  it("installs build tools once only when a local build is required", async () => {
    const calls = await provision("build");
    expect(calls.filter((line) => line.startsWith("apt_install "))).toEqual(["apt_install docker-buildx"]);
    expect(calls.filter((line) => line.startsWith("build "))).toEqual(["build fixture:1 /fixture/deploy/bot-desktop"]);
    expect(calls).toContain("state desktop built");
    expect(calls).toContain("result 0");
  });

  it("does not install build tools when the desktop kit is unavailable", async () => {
    const calls = await provision("no-kit");
    expect(calls.filter((line) => /^(apt_install|build)/.test(line))).toEqual([]);
    expect(calls).toContain("result 11");
  });
});

describe("host memory guards", () => {
  it("puts the server and link above bot computers and sshd out of the oom killer's reach", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omb-install-units-"));
    try {
      const file = join(dir, "fixture.sh");
      await writeFile(file, `${script}
UNITS=$1/units
TMP=$1
STATE=$1/state
mkdir -p "$UNITS"
NAME=fixture
AGENT=/opt/agent.mjs
systemctl() {
  case "$1" in
    cat) [ "$2" = ssh.service ] ;;
    show) echo 0 ;;
  esac
}
server_unit
helper_units
if ssh_guard; then echo "first 0" > "$1/result"; else echo "first 1" > "$1/result"; fi
if ssh_guard; then echo "again 0" >> "$1/result"; else echo "again 1" >> "$1/result"; fi
`);
      await run("sh", [file, dir], { env: { PATH: "/usr/bin:/bin", TERM: "dumb" } });
      expect(await readFile(join(dir, "units/madanibot.service"), "utf8")).toContain("\nOOMScoreAdjust=-800\n");
      expect(await readFile(join(dir, "units/madanibot-link.service"), "utf8")).toContain("\nOOMScoreAdjust=-700\n");
      const guard = await readFile(join(dir, "units/ssh.service.d/10-madanibot-oom.conf"), "utf8");
      expect(guard).toContain("[Service]\nOOMScoreAdjust=-1000\nMemoryMin=64M");
      expect(await readFile(join(dir, "result"), "utf8")).toBe("first 0\nagain 1\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("installer transport", () => {
  const installer = new URL("../install.sh", import.meta.url).pathname;
  it.each(["http://link.example.com", "ftp://link.example.com", "link.example.com"])("refuses a LINK_BASE of %s before doing anything", async (base) => {
    const failed = await run("sh", [installer, "abcdefghij-abcdefghijklmnopqrstuvwxyz"], { env: { PATH: "/usr/bin:/bin", TERM: "dumb", LINK_BASE: base } }).then(() => null, error => error);
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain("LINK_BASE must be an https:// address.");
  });
  it("pins every request to the link service to https, redirects included", async () => {
    const text = await readFile(installer, "utf8");
    const calls = text.split("\n").filter(line => /\bn?curl\b/.test(line) && /LINK_BASE|retry curl|\$_url|VPS_TOKEN/.test(line) && !/^\s*(#|show |echo |.*demo_lines)/.test(line));
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const line of calls) expect(line, line).toContain('--proto "$PROTO" --proto-redir "$PROTO"');
  });
});

describe("basics", () => {
  // ffmpeg (the bot browser's H.264 live view) is best effort: a server where it cannot be installed still installs
  it.each([["installs", 0], ["fails", 1]])("asks for ffmpeg and carries on when apt %s", async (_name, fail) => {
    const dir = await mkdtemp(join(tmpdir(), "omb-install-"));
    try {
      const file = join(dir, "fixture.sh");
      await writeFile(file, `${script}
set -eu
calls=$1
fail=$2
apt_install() { printf 'apt_install %s\\n' "$*" >> "$calls"; [ "$1" != ffmpeg ] || [ "$fail" = 0 ]; }
bwrap_userns() { printf 'bwrap\\n' >> "$calls"; }
do_basics
printf 'done\\n' >> "$calls"
`);
      const calls = join(dir, "calls");
      await run("sh", [file, calls, String(fail)], { env: { PATH: "/usr/bin:/bin", TERM: "dumb" } });
      const lines = (await readFile(calls, "utf8")).trim().split("\n");
      expect(lines).toContain("apt_install ffmpeg");
      expect(lines.slice(-2)).toEqual(["bwrap", "done"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("webrtc beside the agent", () => {
  it("installs the node-datachannel the app and server pin, best effort", async () => {
    const pinned = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")).dependencies["node-datachannel"];
    expect(/^AGENT_RTC_VERSION=(\S+)$/m.exec(script)?.[1]).toBe(pinned);
    expect(script).toMatch(/agent_rtc \|\| echo "webrtc for the link could not be installed/);
  });
});
