import childProcess from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

const directory = process.env.MADANI_DATA_DIR;
if (!directory || directory !== process.env.HOME || process.env.MADANI_TEST_LOCAL_BROWSER_GUARD !== "1") {
  throw new Error("The local browser guard requires an explicitly isolated fixture");
}
writeFileSync(join(directory, "local-browser-guard.json"), JSON.stringify({ installed: true, platform: process.platform }));
const log = join(directory, "container-attempts.jsonl");
writeFileSync(log, "");
for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[method];
  childProcess[method] = function(command, ...args) {
    const name = basename(String(command)).toLowerCase().replace(/\.exe$/, "");
    if (name === "docker" || name === "podman") {
      appendFileSync(log, JSON.stringify({ command: name }) + "\n");
      throw new Error("The native browser fixture refuses container commands");
    }
    return Reflect.apply(original, this, [command, ...args]);
  };
}
syncBuiltinESMExports();
