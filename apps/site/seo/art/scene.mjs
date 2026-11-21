// the art kit: every seo page gets its own pixel picture, put together from the site's own pieces. a scene is a sky strip
// (art/strip-*.webp), a pixel ground drawn here, one or two objects (art/s-*.webp and the kit's art/kit/p-*.webp), two or
// three of the pixel bots, an app tile (the official mark from art/logos, or a plain tile with the name) and a short chat
// bubble. which pieces and where comes from the page's address, so a page keeps its picture from build to build and no two
// pages share one. a record can name its own pieces under "art". sceneHtml() lays a scene out as a page that
// seo/art/render.py photographs: the hero (1320 by 528, and 660 wide for phones). the share card is art-src/og6's.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import MadaniPixel from '../../mascot-src/pixel/engine.js';
import { CROWD, COLOURS } from '../../mascot-src/pixel/crowd.js';

// each sky in words, for alt text, and how far down (0 top, 1 bottom) the hero shows it
export const SKIES = {
  birches: { words: 'a birch wood under purple hills', y: 0.8 }, falls: { words: 'white cliffs with a waterfall', y: 0.1 },
  islands: { words: 'little green islands on a lake', y: 0.7 }, pond: { words: 'a lily pond', y: 0.55 },
  cliffs: { words: 'chalk cliffs by the sea', y: 0.1 }, dunes: { words: 'sand dunes by the sea', y: 0.9 },
  layers: { words: 'snowy hills and green fields', y: 1 }, sky: { words: 'an open blue sky', y: 0.6 },
  lost: { words: 'a calm sea with one small island', y: 0.5 }, terraces: { words: 'green terraced fields', y: 1 },
};
// every object in the kit, in words
export const PROPS = {
  's-books': 'a stack of books', 's-button': 'a big button', 's-clock': 'an alarm clock and a calendar', 's-cloud': 'a small cloud',
  's-coins': 'a coin purse', 's-computer': 'a desktop computer', 's-key': 'a key with a tag', 's-mailbox': 'a mailbox with a letter',
  's-map': 'a folded map', 's-mobile': 'a phone', 's-notebook': 'a notebook', 's-palette': 'a paint palette', 's-parcel': 'a wrapped parcel',
  's-phone': 'an old desk phone', 's-plug': 'a plug and a socket', 's-server': 'a server box', 's-signpost': 'a signpost',
  'p-bag': 'a shopping bag', 'p-binoculars': 'a pair of binoculars', 'p-briefcase': 'a briefcase', 'p-bubbles': 'two chat bubbles',
  'p-cap': 'a graduation cap on books', 'p-chart': 'a chart on an easel', 'p-folder': 'a folder of papers', 'p-house': 'a little house',
  'p-laptop': 'a closed laptop under a moon', 'p-magnifier': 'a magnifying glass', 'p-megaphone': 'a megaphone', 'p-mug': 'a coffee mug',
  'p-newspaper': 'a newspaper', 'p-receipt': 'a long receipt', 'p-shield': 'a shield with a tick',
};
// the objects each kind of page draws from, when its record names none
const POOLS = {
  integration: ['s-plug', 'p-folder', 'p-bubbles', 's-parcel', 'p-chart', 's-key'],
  compare: ['s-signpost', 'p-magnifier', 'p-binoculars', 's-map'],
  guide: ['s-books', 's-map', 'p-magnifier', 's-notebook', 's-computer', 's-clock', 'p-shield', 's-signpost'],
  usecase: ['s-mailbox', 's-clock', 'p-folder', 'p-chart', 'p-newspaper', 'p-receipt', 'p-binoculars'],
  role: ['p-briefcase', 'p-cap', 'p-house', 'p-bag', 'p-megaphone', 'p-chart'],
  routine: ['s-clock', 'p-mug', 'p-newspaper', 'p-receipt', 's-mailbox'],
  glossary: ['s-books', 's-notebook', 'p-magnifier'],
  tool: ['s-coins', 'p-chart', 's-button', 's-computer'],
  action: ['p-magnifier', 'p-folder', 's-notebook', 'p-chart', 's-mailbox', 'p-bubbles', 'p-megaphone', 's-parcel', 's-key', 's-plug'],
};
const GROUNDS = {
  meadow: { words: 'a grassy meadow', rows: ['#c9f63f', '#b9ea35', '#a9de33'], dots: ['#ffc4dd', '#ffffff', '#fff3a0'] },
  sand: { words: 'a sandy path', rows: ['#fbf0cf', '#f5e4b4', '#efd99e'], dots: ['#c9f63f', '#ffffff'] },
  lilac: { words: 'a lilac hill', rows: ['#d0cefb', '#c2bff6', '#b4b0ef'], dots: ['#ffffff', '#fff3a0', '#ffc4dd'] },
  lemon: { words: 'a lemon field', rows: ['#fff3a0', '#ffec7d', '#fbe36a'], dots: ['#ffc4dd', '#ffffff', '#c9f63f'] },
};
const BOT_WORDS = { blue: 'blue', sky: 'sky blue', cyan: 'cyan', violet: 'purple', pink: 'pink', coral: 'coral', tangerine: 'orange', sun: 'yellow', lime: 'lime', mint: 'mint', emerald: 'green', indigo: 'indigo' };

