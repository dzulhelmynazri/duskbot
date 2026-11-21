// Side-by-side stand-ins for the desktop's surfaces, each played at desktop motion picks a, b and c of
// src/lib/desktop-motion.ts on top of the shipped global speed. The surfaces are drawn here; the timings come from the
// app's own tokens and functions.
import { cssCurve, DESKTOP_MOTIONS, type DesktopMotion, type Enter } from "../../src/lib/desktop-motion";
import { cssBezier, MOTION, pacedMs, pacedOut, pacedSpring, springTiming } from "../../src/lib/motion-speed";

export type Theme = "light" | "dark";
export type DesktopScene = "palette" | "settings" | "panel" | "menus" | "dialogs" | "sidebar" | "toasts" | "press";
export const DESKTOP_SCENES: DesktopScene[] = ["palette", "settings", "panel", "menus", "dialogs", "sidebar", "toasts", "press"];

const W = 1100, H = 700;
const LEAD = 300;
const SPRING_SOFT = "linear(0, 0.052, 0.172, 0.318, 0.462, 0.592, 0.701, 0.788, 0.855, 0.905, 0.94, 0.964, 0.979, 0.988, 0.994, 0.997, 0.999, 1)";
const RELEASE = "cubic-bezier(0.28, 1.4, 0.36, 1)";
const MADANI_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const QUINT = "cubic-bezier(0.16, 1, 0.3, 1)";

export const PICK_LABELS: Record<string, string> = { a: "A  now", b: "B  fast and soft", c: "C  expressive" };

type Colors = { app: string; panel: string; menu: string; ink: string; soft: string; tone: string; hover: string; scrim: string; accent: string; shadow: string; edge: string };
const COLORS: Record<Theme, Colors> = {
  light: { app: "#fdfdfc", panel: "#f6f6f5", menu: "#ffffff", ink: "#1c1c1c", soft: "#6b6b6b", tone: "#f0f0ef", hover: "rgb(28 28 28 / 0.08)", scrim: "rgb(0 0 0 / 0.5)", accent: "#1084fe", shadow: "0 20px 32px -5px rgb(28 28 28 / 0.12), 0 8px 12px -6px rgb(28 28 28 / 0.1)", edge: "rgb(28 28 28 / 0.08)" },
  dark: { app: "#121212", panel: "#0e0e0e", menu: "#1f1f1f", ink: "#f5f5f5", soft: "#f5f5f5a8", tone: "#262626", hover: "rgb(245 245 245 / 0.08)", scrim: "rgb(0 0 0 / 0.7)", accent: "#7fc0ff", shadow: "0 20px 32px -5px rgb(0 0 0 / 0.45), 0 8px 12px -6px rgb(0 0 0 / 0.35)", edge: "rgb(245 245 245 / 0.08)" },
};

let C: Colors = COLORS.light;

function h(tag: string, css: string, text = "", parent?: Element): HTMLElement {
  const el = document.createElement(tag);
  el.style.cssText = css;
  if (text) el.textContent = text;
  parent?.appendChild(el);
  return el;
}

/** Plays keyframes from `at` for `ms`; returns when it ends. */
function play(el: Element, frames: Keyframe[], at: number, ms: number, easing: string, fill: FillMode = "both"): number {
  el.animate(frames, { duration: Math.max(1, ms), delay: at, easing: resolve(easing), fill });
  return at + ms;
}

/** Changes at once at `at`; the element's own style holds before it. */
function cut(el: Element, from: Keyframe, to: Keyframe, at: number): number {
  return play(el, [from, to], at, 1, "steps(1, start)", "forwards");
}

function resolve(easing: string): string {
  return easing.replace("var(--madani-spring-soft)", SPRING_SOFT).replace("var(--madani-ease-release)", RELEASE);
}

const OUT = () => cssCurve(null);

function enterFrames(e: Enter, origin = ""): Keyframe[] {
  return [
    { opacity: 0, transform: `translateY(${e.y}px) scale(${e.scale})`, filter: `blur(${e.blur}px)`, transformOrigin: origin || undefined },
    { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0px)", transformOrigin: origin || undefined },
  ];
}

/** An entrance: the fade on the out curve, the transform on the pick's curve (a spring plays as its shape). */
function enter(el: Element, e: Enter, at: number): number {
  const ms = pacedMs(e.ms);
  const [from, to] = enterFrames(e);
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, delay: at, easing: OUT(), fill: "both" });
  return play(el, [{ transform: from.transform, filter: from.filter }, { transform: to.transform, filter: to.filter }], at, ms, cssCurve(e.curve));
}

