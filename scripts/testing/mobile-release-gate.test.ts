import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error a plain script, run by node and by the Xcode build
import { flaggedHashes, inspect } from "../../apps/mobile/scripts/release-gate.mjs";

const dirs: string[] = [];
function bundle(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "madani-gate-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("store release gate", () => {
  it("passes a bundle of our own files", () => {
    expect(inspect(bundle({ "index.html": "<div id=root></div>", "assets/index-abc.js": "console.log('hello')", "assets/geist-latin.woff2": Buffer.from([1, 2, 3]) }))).toEqual([]);
  });

  it("knows every file the copy audit flagged, by content", () => {
    const flagged: Map<string, string> = flaggedHashes();
    expect(flagged.size).toBeGreaterThanOrEqual(61);
    const labels = [...flagged.values()].join("\n");
    for (const name of ["xvf.woff2", "xvf-mono.woff2", "grok-icons.woff2", "open-blip.wav", "tick.wav", "double-tick.wav", "chime-a.wav", "chime-b.wav", "gallery-loop.mp3", "1password.svg", "slack.png"]) expect(labels).toContain(name);
  });

  it("passes KaTeX's own fonts from the katex package, which the shared removed-asset list also holds", () => {
    const fonts = join(fileURLToPath(new URL("../../node_modules/katex/dist/fonts/", import.meta.url)));
    const font = readFileSync(join(fonts, "KaTeX_Main-Regular.woff2"));
    expect(inspect(bundle({ "assets/KaTeX_Main-Regular-B22Nviop.woff2": font }))).toEqual([]);
  });

  it("refuses a flagged file whatever it is renamed to", () => {
    const body = Buffer.from("stands in for a flagged font");
    const flagged = new Map([[createHash("sha1").update(body).digest("hex"), "X VF typeface (xAI)"]]);
    expect(inspect(bundle({ "assets/body-9f8e7d.woff2": body }), flagged)).toEqual(["assets/body-9f8e7d.woff2: is X VF typeface (xAI)"]);
  });

  it("refuses the flagged font families and file names", () => {
    const problems: string[] = inspect(bundle({
      "assets/index.css": "@font-face{font-family:Grok Icons;src:url(a.woff2)} body{font-family:XVF,sans-serif}",
      "assets/xvf-C7NyO54W.woff2": Buffer.from([9]),
      "assets/grok-icons-QUmxS7q3.woff2": Buffer.from([8]),
    }));
    expect(problems.join("\n")).toMatch(/index\.css: names the X VF font family/);
    expect(problems.join("\n")).toMatch(/index\.css: names the Cursor Icons 16 font family/);
    expect(problems.join("\n")).toMatch(/xvf-C7NyO54W\.woff2: is named like an X VF font file/);
    expect(problems.join("\n")).toMatch(/grok-icons-QUmxS7q3\.woff2: is named like the Cursor Icons 16 font file/);
  });

  it("refuses the copied engine, bodies and glyphs once they are minified into a chunk", () => {
    const problems: string[] = inspect(bundle({ "assets/index-1.js": "var a={inscribedBalls:1},b=\"M159.2 96.0 158.8 98.5 158.3 100.9 157.6\";", "assets/SettingsPage-2.js": "const c=\"M2.5 5C2.5 3.59987 2.5 2.8998 2.77248 2.36502\"" }));
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("mascot-motion-engine.js");
    expect(problems.join("\n")).toContain("grok-bodies.ts");
    expect(problems.join("\n")).toContain("file-kind-glyphs.ts");
  });

  it("refuses development leftovers: the preview page, source maps, a live-reload address", () => {
    const problems: string[] = inspect(bundle({ "public/phone.html": "x", "public/assets/index.js.map": "{}", "capacitor.config.json": JSON.stringify({ server: { url: "http://localhost:5320" } }) }) + "/public");
    expect(problems.join("\n")).toContain("phone.html: is the phone preview page");
    expect(problems.join("\n")).toContain("index.js.map: is a source map");
    expect(problems.join("\n")).toContain("live-reload server");
  });

  it("the Release build runs it, and nothing in the project lets a build skip it", () => {
    const project = readFileSync(fileURLToPath(new URL("../../apps/mobile/ios/App/App.xcodeproj/project.pbxproj", import.meta.url)), "utf8");
    expect(project).toContain("/* Release gate */,");
    expect(project).toContain('shellScript = "\\"$SRCROOT/release-gate.sh\\"\\n";');
    const script = fileURLToPath(new URL("../../apps/mobile/ios/App/release-gate.sh", import.meta.url));
    expect(existsSync(script)).toBe(true);
    const text = readFileSync(script, "utf8");
    expect(text).toContain('if [ "$CONFIGURATION" != "Release" ]');
    expect(text).toContain("release-gate.mjs");
    expect(text).not.toMatch(/SKIP|BYPASS/i);
  });
});
