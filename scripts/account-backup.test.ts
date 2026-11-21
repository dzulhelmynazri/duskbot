import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../deploy/account/backup.sh", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "madani-backup-"));
  const bin = join(root, "bin"), data = join(root, "data"), dest = join(root, "dest");
  for (const dir of [bin, data, dest]) mkdirSync(dir);
  writeFileSync(join(data, "auth.json"), '{"accounts":[{"email":"owner@example.com"}]}');
  // age and rclone stand-ins: age marks its output so the test can tell it encrypted; rclone copies and logs deletes
  writeFileSync(join(bin, "age"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; -r) shift 2;; *) shift;; esac; done\n{ printf "AGE-ENCRYPTED\\n"; cat; } > "$out"\n');
  writeFileSync(join(bin, "rclone"), `#!/bin/sh\ncase "$1" in copyto) cp "$2" "$3";; delete) echo "$*" >> "${root}/deletes";; esac\n`);
  for (const tool of ["age", "rclone"]) chmodSync(join(bin, tool), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, MADANI_DASHBOARD_DATA: data, MADANI_BACKUP_RECIPIENT: "age1examplepublickey", MADANI_BACKUP_DEST: dest };
  return { root, data, dest, env };
}

// the script runs on the Linux account host: it locks under /run/lock with flock, which macOS and Windows lack
describe.skipIf(process.platform !== "linux")("account service backup", () => {
  it("writes one encrypted archive of the data folder to the destination and prunes old ones", () => {
    const f = fixture();
    execFileSync("sh", [SCRIPT], { env: f.env, encoding: "utf8" });
    const [file] = readdirSync(f.dest);
    expect(file).toMatch(/^madani-account-\d{8}T\d{6}Z\.tar\.gz\.age$/);
    const bytes = readFileSync(join(f.dest, file!));
    expect(bytes.subarray(0, 14).toString()).toBe("AGE-ENCRYPTED\n");
    expect(bytes.includes(Buffer.from("owner@example.com"))).toBe(false);
    const archive = join(f.root, "out.tgz");
    writeFileSync(archive, bytes.subarray(14));
    expect(execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })).toContain("data/auth.json");
    expect(readFileSync(join(f.root, "deletes"), "utf8")).toContain("--min-age 30d");
  });

  it("refuses to run without an age recipient or with a bad one", () => {
    const f = fixture();
    expect(spawnSync("sh", [SCRIPT], { env: { ...f.env, MADANI_BACKUP_RECIPIENT: "" } }).status).not.toBe(0);
    expect(spawnSync("sh", [SCRIPT], { env: { ...f.env, MADANI_BACKUP_RECIPIENT: "a passphrase" } }).status).toBe(2);
    expect(readdirSync(f.dest)).toEqual([]);
  });
});
