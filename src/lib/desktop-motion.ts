import { cssBezier, MOTION, pacedMs, pacedOut, springTiming, type MotionSpeed } from "./motion-speed";

export type DesktopMotionPick = "a" | "b" | "c";

/** A surface arriving: `ms` before the global speed scales it; `curve` null takes the global ease-out. */
export type Enter = { ms: number; curve: Curve | null; scale: number; y: number; blur: number };
/** A surface leaving: a fade, with a scale toward `scale` and a drift of `y` px. */
export type Leave = { ms: number; scale: number; y: number };
/** A spring (mass 1): its shape as a CSS linear() over the surface's ms; motion plays it as physics. */
type Spring = { stiffness: number; damping: number };
type Curve = readonly [number, number, number, number] | Spring;
type Swap = { ms: number; y: number; blur: number; from: number };

export type DesktopMotion = {
  pick: DesktopMotionPick;
  /** the ⌘K palette: `enter` and `leave` null open and close it at once; `glideMs` 0 moves the highlight at once; `rowsMs`
   * 0 swaps filtered rows at once, otherwise rows fade in and out over it */
  palette: { enter: Enter | null; leave: Leave | null; glideMs: number; rowsMs: number; staggerMs: number };
  /** menus, listboxes and popovers, growing out of their trigger */
  menu: { enter: Enter; leave: Leave };
  /** centred dialogs and Settings; `scrimMs` before the global speed */
  dialog: { enter: Enter; leave: Leave; scrimMs: number };
  /** another Settings section or panel tab: the new content comes in this way, the old goes at once */
  swap: Swap;
  /** the bot panel's column opening and closing; ms is as written, not scaled */
  panel: { ms: number; curve: Curve | "soft" };
  /** the sidebar between names and avatars, before the global speed */
  sidebar: { ms: number; curve: Curve | "soft" };
  /** another chat opened: the transcript comes in this way; null shows it at once */
  chatSwitch: Swap | null;
  /** a passing toast rising in and leaving the way it came, faster; null puts it there and takes it away at once */
  toast: { ms: number; curve: Curve | "ease"; y: string; scale: number; leaveMs: number; leaveY: string; leaveScale: number } | null;
  /** a press: down to `scale`, back over `upMs` on `up` */
  press: { scale: number; soft: number; downMs: number; upMs: number; up: Curve | "release" };
};

const OUT = null;
const DRAWER = [0.32, 0.72, 0, 1] as const;
const EMIL_OUT = [0.23, 1, 0.32, 1] as const;

export const DESKTOP_MOTIONS: Record<DesktopMotionPick, DesktopMotion> = {
  a: {
    pick: "a",
    palette: { enter: null, leave: null, glideMs: 0, rowsMs: 0, staggerMs: 0 },
    menu: { enter: { ms: 120, curve: OUT, scale: 0.97, y: -4, blur: 0 }, leave: { ms: 80, scale: 0.98, y: -2 } },
    dialog: { enter: { ms: 200, curve: OUT, scale: 0.96, y: 0, blur: 0 }, leave: { ms: 120, scale: 0.98, y: 0 }, scrimMs: 160 },
    swap: { ms: 220, y: 6, blur: 0, from: 0 },
    panel: { ms: 260, curve: [0.2, 0, 0, 1] },
    sidebar: { ms: 500, curve: "soft" },
    chatSwitch: null,
    toast: null,
    press: { scale: 0.96, soft: 0.985, downMs: 160, upMs: 200, up: "release" },
  },
  b: {
    pick: "b",
    palette: { enter: { ms: 100, curve: OUT, scale: 0.98, y: 0, blur: 2 }, leave: { ms: 90, scale: 0.98, y: 0 }, glideMs: 0, rowsMs: 0, staggerMs: 0 },
    menu: { enter: { ms: 110, curve: OUT, scale: 0.96, y: 0, blur: 0 }, leave: { ms: 70, scale: 0.97, y: 0 } },
    dialog: { enter: { ms: 200, curve: OUT, scale: 0.97, y: 0, blur: 3 }, leave: { ms: 100, scale: 0.985, y: 0 }, scrimMs: 160 },
    swap: { ms: 120, y: 0, blur: 2, from: 0 },
    panel: { ms: 340, curve: DRAWER },
    sidebar: { ms: 300, curve: DRAWER },
    chatSwitch: { ms: 100, y: 0, blur: 2, from: 0.5 },
    toast: { ms: 286, curve: "ease", y: "100%", scale: 1, leaveMs: 200, leaveY: "100%", leaveScale: 1 },
    press: { scale: 0.97, soft: 0.99, downMs: 100, upMs: 160, up: EMIL_OUT },
  },
  c: {
    pick: "c",
    palette: { enter: { ms: 150, curve: { stiffness: 520, damping: 34 }, scale: 0.96, y: -8, blur: 4 }, leave: { ms: 100, scale: 0.97, y: -4 }, glideMs: 110, rowsMs: 90, staggerMs: 16 },
    menu: { enter: { ms: 180, curve: { stiffness: 560, damping: 34 }, scale: 0.94, y: -6, blur: 3 }, leave: { ms: 90, scale: 0.96, y: -3 } },
    dialog: { enter: { ms: 260, curve: { stiffness: 380, damping: 28 }, scale: 0.94, y: 8, blur: 6 }, leave: { ms: 105, scale: 0.97, y: 4 }, scrimMs: 200 },
    swap: { ms: 200, y: 8, blur: 4, from: 0 },
    panel: { ms: 476, curve: "soft" },
    sidebar: { ms: 420, curve: "soft" },
    chatSwitch: { ms: 180, y: 6, blur: 4, from: 0 },
    toast: { ms: 320, curve: { stiffness: 420, damping: 26 }, y: "16px", scale: 0.96, leaveMs: 160, leaveY: "8px", leaveScale: 0.97 },
    press: { scale: 0.95, soft: 0.98, downMs: 120, upMs: 380, up: { stiffness: 600, damping: 24 } },
  },
};

