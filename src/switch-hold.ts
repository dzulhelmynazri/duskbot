// Runs before the app's own code: a page a switch of place opened paints the mascot the page before handed on, where
// the boot cover draws it, so no frame between the two pages is empty. Kept tiny so it is first to run.
import CREW from "../electron/resources/startup-crew.json";
import { HANDED_KEY, HOLD_ID } from "./lib/switch-hold-key";

const UNIT = 4;
const PAGES_WITHOUT_THE_APP = new Set(["/home", "/reconnect", "/pair", "/desktop-viewer"]);
type Sprite = { body: string; eyes: Record<string, string> };

function fill(g: CanvasRenderingContext2D, d: string | undefined, px: number) {
  for (const m of (d ?? "").matchAll(/M(\d+) (\d+)h(\d+)v1/g)) g.fillRect(Number(m[1]) * px, Number(m[2]) * px, Number(m[3]) * px, px);
}

function hold() {
  if (PAGES_WITHOUT_THE_APP.has(location.pathname)) return;
  const look = window.madaniDesktop?.workspaces?.takeLook?.();
  if (!look) return;
  (window as unknown as Record<string, unknown>)[HANDED_KEY] = look;
  const sprite = (CREW as Record<string, Sprite>)[look.crew];
  if (!sprite || !look.ink || !look.ground) return;
  const cover = document.createElement("div");
  cover.id = HOLD_ID;
  cover.setAttribute("aria-hidden", "true");
  cover.style.cssText = `position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:${look.ground}`;
  const canvas = document.createElement("canvas");
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  canvas.width = canvas.height = 16 * UNIT * dpr;
  canvas.style.cssText = `width:${16 * UNIT}px;height:${16 * UNIT}px;image-rendering:pixelated`;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.fillStyle = look.ink;
  fill(g, sprite.body, UNIT * dpr);
  g.fillStyle = "#fff";
  fill(g, sprite.eyes.idle, UNIT * dpr);
  cover.append(canvas);
  document.body.append(cover);
}

try { hold(); } catch { /* the boot cover still shows once the app loads */ }