function leave(el: Element, ms: number, scale: number, y: number, at: number): number {
  return play(el, [{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 0, transform: `translateY(${y}px) scale(${scale})` }], at, pacedMs(ms), OUT(), "forwards");
}

const BOTS = ["Research", "Inbox", "Writer", "Travel", "Recipes", "Notes", "Ledger"];
const LINES = ["Three papers fit, the 2025 one best.", "Two need a reply today.", "Draft two is in your notes.", "It moved to 9:40, gate B12.", "Swap the cream for yoghurt.", "Groceries, Thursday.", "October closes at 4,120."];

type Shell = { sidebar: HTMLElement; rows: HTMLElement[]; main: HTMLElement; transcript: HTMLElement; composer: HTMLElement; plus: HTMLElement; panelSlot: HTMLElement };

function avatar(parent: Element, i: number, size = 28): HTMLElement {
  const hues = [210, 28, 150, 265, 350, 190, 95];
  return h("div", `width:${size}px;height:${size}px;border-radius:50%;flex:none;background:oklch(0.72 0.09 ${hues[i % hues.length]});`, "", parent);
}

function transcriptOf(parent: Element, chat: number): HTMLElement {
  const col = h("div", "position:absolute;left:0;right:0;bottom:96px;display:flex;flex-direction:column;gap:16px;padding:0 48px;", "", parent);
  const pairs = chat === 0
    ? [["can you check if the flight on friday moved?", "It moved to 9:40, gate B12. Your seat stayed the same, and the hotel shuttle still lines up."], ["and the return?", "Unchanged: Sunday 18:15 from gate C4."]]
    : [["what's left on the grocery list?", "Oat milk, lemons, the good bread and coffee filters. I took eggs off, you bought them Tuesday."], ["add basil", "Added. Thursday's delivery has room for it."]];
  for (const [mine, theirs] of pairs) {
    const r = h("div", "display:flex;justify-content:flex-end;", "", col);
    h("div", `max-width:62%;padding:9px 14px;border-radius:20px;background:${C.tone};color:${C.ink};font-size:14px;line-height:1.45;`, mine, r);
    h("div", `max-width:80%;color:${C.ink};font-size:14px;line-height:1.6;`, theirs, col);
  }
  return col;
}

function shell(stage: HTMLElement, open = 3): Shell {
  stage.style.display = "flex";
  const sidebar = h("div", `position:relative;width:260px;flex:none;background:${C.panel};overflow:hidden;padding:14px 0 0;`, "", stage);
  const search = h("div", `margin:0 12px 14px;height:32px;border-radius:9px;background:${C.tone};display:flex;align-items:center;padding:0 10px;color:${C.soft};font-size:13px;white-space:nowrap;`, "Search  ⌘K", sidebar);
  search.dataset.search = "";
  const rows: HTMLElement[] = [];
  BOTS.forEach((name, i) => {
    const row = h("div", `position:relative;display:flex;align-items:center;gap:10px;margin:0 8px;padding:7px 10px;border-radius:10px;white-space:nowrap;${i === open ? `background:${C.hover};` : ""}`, "", sidebar);
    avatar(row, i);
    const text = h("div", "min-width:0;", "", row);
    h("div", `font-size:13px;font-weight:500;color:${C.ink};`, name.toLowerCase(), text);
    h("div", `font-size:12px;color:${C.soft};overflow:hidden;text-overflow:ellipsis;max-width:170px;`, LINES[i], text);
    rows.push(row);
  });
  const main = h("div", `position:relative;flex:1;min-width:0;background:${C.app};overflow:hidden;`, "", stage);
  h("div", `height:48px;display:flex;align-items:center;padding:0 20px;font-weight:600;font-size:14px;color:${C.ink};`, BOTS[open].toLowerCase(), main);
  const transcript = transcriptOf(main, 0);
  const composer = h("div", `position:absolute;left:48px;right:48px;bottom:24px;height:52px;border-radius:26px;background:${C.tone};display:flex;align-items:center;gap:10px;padding:0 10px;color:${C.soft};font-size:14px;`, "", main);
  const plus = h("div", `width:32px;height:32px;border-radius:50%;background:${C.hover};display:flex;align-items:center;justify-content:center;color:${C.ink};font-size:18px;`, "+", composer);
  h("span", "", `ask ${BOTS[open].toLowerCase()} anything`, composer);
  const panelSlot = h("div", `position:relative;width:0;flex:none;overflow:hidden;background:${C.app};box-shadow:inset 0.5px 0 0 ${C.edge};`, "", stage);
  return { sidebar, rows, main, transcript, composer, plus, panelSlot };
}

