// the og6 share cards' world, from the waitlist page (the x banner): its banded pixel sky with scattered edges, the
// lilac line, the lime meadow rising into hills with flecks and flowers, and the pixel bots drawn by the engine in a pose.
// cards.mjs builds each card from these
import { createHash } from 'node:crypto';
import MadaniPixel from '../../mascot-src/pixel/engine.js';
import { COLOURS } from '../../mascot-src/pixel/crowd.js';

export const INK = '#1b1b1f';
const PAPER = '#fdfdfd', LILAC = '#d0cefb', LIME = '#c9f63f';
export const MOODS = {
  sky: { bands: ['#06bafd', '#3cd0fd', '#90e4fc', '#c2ecfc'] },
  teal: { bands: ['#0790b8', '#10abc9', '#69d6d6', '#c8f2b0'] },
  madani: { bands: ['#47308f', '#7845a6', '#d9649b', '#ffb08f'] },
  night: { bands: ['#0d1640', '#18275f', '#283b80', '#5b54b8'], night: true },
};
// a pose is the eyes, a lean and a squash
export const POSES = {
  open: { eyes: 'open', words: 'calm' },
  look: { eyes: 'open', gaze: 1, lean: 0.06, words: 'looking over' },
  focus: { eyes: 'focus', gaze: 1, words: 'concentrating' },
  happy: { eyes: 'happy', lean: -0.08, sq: 0.06, words: 'happy' },
  heart: { eyes: 'heart', words: 'with heart eyes' },
  big: { eyes: 'big', sq: -0.1, words: 'wide-eyed' },
  wink: { eyes: 'open', eyesR: 'happy', lean: 0.08, words: 'winking' },
  sleepy: { eyes: 'closed', sq: 0.08, words: 'asleep' },
  dizzy: { eyes: 'dizzy', lean: 0.12, words: 'dizzy' },
};

export function rng(seed) {
  let h = createHash('sha256').update(seed).digest(), i = 0;
  return () => { if (i >= h.length - 4) { h = createHash('sha256').update(h).digest(); i = 0; } const v = h.readUInt32BE(i); i += 4; return v / 2 ** 32; };
}

// a bot drawn by the pixel engine in a pose, as svg with its feet at the bottom edge of the body box
export function botSvg(shape, colour, pose = 'open', { grid = 26, flip = false } = {}) {
  const P = POSES[pose] || POSES.open, b = MadaniPixel.create(null, { body: shape, size: grid });
  const side = flip ? -1 : 1;
  b.lean.x = (P.lean || 0) * side; b.sq.x = P.sq || 0; b.gx.x = (P.gaze || 0) * side * -1; b.gy.x = 0; b.T = 0.3;
  b.draw(P.eyes, P.eyesR || P.eyes, 0, b.def.float ? -b.def.N * 0.1 : 0);
  const white = colour === 'white', fill = white ? '#ffffff' : COLOURS[colour] || colour;
  const { G, px, pt, W, H } = b;
  return { G, svg: (size, extra = '') => `<svg viewBox="${-px} ${-pt} ${W} ${H}" width="${(size * W) / G}" height="${(size * H) / G}" shape-rendering="crispEdges" style="${extra}"><path fill="${fill}" d="${b.d[0]}"/><path fill="${white ? INK : '#fff'}" d="${b.d[1]}"/></svg>`, px, pt, W, H };
}

// the world, as the waitlist page draws it: the sky's bands with their edges scattered upward (the band behind the words
// stays clean), the lilac line, the meadow rising into hills, grass flecks and pixel flowers. hills: [[centre, half, rise]]
export function worldSvg(mood, W, H, G, hills, seed, { clearTop = 0, clearBottom = 0, words = [0, 0, 0, 0] } = {}) {
  const r = rng(`world:${seed}`), b = 12, s = 6, snap = (v) => Math.round(v / b) * b, M = MOODS[mood], [c0, c1, c4, c5] = M.bands;
  const y1 = snap(Math.min(G * 0.14, clearTop - 2 * b)), y4 = snap(Math.max(G - 7 * b, clearBottom + 3 * b)), y5 = snap(Math.max(G - 4 * b, y4 + 2 * b));
  const bands = [[c0, 0], [c1, Math.max(b, y1)], [c4, y4], [c5, y5], [LILAC, G - b]];
  let out = '';
  bands.forEach(([c, y], i) => { out += `<rect x="0" y="${y}" width="${W}" height="${(bands[i + 1]?.[1] ?? G) - y}" fill="${c}"/>`; });
  for (let i = 1; i < bands.length - 1; i++) {
    const [c, y] = bands[i], [cp] = bands[i - 1];
    [0.42, 0.16, 0.05].forEach((p, k) => {
      for (let x = 0; x < W; x += b) {
        if (r() < p) out += `<rect x="${x}" y="${y - (k + 1) * b}" width="${b}" height="${b}" fill="${c}"/>`;
        if (k === 0 && r() < 0.1) out += `<rect x="${x}" y="${y}" width="${b}" height="${b}" fill="${cp}"/>`;
      }
    });
  }
  if (M.night) for (let i = 0; i < 46; i++) { const x = snap(r() * W), y = snap(r() * (G - 8 * b)), big = r() < 0.2; if (x > words[0] - 24 && x < words[2] + 24 && y > words[1] - 24 && y < words[3] + 24) continue; out += `<rect x="${x}" y="${y}" width="${big ? b : s}" height="${big ? b : s}" fill="${i % 4 ? '#fff3a0' : '#ffffff'}" opacity="${0.55 + r() * 0.45}"/>`; }
  // the meadow and its hills
  const ground = M.night ? '#8fb52b' : LIME, fleck = M.night ? '#86ab27' : '#c0ee36';
  for (let x = 0; x < W; x += b) {
    let y = G;
    for (const [hx, half, rise] of hills) { const d = Math.abs(x + b / 2 - hx) / half; if (d < 1) y = Math.min(y, snap(G - rise * (1 - d * d) ** 0.7)); }
    out += `<rect x="${x}" y="${y}" width="${b}" height="${H - y}" fill="${ground}"/>`;
  }
  for (let i = 0, n = Math.round((W * (H - G)) / 900); i < n; i++) out += `<rect x="${Math.round((r() * W) / s) * s}" y="${Math.round((G + b + r() * (H - G - b)) / s) * s}" width="${s * (r() < 0.5 ? 2 : 1)}" height="${s}" fill="${fleck}"/>`;
  const cols = [PAPER, '#ffc4dd', '#fff3a0'];
  for (let i = 0, n = Math.max(8, Math.round(W / 90)); i < n; i++) {
    const x = Math.round((r() * W) / s) * s, y = Math.round((G + 3 * b + r() * (H - G - 5 * b)) / s) * s;
    out += `<g fill="${cols[i % 3]}"><rect x="${x}" y="${y - s}" width="${s}" height="${s}"/><rect x="${x - s}" y="${y}" width="${s}" height="${s}"/><rect x="${x + s}" y="${y}" width="${s}" height="${s}"/><rect x="${x}" y="${y + s}" width="${s}" height="${s}"/></g><rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${i % 3 === 2 ? '#ffb020' : '#ffe25c'}"/>`;
  }
  return `<svg class="world" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges">${out}</svg>`;
}


