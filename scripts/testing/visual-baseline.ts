// The visual baseline: approved screenshots of the key surfaces, light and dark, at the desktop and the smallest
// window, kept in scripts/testing/visual-baseline/. A UI change captures the same surfaces again and diffs them, so
// a stray shadow, a dark field, an overlap or a spacing slip is flagged before it ships, not after.
//
//   pnpm ui:baseline                capture the key surfaces and diff them against the approved set (exit 1 on a change)
//   pnpm ui:baseline -- --diff-only diff an existing capture (MADANI_GALLERY_DIR) without capturing again
//   pnpm ui:baseline -- --approve   capture, then store the captures as the new approved set (after a person looked)
//   pnpm ui:baseline -- --approve surface-settings-engines-desktop  approve only the named shots
//
// Each changed shot gets a diff picture beside the capture (<dir>/visual-diff/<name>.png): the new screenshot dimmed,
// changed pixels in magenta. A shot passes when under 0.2% of its pixels moved by more than a small tolerance, which
// absorbs font antialiasing but not a moved card, a new shadow or a different fill.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng } from "./png.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BASELINE = join(import.meta.dirname, "visual-baseline");

/** The surfaces that carry the look: chat with its cards, the composer, settings, the bot panel, dialogs, first run (the cloud sheets run whole). */
export const KEY_SURFACES = [
  "settings:general", "settings:appearance", "settings:engines", "settings:import", "settings:apps", "settings:usage",
  "panel:overview", "panel:routines", "panel:voice", "panel:model", "picker:model",
  "dialog:connect-apps", "dialog:cloud-add", "dialog:shortcuts", "dialog:connect-ai-from-chat",
  "onboarding:welcome", "onboarding:account", "onboarding:ai",
  "chat:empty", "chat:typing", "chat:error", "chat:notice", "card:cloud-ready",
];
/** the small surfaces a person meets daily: menus, pickers, inline states, a tooltip and toasts (not yet the avatar
 * editor, whose open card the overlap check still counts as its header's own paint) */
export const KEY_SMALL = [
  "bot-actions", "bot-context", "plus-menu", "mention-menu", "slash-menu", "message-actions", "account-menu", "sidebar-search",
  "panel-share", "panel-computer", "panel-advanced", "panel-rename", "settings-select", "settings-sending", "place-add",
  "tooltip-mic", "toast-done", "toast-error",
].map((id) => `small:${id}`);
export const KEY_CHATS = ["cards-pending", "cards-settled", "text"];
const SKINS = "grok,grok-dark";
const VIEWPORTS = "desktop,min";

/** a channel this far off counts as changed: the same Chrome draws the same pixels, and a faint new shadow or fill moves 8 or more */
const CHANNEL_TOLERANCE = 8;
/** the share of a shot's pixels that may change before it is flagged */
const MAX_CHANGED = 0.002;

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const approve = args.includes("--approve");
const diffOnly = args.includes("--diff-only");
const named = args.filter((arg) => !arg.startsWith("--"));
const dir = process.env.MADANI_GALLERY_DIR || join(REPO_ROOT, ".madani-scratch", "visual-baseline");

function capture() {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, MADANI_UI_E2E: "1", MADANI_GALLERY_DIR: dir, MADANI_GALLERY_STEADY: "1" };
  const runs = [
    { test: "scripts/testing/surface-gallery.e2e.test.ts", env: { MADANI_SURFACES_ONLY: [...KEY_SURFACES, ...KEY_SMALL].join(","), MADANI_SURFACES_SKINS: SKINS, MADANI_SURFACES_VIEWPORTS: VIEWPORTS } },
    // the move done sheet is left out until its preview gets past "Connecting to your bots"
    { test: "scripts/testing/cloud-sheets.e2e.test.ts", env: { MADANI_SURFACES_SKINS: SKINS, MADANI_CLOUD_SKIP: "move=done" } },
    { test: "scripts/testing/chat-gallery.e2e.test.ts", env: { MADANI_GALLERY_ONLY: KEY_CHATS.join(","), MADANI_GALLERY_SKINS: SKINS, MADANI_GALLERY_VIEWPORTS: VIEWPORTS, MADANI_GALLERY_MODES: "still" } },
  ];
  const failed: string[] = [];
  for (const run of runs) {
    // a gallery's hard checks (overlap, clipping, a modal whose scrim leaves part of the window uncovered, no focus look)
    // fail this run too; its pictures are still written and diffed first, so both reports come out
    const result = spawnSync("pnpm", ["exec", "vitest", "run", run.test], { cwd: REPO_ROOT, env: { ...env, ...run.env }, stdio: "inherit" });
    if (result.status !== 0) failed.push(run.test);
  }
  return failed;
}

