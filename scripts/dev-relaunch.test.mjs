import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { takeRelaunchRequest } from "./dev-relaunch.mjs";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "madani-relaunch-")), "relaunch.json");

describe("dev relaunch request", () => {
  it("returns the requested args once and clears the file", () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify([".", "--flag"]));
    expect(takeRelaunchRequest(f)).toEqual([".", "--flag"]);
    expect(fs.existsSync(f)).toBe(false);
    expect(takeRelaunchRequest(f)).toBeNull();
  });
  it("ignores a missing path or garbage", () => {
    const f = file();
    expect(takeRelaunchRequest(undefined)).toBeNull();
    fs.writeFileSync(f, "{nope");
    expect(takeRelaunchRequest(f)).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ a: 1 }));
    expect(takeRelaunchRequest(f)).toBeNull();
  });
});