export const sceneId = (at) => at.replace(/^\//, '').replace(/\//g, '--');

// a little seeded random from the page's address (and a salt when two pages would get the same picture)
function rng(seed) {
  let h = createHash('sha256').update(seed).digest(), i = 0;
  return () => { if (i >= h.length - 4) { h = createHash('sha256').update(h).digest(); i = 0; } const v = h.readUInt32BE(i); i += 4; return v / 2 ** 32; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const shuffle = (r, list) => list.map((v) => [r(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

const svgCache = new Map();
function botSvg(shape, colour, size) {
  if (!svgCache.has(shape)) { const r = MadaniPixel.rest(shape); svgCache.set(shape, `<g transform="translate(10 10) scale(${80 / r.G})"><path fill="currentColor" d="${r.body}"/><path fill="#fff" d="${r.eyes}"/></g>`); }
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" shape-rendering="crispEdges" style="color:${COLOURS[colour]}">${svgCache.get(shape)}</svg>`;
}

// the scene for one page. kitDir is public/landing/art, to know each object's size and which marks exist
export function scene(record, kitDir, salt = '') {
  const r = rng(record.path + salt);
  const art = record.art || {};
  const pool = POOLS[record.kind] || POOLS.guide;
  const props = (art.props || shuffle(r, pool).slice(0, r() < 0.55 ? 2 : 1)).slice(0, 2);
  for (const p of props) if (!PROPS[p]) throw new Error(`${record.path}: art.props names ${p}, which the kit does not have`);
  const sky = art.sky || pick(r, Object.keys(SKIES));
  const ground = art.ground || pick(r, Object.keys(GROUNDS));
  const crowd = shuffle(r, CROWD.map(([name, colour]) => [name, colour]));
  const used = new Set();
  const bots = (art.bots || crowd.slice(0, r() < 0.5 ? 2 : 3).map(([s, c]) => {
    let colour = r() < 0.7 ? c : pick(r, Object.keys(COLOURS));
    while (used.has(colour)) colour = pick(r, Object.keys(COLOURS));
    used.add(colour); return `${s} ${colour}`;
  })).map((b) => { const [shape, colour] = b.split(' '); return { shape, colour }; });
  const logo = art.logo ? ['svg', 'png'].map((ext) => `logos/${art.logo}.${ext}`).find((f) => fs.existsSync(path.join(kitDir, f))) : null;
  if (art.logo && !logo) throw new Error(`${record.path}: no mark art/logos/${art.logo}.svg or .png`);
  const sizeOf = (p) => { const file = path.join(kitDir, p.startsWith('p-') ? `kit/${p}.webp` : `${p}.webp`); return webpSize(file); };
  return {
    id: sceneId(record.path), path: record.path, sky, flip: art.flip ?? r() < 0.5, ground, shift: Math.round(r() * 100),
    props: props.map((p) => ({ name: p, file: p.startsWith('p-') ? `kit/${p}.webp` : `${p}.webp`, size: sizeOf(p) })),
    bots, tile: art.tile === false ? null : (logo || art.label) ? { logo, label: art.label || null, name: art.label || art.logo } : null,
    bubble: art.bubble || null, side: r() < 0.5 ? 'left' : 'right', clouds: [r(), r(), r()], dots: Array.from({ length: 18 }, () => [r(), r()]),
    title: record.og_title || record.h1, line: record.og_line || '',
  };
}
export const signature = (s) => [s.sky, s.flip, s.ground, ...s.props.map((p) => p.name), ...s.bots.map((b) => b.shape), s.tile?.logo || s.tile?.label || ''].join('|');

// alt text from what is in the picture
export function altText(s) {
  const things = [...(s.tile ? [s.tile.logo ? `the ${s.tile.name} mark on a white tile` : `a tile saying ${s.tile.label}`] : []), ...s.props.map((p) => PROPS[p.name])];
  const bots = s.bots.map((b) => { const word = BOT_WORDS[b.colour] || b.colour; return `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word} ${b.shape === 'kit' ? 'cat bot' : 'pixel bot'}`; });
  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);
  return `pixel art: ${list(bots)} beside ${list(things)}, on ${GROUNDS[s.ground].words} in front of ${SKIES[s.sky].words}${s.bubble ? `, one saying "${s.bubble}"` : ''}`;
}

function webpSize(file) {
  const b = fs.readFileSync(file), kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  const n = b.readUInt32LE(21); return [1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)];
}
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// the pixel ground: rows of colour with a stepped top edge, a few flowers, drawn as crisp svg blocks
function groundSvg(s, w, h) {
  const g = GROUNDS[s.ground], cell = 12, cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
  const top = Array.from({ length: cols }, (_, i) => Math.round(1.6 + 1.4 * Math.sin((i + s.shift) / 7) + Math.sin((i + s.shift) / 2.3) * 0.6));
  let rects = '';
  for (let i = 0; i < cols; i++) {
    const t = top[i];
    rects += `<rect x="${i * cell}" y="${t * cell}" width="${cell}" height="${h}" fill="${g.rows[0]}"/>`;
    rects += `<rect x="${i * cell}" y="${(t + 3) * cell}" width="${cell}" height="${h}" fill="${g.rows[1]}"/>`;
    rects += `<rect x="${i * cell}" y="${(t + 6) * cell}" width="${cell}" height="${h}" fill="${g.rows[2]}"/>`;
  }
  s.dots.forEach(([a, b], n) => { rects += `<rect x="${Math.floor(a * cols) * cell}" y="${(5 + Math.floor(b * (rows - 6))) * cell}" width="${cell}" height="${cell}" fill="${g.dots[n % g.dots.length]}"/>`; });
  return `<svg class="ground" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges" preserveAspectRatio="none">${rects}</svg>`;
}

// the page render.py photographs: the page picture
export function sceneHtml(s, mode, { base, font }) {
  const W = 1320, H = 528, groundH = 132;
  // the stage is where the bots and objects stand: the whole width
  const stage = [40, W - 40];
  const span = stage[1] - stage[0];
  const floor = H - groundH + 30;
  const items = [];
  const scale = 0.7;
  const propEls = s.props.map((p, i) => {
    const h = Math.round(Math.min(p.size[1], 420) * scale * (i ? 0.8 : 1)), w = Math.round(p.size[0] * h / p.size[1]);
    return { w, h, html: (x) => `<img class="prop" src="${p.file}" style="left:${x}px;top:${floor - h + 14}px;width:${w}px;height:${h}px" alt="">` };
  });
  const botEls = s.bots.map((b, i) => { const size = [136, 118, 104][i] || 104; return { bot: true, w: size, h: size, html: (x) => `<div class="bot" style="left:${x}px;top:${floor - size * 0.9}px">${botSvg(b.shape, b.colour, size)}</div>` }; });
  const tileSize = 150;
  const tileEl = s.tile ? { w: tileSize, h: tileSize, html: (x) => `<div class="tile" style="left:${x}px;top:${floor - tileSize - 4}px;width:${tileSize}px;height:${tileSize}px">${s.tile.logo ? `<img src="${s.tile.logo}" alt="">` : `<span class="${s.tile.label.length <= 3 ? 'big' : s.tile.label.length <= 9 ? 'mid' : ''}">${escHtml(s.tile.label)}</span>`}</div>` } : null;
  // along the ground: an object at each end, the bots between, the app tile among them
  const middle = [...botEls]; if (tileEl) middle.splice(Math.min(1 + (s.side === 'left' ? 1 : 0), middle.length), 0, tileEl);
  const row = (s.side === 'left' ? [propEls[0], ...middle, propEls[1]] : [propEls[1], ...middle, propEls[0]]).filter(Boolean);
  const total = row.reduce((n, e) => n + e.w, 0), gap = Math.max(12, (span - total) / (row.length + 1));
  let x = stage[0] + gap, bubbleAt = null;
  for (const e of row) { items.push(e.html(Math.round(x))); if (e.bot && bubbleAt === null) bubbleAt = [x, e.h]; x += e.w + gap; }
  let bubble = '';
  if (s.bubble && bubbleAt) bubble = `<div class="bubble" style="left:${Math.round(Math.min(Math.max(bubbleAt[0] - 12, 16), W - 440))}px;top:${Math.round(floor - bubbleAt[1] * 0.9 - 92)}px">${escHtml(s.bubble)}</div>`;
  const clouds = s.clouds.slice(0, 2).map((c, i) => `<img class="cloud" src="cloud-${i ? 'pink' : 'lemon'}.png" style="left:${Math.round(40 + c * (W - 320))}px;top:${Math.round(24 + i * 54 + c * 30)}px" alt="">`).join('');
  const sky = SKIES[s.sky];
  return `<!doctype html><meta charset="utf-8"><base href="${base}"><style>
@font-face { font-family: "General Sans"; src: url("${font}"); font-weight: 200 700; }
* { box-sizing: border-box; margin: 0; }
body { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #a6e1fc; font-family: "General Sans"; color: #131316; -webkit-font-smoothing: antialiased; }
.sky { position: absolute; left: 0; width: 100%; height: ${Math.round(W / 2.4)}px; top: ${Math.round((H - groundH + 40 - W / 2.4) * sky.y)}px; object-fit: cover; image-rendering: pixelated; ${s.flip ? 'transform: scaleX(-1);' : ''} }
.ground { position: absolute; left: 0; bottom: 0; }
.prop, .cloud { position: absolute; image-rendering: pixelated; }
.cloud { width: 180px; height: 60px; }
.bot { position: absolute; }
.bot svg { display: block; overflow: visible; }
.tile { position: absolute; display: grid; place-items: center; border-radius: 28%; background: #fff; box-shadow: 0 10px 0 rgba(27,27,31,0.08); }
.tile img { width: 56%; height: 56%; object-fit: contain; }
.tile span.big { font-size: 64px; } .tile span.mid { font-size: 27px; }
.tile span { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; text-align: center; padding: 10px; line-height: 1.05; }
.bubble { position: absolute; max-width: 400px; padding: 14px 20px; border-radius: 24px 24px 24px 6px; background: #fff; font-size: 26px; font-weight: 500; letter-spacing: -0.02em; box-shadow: 0 8px 0 rgba(27,27,31,0.07); }
</style><img class="sky" src="strip-${s.sky}.webp" alt="">${clouds}${groundSvg(s, W, groundH)}${items.join('')}${bubble}`;
}