function compare(name: string): { changed: number; total: number; sized: boolean } {
  const before = decodePng(readFileSync(join(BASELINE, name)));
  const after = decodePng(readFileSync(join(dir, name)));
  if (before.width !== after.width || before.height !== after.height) return { changed: 1, total: 1, sized: false };
  let changed = 0;
  const marks = new Uint8Array(after.width * after.height);
  for (let y = 0; y < after.height; y++) for (let x = 0; x < after.width; x++) {
    const a = before.pixel(x, y), b = after.pixel(x, y);
    if (Math.abs(a[0] - b[0]) > CHANNEL_TOLERANCE || Math.abs(a[1] - b[1]) > CHANNEL_TOLERANCE || Math.abs(a[2] - b[2]) > CHANNEL_TOLERANCE) {
      marks[y * after.width + x] = 1;
      changed++;
    }
  }
  const total = after.width * after.height;
  if (changed / total > MAX_CHANGED) {
    mkdirSync(join(dir, "visual-diff"), { recursive: true });
    writeFileSync(join(dir, "visual-diff", name), encodePng(after.width, after.height, (x, y) => {
      if (marks[y * after.width + x]) return [255, 0, 200];
      const [r, g, b] = after.pixel(x, y);
      return [(r + 510) / 3 | 0, (g + 510) / 3 | 0, (b + 510) / 3 | 0];
    }));
  }
  return { changed, total, sized: true };
}

const galleryFailures = diffOnly ? [] : capture();
function finish(code: number): never {
  if (galleryFailures.length) console.error(`\nlayout checks failed in ${galleryFailures.join(", ")} (overlaps, clipping or a modal not covering the whole window): see the run above`);
  process.exit(code || (galleryFailures.length ? 1 : 0));
}
const shots = readdirSync(dir).filter((file) => file.endsWith(".png") && (!named.length || named.some((one) => file.startsWith(one))));

if (approve) {
  mkdirSync(BASELINE, { recursive: true });
  for (const shot of shots) copyFileSync(join(dir, shot), join(BASELINE, shot));
  console.log(`approved ${shots.length} shots into ${BASELINE}`);
  finish(0);
}

const approved = existsSync(BASELINE) ? readdirSync(BASELINE).filter((file) => file.endsWith(".png") && (!named.length || named.some((one) => file.startsWith(one)))) : [];
if (!approved.length) { console.error(`no approved shots in ${BASELINE}: run with --approve once a person has looked`); finish(1); }
const problems: string[] = [];
for (const shot of approved) {
  if (!existsSync(join(dir, shot))) { problems.push(`${shot}: not captured this run`); continue; }
  const { changed, total, sized } = compare(shot);
  if (!sized) problems.push(`${shot}: size changed`);
  else if (changed / total > MAX_CHANGED) problems.push(`${shot}: ${(changed / total * 100).toFixed(2)}% of pixels changed (visual-diff/${shot})`);
}
const fresh = shots.filter((shot) => !approved.includes(shot));
if (fresh.length) console.log(`not in the baseline yet (approve them once checked): ${fresh.join(", ")}`);
if (problems.length) {
  console.error(`\n${problems.length} of ${approved.length} shots differ from the approved look:\n  ${problems.join("\n  ")}\n\nLook at the pictures in ${join(dir, "visual-diff")}. If the change is wanted, approve it: pnpm ui:baseline -- --diff-only --approve <names>`);
  finish(1);
}
console.log(`all ${approved.length} shots match the approved look`);
finish(0);
