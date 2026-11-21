// The owner's own app and config must come out of a smoke run exactly as they went in. `snapshot()` before the app
// starts, `compare()` after it is gone: config files must be byte-identical, and nothing the smoke names (its server,
// its tunnel port, its profile) may show up in the owner's app state or in what the owner's logs gained meanwhile.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const APP = join(home, "Library", "Application Support", "madanibot");
const LOGS = join(home, "Library", "Logs", "madanibot");
// what only the owner changes: any byte different is a failure
const STRICT = [
  ...listFiles(join(home, ".config", "madanibot")),
  ...["environments.json", "environments-staging.json", "places-chosen.json", "own-home.json", "own-home-choice.json", "own-home-send.json", "companion-settings.json", "desktop-prefs.json", "server-enroll.json", "account-places.json"].map((name) => join(APP, name)),
  join(home, ".madanibot", "config.json"),
];

function listFiles(dir) {
  try { return readdirSync(dir).map((name) => join(dir, name)).filter((file) => statSync(file).isFile()); } catch { return []; }
}
const hash = (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "absent");
const size = (file) => { try { return statSync(file).size; } catch { return 0; } };

export function snapshot() {
  return {
    strict: Object.fromEntries(STRICT.map((file) => [file, hash(file)])),
    logs: Object.fromEntries(listFiles(LOGS).map((file) => [file, size(file)])),
  };
}

/** markers: strings only the smoke writes. Returns the problems found (empty when the owner's setup is untouched). */
export function compare(before, markers) {
  const problems = [];
  for (const [file, was] of Object.entries(before.strict)) {
    if (hash(file) !== was) problems.push(`${file.replace(home, "~")} changed during the run`);
  }
  const owned = [...listFiles(APP).filter((file) => file.endsWith(".json")), ...STRICT.filter((file) => existsSync(file))];
  for (const file of new Set(owned)) {
    const text = readFileSync(file, "utf8");
    const found = markers.find((marker) => text.includes(marker));
    if (found) problems.push(`${file.replace(home, "~")} holds "${found}"`);
  }
  for (const file of listFiles(LOGS)) {
    const start = before.logs[file] ?? 0;
    const end = size(file);
    if (end <= start) continue;
    const added = readFileSync(file).subarray(start, end).toString("utf8");
    const found = markers.find((marker) => added.includes(marker));
    if (found) problems.push(`${file.replace(home, "~")} gained a line with "${found}"`);
  }
  return problems;
}