function scrim(stage: HTMLElement): HTMLElement {
  return h("div", `position:absolute;inset:0;background:${C.scrim};opacity:0;z-index:5;`, "", stage);
}

/** The ⌘K palette: open, three keys down, a narrowing query, then Escape. */
function palette(stage: HTMLElement, m: DesktopMotion): number {
  shell(stage);
  const dim = scrim(stage);
  const box = h("div", `position:absolute;left:50%;top:50%;width:560px;height:455px;margin:-227px 0 0 -280px;border-radius:18px;background:${C.menu};box-shadow:${C.shadow};overflow:hidden;opacity:0;z-index:6;`, "", stage);
  const field = h("div", `display:flex;align-items:center;gap:10px;padding:14px 16px;font-size:14px;color:${C.soft};box-shadow:inset 0 -0.5px 0 ${C.edge};`, "", box);
  h("span", "font-size:15px;", "⌕", field);
  const typed = h("span", `color:${C.ink};`, "", field);
  const caret = h("span", `color:${C.soft};`, "Search", field);
  const list = h("div", "position:relative;padding:8px;display:flex;flex-direction:column;gap:2px;", "", box);
  const glide = m.palette.glideMs > 0;
  const hi = h("div", `position:absolute;left:8px;right:8px;top:8px;height:49px;border-radius:10px;background:${C.hover};`, "", list);
  const rowsA = [["madani bot", "Your own bot, on this Mac"], ["New bot", "Make another bot"], ["New group chat", "Bots and people together"], ["Keyboard shortcuts", ""], ["Settings: General", ""], ["Settings: Texting", ""], ["Settings: Computer", ""], ["Settings: Permissions", ""]];
  const rowsB = [["Settings: General", ""], ["Settings: Texting", ""], ["Settings: Computer", ""], ["Settings: Permissions", ""]];
  const draw = (items: string[][]) => items.map(([name, detail], i) => {
    const row = h("div", `position:relative;height:49px;display:flex;align-items:center;gap:10px;padding:0 10px;border-radius:10px;font-size:13px;color:${C.ink};`, "", list);
    h("span", `width:24px;height:24px;border-radius:8px;flex:none;background:${i === 0 && name === "madani bot" ? C.accent : C.hover};`, "", row);
    const t = h("div", "", "", row);
    h("div", "", name, t);
    if (detail) h("div", `color:${C.soft};`, detail, t);
    return row;
  });
  const first = draw(rowsA);
  const second = draw(rowsB);
  for (const row of second) row.style.cssText += "position:absolute;left:8px;right:8px;";
  second.forEach((row, i) => { row.style.top = `${8 + i * 51}px`; row.style.opacity = "0"; });
  const opened = LEAD;
  if (m.palette.enter) {
    play(dim, [{ opacity: 0 }, { opacity: 1 }], opened, pacedMs(m.palette.enter.ms), OUT());
    enter(box, m.palette.enter, opened);
  } else {
    cut(dim, { opacity: 0 }, { opacity: 1 }, opened);
    cut(box, { opacity: 0 }, { opacity: 1 }, opened);
  }
  if (m.palette.staggerMs) first.slice(0, 5).forEach((row, i) => play(row, [{ opacity: 0 }, { opacity: 1 }], opened + pacedMs(m.palette.staggerMs) * [0, 1, 1.8, 2.4, 2.8][i], pacedMs(m.palette.rowsMs), OUT()));
  let at = opened + 700;
  for (let step = 1; step <= 3; step++, at += 260) {
    const frames = [{ transform: `translateY(${(step - 1) * 51}px)` }, { transform: `translateY(${step * 51}px)` }];
    if (glide) play(hi, frames, at, pacedMs(m.palette.glideMs), OUT(), "forwards");
    else cut(hi, frames[0], frames[1], at);
  }
  at += 500;
  cut(caret, { opacity: 1 }, { opacity: 0 }, at);
  for (let i = 1; i <= 5; i++) {
    const letter = h("span", "opacity:0;", "setti"[i - 1], typed);
    cut(letter, { opacity: 0 }, { opacity: 1 }, at + i * 70);
  }
  const query = at + 5 * 70;
  // the four settings rows stay (same keys) and move up at once; the four rows the query drops fade where they stood at c
  first.forEach((row, i) => {
    if (m.palette.rowsMs && i < 4) play(row, [{ opacity: 1 }, { opacity: 0 }], query, pacedMs(m.palette.rowsMs), OUT(), "forwards");
    else cut(row, { opacity: 1 }, { opacity: 0 }, query);
  });
  const home = [{ transform: `translateY(${3 * 51}px)` }, { transform: "translateY(0px)" }];
  if (glide) play(hi, home, query, pacedMs(m.palette.glideMs), OUT(), "forwards");
  else cut(hi, home[0], home[1], query);
  for (const row of second) cut(row, { opacity: 0 }, { opacity: 1 }, query);
  const close = query + 1100;
  const out = m.palette.leave;
  if (!out) {
    cut(dim, { opacity: 1 }, { opacity: 0 }, close);
    return cut(box, { opacity: 1 }, { opacity: 0 }, close) + 500;
  }
  play(dim, [{ opacity: 1 }, { opacity: 0 }], close, pacedMs(out.ms), OUT(), "forwards");
  return leave(box, out.ms, out.scale, out.y, close) + 500;
}

