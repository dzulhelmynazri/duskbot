import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = (await readFile(new URL("../install.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");
const uninstall = await readFile(new URL("../uninstall.sh", import.meta.url), "utf8");
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** put_command with every path in a temporary folder and the server account being whoever runs the test. */
async function putCommand({ existing } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "omb-install-command-"));
  dirs.push(dir);
  const home = join(dir, "home"), cli = join(dir, "madanibot");
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await writeFile(join(home, ".local/bin/madanibot"), '#!/bin/sh\necho "server madanibot $HOME $*"\n', { mode: 0o755 });
  if (existing !== undefined) await writeFile(cli, existing, { mode: 0o755 });
  const file = join(dir, "fixture.sh");
  await writeFile(file, `${script}
SVC_USER=${userInfo().username} SVC_HOME=${home} CLI=${cli} TMP=${dir}
install() {
  _args=""
  while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) _args="$_args '$1'"; shift ;; esac; done
  eval "command install $_args"
}
put_command
`);
  const { stdout } = await run("sh", [file], { env: { PATH: "/usr/bin:/bin", TERM: "dumb" } });
  return { stdout, cli, home, wrapper: await readFile(cli, "utf8") };
}

describe("the madanibot command an install puts on the PATH", () => {
  it("runs the server account's own build as that account", async () => {
    const { stdout, cli, home, wrapper } = await putCommand();
    expect(stdout).toContain("madanibot now runs from any login on this server");
    expect(wrapper).toContain("managed by madanibot-link");
    expect(wrapper).toContain(`runuser -u ${userInfo().username} -- env HOME=${home}`);
    expect(wrapper).toContain(`sudo -u ${userInfo().username} -- env HOME=${home}`);
    const ran = await run(cli, ["pair", "--label", "desktop"], { env: { PATH: "/usr/bin:/bin", HOME: "/nowhere" } });
    expect(ran.stdout.trim()).toBe(`server madanibot ${home} pair --label desktop`);
  });

  it("leaves a madanibot that something else installed", async () => {
    const { stdout, wrapper } = await putCommand({ existing: "#!/bin/sh\necho npm\n" });
    expect(stdout).toContain("it is not ours");
    expect(wrapper).toBe("#!/bin/sh\necho npm\n");
  });

  it("writes nothing when its own wrapper is already there, and refreshes an older one of its own", async () => {
    const first = await putCommand();
    const again = await run("sh", [join(first.cli, "..", "fixture.sh")], { env: { PATH: "/usr/bin:/bin", TERM: "dumb" } });
    expect(again.stdout).toBe("");
    const older = await putCommand({ existing: "#!/bin/sh\n# managed by madanibot-link: an older wrapper\n" });
    expect(older.stdout).toContain("madanibot now runs from any login on this server");
    expect(older.wrapper).toContain("runuser -u");
  });

  it("is taken off by uninstall only when it is ours", () => {
    expect(uninstall).toContain("CLI=/usr/local/bin/madanibot");
    expect(uninstall).toMatch(/cli_ours\(\) \{ grep -qs "managed by madanibot-link" "\$CLI"; \}/);
    expect(uninstall).toMatch(/if cli_ours; then x rm -f "\$CLI"/);
  });
});
