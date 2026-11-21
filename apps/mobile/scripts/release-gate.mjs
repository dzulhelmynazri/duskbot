// The store build's gate: fails when the built phone bundle carries material copied from another product, or anything
// that only belongs in a development build. Run on the built web bundle before it goes into the native app:
//
//   node apps/mobile/scripts/release-gate.mjs [dir]          (default apps/mobile/dist)
//   node apps/mobile/scripts/release-gate.mjs --record       (rewrite flagged-assets.txt from the files still in the repo)
//
// The Xcode Release build runs it on App/public (ios/App/release-gate.sh). The flagged list holds SHA-1 hashes and labels
// only, never the files; scripts/testing/third-party-asset-hashes.txt (the source tree's own guard) is read too once it
// has merged, so one list never has to be kept in two places.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const FLAGGED = fileURLToPath(new URL("./flagged-assets.txt", import.meta.url));
const SHARED_HASHES = join(root, "scripts/testing/third-party-asset-hashes.txt");

/** Files the copy audit flagged that a bundler ships byte for byte. */
const FLAGGED_SOURCES = [
  ["src/assets/fonts/xvf.woff2", "X VF typeface (xAI)"],
  ["src/assets/fonts/xvf-mono.woff2", "X Mono VF typeface (xAI)"],
  ["src/assets/fonts/grok-icons.woff2", "Cursor Icons 16 icon font (Anysphere)"],
  ["src/assets/sounds/open-blip.wav", "Grok Bot notification sound"],
  ["src/assets/sounds/tick.wav", "Grok Bot notification sound"],
  ["src/assets/sounds/double-tick.wav", "Grok Bot notification sound"],
  ["src/assets/sounds/chime-a.wav", "Grok Bot notification sound"],
  ["src/assets/sounds/chime-b.wav", "Grok Bot notification sound"],
  ["src/assets/sounds/gallery-loop.mp3", "Grok Bot sound"],
];
/** The app logos copied from Grok Bot's plugin catalog: every png, and this one svg (the other svgs are Composio's). */
const FLAGGED_LOGO = (name) => name.endsWith(".png") || name === "1password.svg";

/** Names a bundler keeps: font families, and asset file names before their content hash. */
const NAME_MARKERS = [
  [/\bXVF\b|\bX VF\b|X Mono VF/, "the X VF font family (xAI)"],
  [/Grok Icons|Cursor Icons/i, "the Cursor Icons 16 font family (Anysphere)"],
];
const FILE_MARKERS = [
  [/^xvf(-mono)?[-.]/i, "an X VF font file"],
  [/^(grok|cursor)-icons/i, "the Cursor Icons 16 font file"],
];
/** Literals from copied code that survive minifying: the mascot engine, its captured bodies, the file-kind glyphs. */
const CODE_MARKERS = [
  ["inscribedBalls", "Grok Bot's mark engine (src/components/mascot-motion-engine.js)"],
  ["M159.2 96.0 158.8 98.5 158.3 100.9", "body outlines captured from Grok Bot (shared/grok-bodies.ts)"],
  ["M2.5 5C2.5 3.59987 2.5 2.8998 2.77248", "Grok Bot's file-kind glyphs (src/components/bot-panel/file-kind-glyphs.ts)"],
  ["tree-shaken out of", "a file generated from another product's bundle"],
  ["eager-common", "a file generated from another product's bundle"],
  ["not for redistribution", "a file marked not for redistribution"],
];
/** Things that belong to a development build only. */
const DEV_FILES = [[/^phone\.html$/, "the phone preview page"], [/\.map$/, "a source map"]];

const sha1 = (file) => createHash("sha1").update(readFileSync(file)).digest("hex");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) out.push(...walk(file)); else out.push(file);
  }
  return out;
}