/** Settings: open, two sections, close. */
function settings(stage: HTMLElement, m: DesktopMotion): number {
  shell(stage);
  const dim = scrim(stage);
  const box = h("div", `position:absolute;left:50%;top:50%;width:760px;height:540px;margin:-270px 0 0 -380px;border-radius:14px;background:${C.menu};box-shadow:${C.shadow};display:flex;overflow:hidden;opacity:0;z-index:6;`, "", stage);
  const rail = h("div", `width:200px;flex:none;padding:16px 8px;background:${C.panel};`, "", box);
  const names = ["General", "Texting", "Computer", "Permissions", "Notifications", "About"];
  const items = names.map((name, i) => h("div", `padding:7px 10px;border-radius:8px;font-size:13px;color:${C.ink};${i === 0 ? `background:${C.hover};` : ""}`, name, rail));
  const body = h("div", "position:relative;flex:1;", "", box);
  const panes = [0, 1, 2].map((p) => {
    const pane = h("div", `position:absolute;inset:0;padding:22px 26px;opacity:${p === 0 ? 1 : 0};`, "", body);
    h("div", `font-weight:600;font-size:15px;color:${C.ink};margin-bottom:16px;`, names[p], pane);
    for (let r = 0; r < 6; r++) {
      const row = h("div", `display:flex;justify-content:space-between;align-items:center;padding:12px 0;box-shadow:inset 0 -0.5px 0 ${C.edge};font-size:13px;color:${C.ink};`, "", pane);
      h("span", "", ["Theme", "Language", "Send with Enter", "Sounds", "Start at login", "Check for updates"][(r + p * 2) % 6], row);
      h("span", `width:34px;height:20px;border-radius:10px;background:${(r + p) % 3 ? C.accent : C.tone};`, "", row);
    }
    return pane;
  });
  const d = m.dialog;
  const a = m.pick === "a";
  play(dim, [{ opacity: 0 }, { opacity: 1 }], LEAD, pacedMs(d.scrimMs), OUT());
  enter(box, d.enter, LEAD);
  let at = LEAD + 1000;
  for (const next of [1, 2]) {
    cut(items[next - 1], { background: C.hover }, { background: "transparent" }, at);
    cut(items[next], { background: "transparent" }, { background: C.hover }, at);
    cut(panes[next - 1], { opacity: 1 }, { opacity: 0 }, at);
    if (a) play(panes[next], [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], at, 180, MADANI_OUT);
    else play(panes[next], [{ opacity: m.swap.from, transform: `translateY(${m.swap.y}px)`, filter: `blur(${m.swap.blur}px)` }, { opacity: 1, transform: "none", filter: "blur(0px)" }], at, pacedMs(m.swap.ms), OUT());
    at += 800;
  }
  at += 200;
  play(dim, [{ opacity: 1 }, { opacity: 0 }], at, pacedMs(a ? 120 : d.leave.ms), OUT(), "forwards");
  if (a) return play(box, [{ opacity: 1 }, { opacity: 0 }], at, pacedMs(120), OUT(), "forwards") + 500;
  return leave(box, d.leave.ms, d.leave.scale, d.leave.y, at) + 500;
}

