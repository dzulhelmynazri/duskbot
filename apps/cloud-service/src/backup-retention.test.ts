import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { volumeLayer } from "./bundle.ts";
import { BACKUP_CACHES, homeControlScript } from "./home.ts";
import { BACKUP_LONG_HOLD_MS, DAY_MS, prunableBackups, type Generation } from "./retention.ts";

const HOUR = 3_600_000;
const gen = (hours: number, verified = true): Generation => ({ file: `${String(hours * HOUR).padStart(13, "0")}-00000000.ombb`, snapshotAt: hours * HOUR, verifiedAt: verified ? hours * HOUR + 1 : null });
const kept = (all: Generation[], keep: number, protect: string[] = []) => { const drop = new Set(prunableBackups(all, { keep, protect })); return all.filter(g => !drop.has(g)).map(g => g.snapshotAt / HOUR); };

describe("prunableBackups", () => {
  it("keeps the newest of each of the latest days, and the oldest while it is under two weeks older", () => {
    expect(kept([gen(0), gen(4), gen(30), gen(34)], 2)).toEqual([0, 4, 34]);
  });

  it("drops copies taken hours apart within a day", () => {
    expect(kept([gen(0), gen(4), gen(30), gen(34), gen(54)], 2)).toEqual([0, 34, 54]);
    expect(kept([gen(0), gen(4), gen(8), gen(12)], 2)).toEqual([0, 12]);
    expect(kept([gen(10), gen(14)], 2)).toEqual([10, 14]);
  });

  it("lets the oldest go once it is two weeks older than the newest", () => {
    const newest = BACKUP_LONG_HOLD_MS / HOUR;
    expect(kept([gen(0), gen(newest - 30), gen(newest)], 2)).toEqual([newest - 30, newest]);
  });

  it("keeps only the newest and the long-held oldest of an archived home, and never what a restore uses", () => {
    expect(kept([gen(0), gen(30), gen(60)], 1)).toEqual([0, 60]);
    expect(kept([gen(0), gen(30), gen(60), gen(64)], 2)).toEqual([0, 30, 64]);
    expect(kept([gen(0), gen(30), gen(60), gen(64)], 2, [gen(60).file])).toEqual([0, 30, 60, 64]);
  });

  it("drops a generation that failed its check once a newer one passed, and keeps everything when none passed", () => {
    expect(kept([gen(0, false), gen(30), gen(31, false)], 2)).toEqual([30, 31]);
    expect(kept([gen(0, false), gen(30, false)], 2)).toEqual([0, 30]);
  });

  it("stays at three files, one from an earlier day and none past two weeks, over months of backups several times a day", () => {
    let all: Generation[] = [];
    for (let h = 0; h < 90 * 24; h += 5) {
      all.push(gen(h));
      const drop = new Set(prunableBackups(all, { keep: 2 }));
      all = all.filter(g => !drop.has(g));
      expect(all.length).toBeLessThanOrEqual(3);
      const ages = all.map(g => (h * HOUR - g.snapshotAt) / DAY_MS);
      expect(Math.max(...ages)).toBeLessThan(14 + 1);
      if (h >= 24) expect(all.some(g => Math.floor(g.snapshotAt / DAY_MS) < Math.floor(h / 24))).toBe(true);
    }
  });
});

describe("what a backup leaves out", () => {
  it("names a tar entry's layer for the size report without a person's own names", () => {
    const d = CLOUD_HOME.dataName;
    expect(volumeLayer(`data/${d}/tools/npm/lib/node_modules/x`)).toBe("disposable_tools");
    expect(volumeLayer(`data/${d}/agent-browser-profiles/abc/Default/Cookies`)).toBe("browser_agent_browser_profiles");
    expect(volumeLayer("data/.npm/_cacache/x")).toBe("dot_npm");
    expect(volumeLayer("data/.cache/ms-playwright/chromium-1/x")).toBe("cache_ms_playwright");
    expect(volumeLayer(`data/${d}/workspaces/w/notes.md`)).toBe("files");
    expect(volumeLayer("data/My Secret Project/x")).toBe("other");
  });

  it("skips package manager caches, the server's scratch and Chromium's caches, never a profile's cookies (GNU tar)", () => {
    if (!/GNU tar/.test(execFileSync("tar", ["--version"], { encoding: "utf8" }))) {
      // the homes run GNU tar; bsdtar matches --exclude differently, so this only asserts the list reaches the script
      const script = homeControlScript();
      for (const e of BACKUP_CACHES) expect(script).toContain(`--exclude='data/${e}'`);
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "madani-snap-"));
    try {
      const p = `data/${CLOUD_HOME.dataName}/agent-browser-profiles/abc`;
      const files = ["data/.npm/_cacache/a", "data/.cache/pip/a", `${p}/Default/Cache/Cache_Data/a`, `${p}/Default/Code Cache/js/a`, `${p}/GrShaderCache/a`,
        `data/${CLOUD_HOME.dataName}/tmp/a`, `${p}/Default/Cookies`, "data/.cache/ms-playwright/a", `data/${CLOUD_HOME.dataName}/bots.json`, `data/${CLOUD_HOME.dataName}/tools/npm/a`];
      for (const f of files) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), "x"); }
      const line = homeControlScript().split("\n").find(l => l.includes("tar -C / --numeric-owner -cf"))!.trim()
        .replace("tar -C / ", `tar -C '${root}' `).replace('"$part"', `'${join(root, "out.tar")}'`).replace(" || code=$?", "");
      execFileSync("bash", ["-c", line]);
      const listed = execFileSync("tar", ["-tf", join(root, "out.tar")], { encoding: "utf8" }).split("\n").filter(l => l && !l.endsWith("/"));
      expect(listed.sort()).toEqual([`${p}/Default/Cookies`, "data/.cache/ms-playwright/a", `data/${CLOUD_HOME.dataName}/bots.json`, `data/${CLOUD_HOME.dataName}/tools/npm/a`].sort());
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