function record() {
  const lines = [];
  for (const [file, label] of FLAGGED_SOURCES) if (existsSync(join(root, file))) lines.push(`${sha1(join(root, file))} ${label} (${file})`);
  const logos = join(root, "src/assets/app-logos");
  if (existsSync(logos)) for (const name of readdirSync(logos).sort()) if (FLAGGED_LOGO(name)) lines.push(`${sha1(join(logos, name))} app logo from Grok Bot's plugin catalog (src/assets/app-logos/${name})`);
  const kept = existsSync(FLAGGED) ? readFileSync(FLAGGED, "utf8").split("\n").filter((line) => /^[0-9a-f]{40} /.test(line)) : [];
  // a file already replaced in the repo keeps its line: the gate must still know the copy it replaced
  const known = new Set(lines.map((line) => line.slice(0, 40)));
  const all = [...lines, ...kept.filter((line) => !known.has(line.slice(0, 40)))].sort((a, b) => a.slice(41).localeCompare(b.slice(41)));
  writeFileSync(FLAGGED, `${all.join("\n")}\n`);
  console.log(`recorded ${all.length} flagged files`);
}

/** npm dependencies whose files the copied app had vendored; the same bytes from the package itself are licensed (MIT) */
const LICENSED_PACKAGES = [["katex", "dist/fonts"]];

/** hashes of the files those packages ship, as installed; the shared list's copies of them are not findings */
export function licensedHashes() {
  const hashes = new Set();
  const require = createRequire(join(root, "package.json"));
  for (const [name, sub] of LICENSED_PACKAGES) {
    let dir;
    try { dir = join(require.resolve(`${name}/package.json`).replace(/package\.json$/, ""), sub); } catch { continue; }
    if (existsSync(dir)) for (const file of walk(dir)) hashes.add(sha1(file));
  }
  return hashes;
}

export function flaggedHashes() {
  const flagged = new Map();
  for (const line of readFileSync(FLAGGED, "utf8").split("\n")) if (/^[0-9a-f]{40} /.test(line)) flagged.set(line.slice(0, 40), line.slice(41));
  const licensed = licensedHashes();
  if (existsSync(SHARED_HASHES)) for (const line of readFileSync(SHARED_HASHES, "utf8").split("\n")) if (/^[0-9a-f]{40}$/.test(line.trim()) && !flagged.has(line.trim()) && !licensed.has(line.trim())) flagged.set(line.trim(), "a removed third-party asset");
  return flagged;
}

/** Every reason this bundle must not be shipped, as `file: reason`. */
export function inspect(dir, flagged = flaggedHashes()) {
  const problems = [];
  const says = (file, reason) => problems.push(`${relative(dir, file)}: ${reason}`);
  for (const file of walk(dir)) {
    const name = basename(file);
    const copied = flagged.get(sha1(file));
    if (copied) says(file, `is ${copied}`);
    for (const [pattern, what] of FILE_MARKERS) if (pattern.test(name)) says(file, `is named like ${what}`);
    for (const [pattern, what] of DEV_FILES) if (pattern.test(relative(dir, file))) says(file, `is ${what}, which only a development build carries`);
    if (!/\.(js|mjs|css|html|json|svg|txt)$/.test(name)) continue;
    const text = readFileSync(file, "utf8");
    for (const [pattern, what] of NAME_MARKERS) if (pattern.test(text)) says(file, `names ${what}`);
    for (const [literal, what] of CODE_MARKERS) if (text.includes(literal)) says(file, `contains ${what}`);
  }
  // capacitor writes this beside the bundle; a live-reload address in it would ship an app that loads a developer's machine
  for (const config of [join(dir, "capacitor.config.json"), join(dir, "..", "capacitor.config.json")]) {
    if (!existsSync(config)) continue;
    try { if (JSON.parse(readFileSync(config, "utf8")).server?.url) says(config, "points the app at a live-reload server (MADANI_MOBILE_DEV_URL was set for cap sync)"); } catch { says(config, "is not readable JSON"); }
  }
  return [...new Set(problems)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "--record") record();
  else {
    const dir = process.argv[2] ?? join(root, "apps/mobile/dist");
    if (!existsSync(dir)) { console.error(`release gate: ${dir} does not exist; build the phone bundle first (pnpm mobile:build)`); process.exit(2); }
    const problems = inspect(dir);
    if (problems.length) {
      console.error(`release gate: this bundle must not go to a store (${problems.length} findings)`);
      for (const problem of problems) console.error(`  ${problem}`);
      console.error("See docs/mobile-readiness.md, \"Release gate for copied material\", for what has to merge first.");
      process.exit(1);
    }
    console.log(`release gate: ${relative(root, dir) || dir} is clean`);
  }
}