/** The bot panel: open, a tab and back, close. */
function panel(stage: HTMLElement, m: DesktopMotion): number {
  const { panelSlot } = shell(stage);
  const inner = h("div", "position:absolute;left:0;top:0;bottom:0;width:320px;padding:16px;", "", panelSlot);
  const head = h("div", "display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px 0 14px;", "", inner);
  avatar(head, 3, 56);
  h("div", `font-weight:600;font-size:15px;color:${C.ink};`, "travel", head);
  const tabs = h("div", `position:relative;display:flex;gap:4px;padding:3px;border-radius:10px;background:${C.tone};margin-bottom:12px;`, "", inner);
  const tabNames = ["Details", "Library", "Computer"];
  const tabEls = tabNames.map((n, i) => h("div", `flex:1;text-align:center;padding:5px 0;border-radius:8px;font-size:12px;color:${C.ink};${i === 0 ? `background:${C.menu};` : ""}`, n, tabs));
  const content = h("div", "position:relative;", "", inner);
  const bodies = [0, 1].map((t) => {
    const b = h("div", `position:absolute;left:0;right:0;top:0;opacity:${t === 0 ? 1 : 0};`, "", content);
    for (let r = 0; r < 5; r++) h("div", `padding:11px 4px;font-size:13px;color:${C.ink};box-shadow:inset 0 -0.5px 0 ${C.edge};`, t === 0 ? ["Model", "Memory", "Skills", "Routines", "Instructions"][r] : ["flight-friday.pdf", "hotel-booking.pdf", "itinerary.md", "receipts/", "notes.md"][r], b);
    return b;
  });
  const ms = m.panel.ms;
  const ease = cssCurve(m.panel.curve);
  play(panelSlot, [{ width: "0px" }, { width: "320px" }], LEAD, ms, ease);
  const at = LEAD + 1100;
  cut(tabEls[0], { background: C.menu }, { background: "transparent" }, at);
  cut(tabEls[1], { background: "transparent" }, { background: C.menu }, at);
  cut(bodies[0], { opacity: 1 }, { opacity: 0 }, at);
  if (m.pick === "a") play(bodies[1], [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], at, 220, MADANI_OUT);
  else play(bodies[1], [{ opacity: m.swap.from, transform: `translateY(${m.swap.y}px)`, filter: `blur(${m.swap.blur}px)` }, { opacity: 1, transform: "none", filter: "blur(0px)" }], at, pacedMs(m.swap.ms), OUT());
  return play(panelSlot, [{ width: "320px" }, { width: "0px" }], at + 1100, ms, ease, "forwards") + 500;
}

function menuBox(stage: HTMLElement, items: string[], css: string, origin: string): HTMLElement {
  const menu = h("div", `position:absolute;${css}width:210px;padding:6px;border-radius:14px;background:${C.menu};box-shadow:${C.shadow};transform-origin:${origin};opacity:0;z-index:6;`, "", stage);
  for (const item of items) h("div", `padding:8px 10px;border-radius:8px;font-size:13px;color:${C.ink};`, item, menu);
  return menu;
}

function menuIn(menu: HTMLElement, m: DesktopMotion, at: number, shift: number | null): number {
  const e = { ...m.menu.enter, y: shift ?? m.menu.enter.y };
  return enter(menu, e, at);
}

/** A bot's menu out of its row, then the composer's + menu opening upward out of its button. */
function menus(stage: HTMLElement, m: DesktopMotion): number {
  const { rows } = shell(stage);
  const ctx = menuBox(stage, ["Rename", "Pin", "Move to group", "Archive"], `left:${150}px;top:${rows[1].offsetTop + 40}px;`, "16px 0");
  menuIn(ctx, m, LEAD, null);
  leave(ctx, m.menu.leave.ms, m.menu.leave.scale, m.menu.leave.y, LEAD + 1000);
  const up = menuBox(stage, ["Attach a file", "Take a screenshot", "Use the computer", "Start a call"], `left:${260 + 48 + 10}px;bottom:${24 + 52 + 8}px;`, "16px 100%");
  const at = LEAD + 1700;
  menuIn(up, m, at, m.pick === "a" ? 4 : Math.abs(m.menu.enter.y));
  return leave(up, m.menu.leave.ms, m.menu.leave.scale, -m.menu.leave.y, at + 1000) + 500;
}