/** The desktop's motion. At A every surface keeps the motion it ships with. */
export const DESKTOP_MOTION: DesktopMotion = DESKTOP_MOTIONS.b;

const SOFT = "var(--madani-spring-soft)";

/** A curve as CSS: a bezier, the global ease-out (null), a spring as linear(), or the app's soft spring. */
export function cssCurve(curve: Curve | null | "soft" | "ease" | "release", speed: MotionSpeed = MOTION): string {
  if (curve === "soft") return SOFT;
  if (curve === "ease") return "ease";
  if (curve === "release") return "var(--madani-ease-release)";
  if (curve === null) return cssBezier(pacedOut([0.22, 1, 0.36, 1], speed));
  if ("stiffness" in curve) return springTiming(curve.stiffness, curve.damping).easing;
  return cssBezier(curve);
}

/** The custom properties the desktop stylesheet reads; set only for a pick other than A. */
export function desktopMotionVars(motion: DesktopMotion = DESKTOP_MOTION, speed: MotionSpeed = MOTION): Record<string, string> {
  const ms = (value: number) => `${pacedMs(value, speed)}ms`;
  const enter = (prefix: string, e: Enter) => ({
    [`--dm-${prefix}-ms`]: ms(e.ms), [`--dm-${prefix}-ease`]: cssCurve(e.curve, speed),
    [`--dm-${prefix}-scale`]: String(e.scale), [`--dm-${prefix}-y`]: `${e.y}px`, [`--dm-${prefix}-blur`]: `${e.blur}px`,
  });
  const vars: Record<string, string> = {
    ...enter("menu", motion.menu.enter),
    "--dm-menu-out-ms": ms(motion.menu.leave.ms), "--dm-menu-out-scale": String(motion.menu.leave.scale), "--dm-menu-out-y": `${motion.menu.leave.y}px`,
    ...enter("dialog", motion.dialog.enter),
    "--dm-scrim-ms": ms(motion.dialog.scrimMs), "--dm-dialog-out-ms": ms(motion.dialog.leave.ms),
    "--dm-swap-ms": ms(motion.swap.ms), "--dm-swap-y": `${motion.swap.y}px`, "--dm-swap-blur": `${motion.swap.blur}px`, "--dm-swap-from": String(motion.swap.from),
    "--dm-sidebar-ms": ms(motion.sidebar.ms), "--dm-sidebar-ease": cssCurve(motion.sidebar.curve, speed),
    "--dm-panel-ms": `${motion.panel.ms}ms`, "--dm-panel-ease": cssCurve(motion.panel.curve, speed),
    "--dm-press-scale": String(motion.press.scale), "--dm-press-soft": String(motion.press.soft),
    "--dm-press-down-ms": `${motion.press.downMs}ms`, "--dm-press-up-ms": `${motion.press.upMs}ms`, "--dm-press-up-ease": cssCurve(motion.press.up, speed),
  };
  if (motion.palette.enter) Object.assign(vars, enter("palette", motion.palette.enter));
  if (motion.palette.rowsMs) Object.assign(vars, { "--dm-rows-ms": ms(motion.palette.rowsMs), "--dm-stagger-ms": ms(motion.palette.staggerMs) });
  if (motion.toast) Object.assign(vars, { "--dm-toast-ms": ms(motion.toast.ms), "--dm-toast-ease": cssCurve(motion.toast.curve, speed), "--dm-toast-y": motion.toast.y, "--dm-toast-scale": String(motion.toast.scale) });
  return vars;
}

/** Marks the desktop root with the pick and its properties. The phone app keeps its own motion. */
export function applyDesktopMotion(root: HTMLElement, motion: DesktopMotion = DESKTOP_MOTION): void {
  if (motion.pick === "a" || root.dataset.mobileApp) return;
  root.dataset.desktopMotion = motion.pick;
  if (motion.palette.enter) root.dataset.desktopMotionPalette = "";
  if (motion.palette.rowsMs) root.dataset.desktopMotionRows = "";
  if (motion.toast) root.dataset.desktopMotionToast = "";
  for (const [name, value] of Object.entries(desktopMotionVars(motion))) root.style.setProperty(name, value);
}

/** The motion a desktop surface plays now: A on the phone. */
export function desktopMotion(): DesktopMotion {
  if (typeof document !== "undefined" && document.documentElement?.dataset?.mobileApp) return DESKTOP_MOTIONS.a;
  return DESKTOP_MOTION;
}
