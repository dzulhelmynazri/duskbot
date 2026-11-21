import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { locales } from "./index";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** The two lines that send the person to System Settings, which lists the app by its bundle name, "Madani Bot". */
const SETTINGS_NAME = new Set(["composer.dictation.micFailed", "computer.problem.localMac"]);

/** Words people read outside the locale packs: the OS prompt, the site's titles and the Linux installer's lines. */
const SHOWN = [
  "src/lib/user-presence.ts", "apps/site/public/app/index.html", "apps/site/public/dev/index.html",
  "apps/site/public/landing/pages.js", "apps/site/public/landing/waitlist.js", "build/linux-after-install.sh", "build/linux-after-remove.sh",
];
// a path or the bundle itself (Madani Bot.app, Logs/Madani Bot), and comments, keep the bundle's name
const NOT_SHOWN = /^\s*(?:#|\/\/|\/?\*)|Madani Bot\.app|\/Madani Bot\b/;

describe("the name is madani bot, lowercase", () => {
  it("in every locale, except where it names the app as System Settings lists it", () => {
    const offending = Object.entries(locales).flatMap(([code, pack]) => Object.entries(pack)
      .filter(([key, value]) => /madani bot/i.test(value ?? "") && /Madani Bot|Madani bot|madani Bot/.test(value!) && !SETTINGS_NAME.has(key))
      .map(([key]) => `${code}:${key}`));
    expect(offending).toEqual([]);
  });

  it("in the OS prompt, the site's titles and the installer's lines", () => {
    const offending = SHOWN.flatMap((file) => readFileSync(join(ROOT, file), "utf8").split("\n")
      .map((line, index) => [line, index + 1] as const)
      .filter(([line]) => /Madani Bot/.test(line) && !NOT_SHOWN.test(line))
      .map(([, at]) => `${file}:${at}`));
    expect(offending).toEqual([]);
  });
});