function dialogBox(stage: HTMLElement, title: string, body: string, action: string, danger: boolean): HTMLElement {
  const box = h("div", `position:absolute;left:50%;top:50%;width:400px;margin:-100px 0 0 -200px;border-radius:14px;background:${C.menu};box-shadow:${C.shadow};padding:20px;opacity:0;z-index:6;`, "", stage);
  h("div", `font-weight:600;font-size:14px;color:${C.ink};margin-bottom:6px;`, title, box);
  h("div", `font-size:13px;line-height:18px;color:${C.soft};margin-bottom:18px;`, body, box);
  const bar = h("div", "display:flex;justify-content:flex-end;gap:8px;", "", box);
  h("div", `padding:6px 14px;border-radius:999px;background:${C.tone};color:${C.ink};font-size:13px;`, "Cancel", bar);
  h("div", `padding:6px 14px;border-radius:999px;background:${danger ? "#e5484d" : C.ink};color:${danger ? "#fff" : C.app};font-size:13px;`, action, bar);
  return box;
}

/** A confirm, then Create bot: dialogMotion at each pick. */
function dialogs(stage: HTMLElement, m: DesktopMotion): number {
  shell(stage);
  const d = m.dialog;
  let at = LEAD;
  const boxes = [dialogBox(stage, "Archive travel?", "Its chats stay in archived, and you can bring it back any time.", "Archive", true), dialogBox(stage, "New bot", "Give it a name and a job. You can change both later.", "Create", false)];
  let end = 0;
  for (const box of boxes) {
    const dim = scrim(stage);
    stage.appendChild(box);
    play(dim, [{ opacity: 0 }, { opacity: 1 }], at, pacedMs(d.scrimMs), OUT());
    if (m.pick !== "a" && d.enter.curve && "stiffness" in d.enter.curve) {
      const spring = pacedSpring({ ...d.enter.curve, mass: 1 });
      const timing = springTiming(spring.stiffness, spring.damping);
      const [from, to] = enterFrames(d.enter);
      box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: pacedMs(d.enter.ms), delay: at, easing: OUT(), fill: "both" });
      play(box, [{ transform: from.transform, filter: from.filter }, { transform: to.transform, filter: to.filter }], at, timing.duration, timing.easing);
    } else enter(box, d.enter, at);
    at += 1100;
    play(dim, [{ opacity: 1 }, { opacity: 0 }], at, pacedMs(d.leave.ms), OUT(), "forwards");
    end = leave(box, d.leave.ms, d.leave.scale, d.leave.y, at);
    at += 500;
  }
  return end + 500;
}

/** The sidebar to avatars and back, then another chat opened. */
function sidebar(stage: HTMLElement, m: DesktopMotion): number {
  const { sidebar: bar, rows, main, transcript } = shell(stage);
  const ms = pacedMs(m.sidebar.ms);
  const ease = cssCurve(m.sidebar.curve);
  play(bar, [{ width: "260px" }, { width: "72px" }], LEAD, ms, ease);
  const back = LEAD + 1200;
  play(bar, [{ width: "72px" }, { width: "260px" }], back, ms, ease, "forwards");
  const at = back + 1300;
  cut(rows[3], { background: C.hover }, { background: "transparent" }, at);
  cut(rows[5], { background: "transparent" }, { background: C.hover }, at);
  cut(transcript, { opacity: 1 }, { opacity: 0 }, at);
  const next = transcriptOf(main, 1);
  next.style.opacity = "0";
  const s = m.chatSwitch;
  if (!s) cut(next, { opacity: 0 }, { opacity: 1 }, at);
  else play(next, [{ opacity: s.from, translate: `0 ${s.y}px`, filter: `blur(${s.blur}px)` }, { opacity: 1, translate: "0 0", filter: "blur(0px)" }], at, pacedMs(s.ms), OUT());
  return at + 1200;
}

