import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lastGoodPath, readRegistryFile } from "./registry-file.ts";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
const quiet = { log: () => {}, now: () => 1234 };

describe("reading bots.json", () => {
  it("reads a missing file as a fresh install", () => {
    dir = mkdtempSync(join(tmpdir(), "madani-registry-"));
    expect(readRegistryFile(join(dir, "bots.json"), quiet)).toEqual({ state: "missing", records: [] });
  });

  it("keeps a last good copy, and comes back from it when the file is damaged, keeping the damaged one aside", () => {
    dir = mkdtempSync(join(tmpdir(), "madani-registry-"));
    const file = join(dir, "bots.json");
    writeFileSync(file, JSON.stringify([{ id: "moss" }, { id: "echo" }]));
    expect(readRegistryFile(file, quiet)).toMatchObject({ state: "loaded", records: [{ id: "moss" }, { id: "echo" }] });
    expect(JSON.parse(readFileSync(lastGoodPath(file), "utf8"))).toEqual([{ id: "moss" }, { id: "echo" }]);

    writeFileSync(file, '[{"id":"moss"},{"id":"ec');
    expect(readRegistryFile(file, quiet)).toEqual({ state: "recovered", records: [{ id: "moss" }, { id: "echo" }], setAside: `${file}.unreadable-1234` });
    expect(readFileSync(`${file}.unreadable-1234`, "utf8")).toBe('[{"id":"moss"},{"id":"ec');
  });

  it("never reads a damaged file with no good copy as an empty list without keeping the file", () => {
    dir = mkdtempSync(join(tmpdir(), "madani-registry-"));
    const file = join(dir, "bots.json");
    writeFileSync(file, "{}");
    expect(readRegistryFile(file, quiet)).toEqual({ state: "unreadable", records: [], setAside: `${file}.unreadable-1234` });
    expect(readdirSync(dir).sort()).toEqual(["bots.json", "bots.json.unreadable-1234"]);
  });
});