function toastBox(stage: HTMLElement, text: string): HTMLElement {
  const t = h("div", `position:absolute;left:calc(260px + (100% - 260px) / 2);bottom:88px;width:400px;margin-left:-200px;display:flex;align-items:center;gap:10px;padding:9px 10px 9px 12px;border-radius:10px;background:${C.menu};box-shadow:${C.shadow};font-size:13px;color:${C.ink};opacity:0;z-index:6;`, "", stage);
  h("span", `color:${C.soft};`, "✓", t);
  h("span", "flex:1;", text, t);
  h("span", `padding:2px 10px;border-radius:999px;background:${C.tone};font-size:12px;`, "Undo", t);
  return t;
}

/** A toast in, gone at once, then a second. */
function toasts(stage: HTMLElement, m: DesktopMotion): number {
  shell(stage);
  let at = LEAD;
  for (const text of ["Archived travel", "Copied the link to this chat"]) {
    const t = toastBox(stage, text);
    const spec = m.toast;
    if (!spec) cut(t, { opacity: 0 }, { opacity: 1 }, at);
    else {
      const ms = pacedMs(spec.ms);
      t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, delay: at, easing: OUT(), fill: "both" });
      play(t, [{ translate: `0 ${spec.y}`, scale: String(spec.scale) }, { translate: "0 0", scale: "1" }], at, ms, cssCurve(spec.curve));
    }
    at += 1300;
    if (!spec) cut(t, { opacity: 1 }, { opacity: 0 }, at);
    else play(t, [{ opacity: 1, translate: "0 0", scale: "1" }, { opacity: 0, translate: `0 ${spec.leaveY}`, scale: String(spec.leaveScale) }], at, pacedMs(spec.leaveMs), OUT(), "forwards");
    at += 400;
  }
  return at + 300;
}

/** A row hovered and pressed in the sidebar, then the send button pressed. */
function press(stage: HTMLElement, m: DesktopMotion): number {
  const { rows, composer } = shell(stage);
  const send = h("div", `position:absolute;right:10px;width:32px;height:32px;border-radius:50%;background:${C.ink};`, "", composer);
  const p = m.press;
  const row = rows[1];
  const hover = 140;
  play(row, [{ backgroundColor: "rgb(0 0 0 / 0)" }, { backgroundColor: C.hover }], LEAD, hover, QUINT);
  const down = (el: HTMLElement, scale: number, at: number) => {
    play(el, [{ scale: "1" }, { scale: String(scale) }], at, p.downMs, MADANI_OUT, "forwards");
    return play(el, [{ scale: String(scale) }, { scale: "1" }], at + 180, p.upMs, cssCurve(p.up), "forwards");
  };
  down(row, p.soft, LEAD + 500);
  play(row, [{ backgroundColor: C.hover }, { backgroundColor: "rgb(0 0 0 / 0)" }], LEAD + 1300, hover, QUINT, "forwards");
  down(send, p.scale, LEAD + 1700);
  return down(send, p.scale, LEAD + 2500) + 600;
}

const SCENES: Record<DesktopScene, (stage: HTMLElement, m: DesktopMotion) => number> = { palette, settings, panel, menus, dialogs, sidebar, toasts, press };

/** Draws the scene three times side by side in `theme` and returns the clip's length in ms. */
export function mountDesktop(root: HTMLElement, scene: DesktopScene, theme: Theme): number {
  C = COLORS[theme];
  const zoom = 0.5;
  root.style.cssText = `display:flex;gap:16px;padding:16px;background:${theme === "dark" ? "#0a0a0a" : "#e9e9e7"};font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;width:max-content;`;
  let longest = 0;
  for (const pick of ["a", "b", "c"] as const) {
    const pane = h("div", "display:flex;flex-direction:column;gap:8px;", "", root);
    h("div", `font-size:14px;font-weight:600;color:${theme === "dark" ? "#f5f5f5" : "#1c1c1c"};`, PICK_LABELS[pick], pane);
    const frame = h("div", `width:${W * zoom}px;height:${H * zoom}px;overflow:hidden;border-radius:10px;background:${C.app};`, "", pane);
    const stage = h("div", `position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${C.app};transform:scale(${zoom});transform-origin:0 0;`, "", frame);
    longest = Math.max(longest, SCENES[scene](stage, DESKTOP_MOTIONS[pick]));
  }
  return longest + 300;
}

export const GLOBAL_SPEED = `global pick ${MOTION.pick.toUpperCase()}: durations x${MOTION.scale}, ease-out ${cssBezier(pacedOut([0.22, 1, 0.36, 1]))}`;
