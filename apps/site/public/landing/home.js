const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const M = window.Motion;
const hasIO = 'IntersectionObserver' in window;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
// runs fn the first time enough of el is on screen
function once(el, fn, threshold = 0.4) {
  if (!el || !hasIO) return;
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { threshold });
  io.observe(el);
}

// the bots themselves (looks, blinks, moods, answers to a poke) are the app's mascot code, in mascot.js. they show how
// they feel by moving, never with words in a bubble

// the bot beside the questions nods along

// the stickers in the big sentence can be picked up; they spring back when dropped
if (fine && !still) for (const el of $$('[data-sticker]')) {
  let id = null, sx = 0, sy = 0;
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); id = e.pointerId; el.setPointerCapture(id); sx = e.clientX; sy = e.clientY; el.style.transition = 'none'; el.classList.add('held'); });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${Math.max(-18, Math.min(18, dx / 12)).toFixed(1)}deg) scale(1.1)`;
  });
  const drop = () => { if (id === null) return; id = null; el.classList.remove('held'); el.style.transition = 'transform 0.6s cubic-bezier(0.3, 1.6, 0.5, 1)'; el.style.transform = ''; };
  el.addEventListener('pointerup', drop); el.addEventListener('pointercancel', drop);
}

// nova's computer: it has already held the cheapest fare; take the mouse and a pointer follows yours
const view = $('[data-play="browse"]');
if (view) {
  const ptr = $('.ptr', view), rows = $$('.fares li', view), hold = $('u', rows[0]), take = $('[data-take]');
  const glide = 'transform 0.55s cubic-bezier(0.77, 0, 0.175, 1)';
  let held = false;
  const at = (el, dx, dy) => { const b = view.getBoundingClientRect(), r = el.getBoundingClientRect(); ptr.style.transform = `translate(${r.left - b.left + r.width / 2 - 4 + dx}px, ${r.top - b.top + r.height / 2 - 3 + dy}px)`; };
  const hot = (row) => rows.forEach((r) => r.classList.toggle('hot', r === row));
  const mark = (on) => { hold.classList.toggle('held', on); hold.textContent = on ? 'held' : 'hold'; };
  // once the fare is held the pointer parks in the open middle of the page, clear of the text
  const rest = () => { if (!held) at($('span', rows[1]), 30, 16); };
  // the pointer only shows while you hold the mouse
  rest();
  addEventListener('load', rest); addEventListener('resize', rest);
  take.addEventListener('click', () => {
    held = !held;
    take.setAttribute('aria-pressed', held); take.textContent = held ? 'give it back' : 'take the mouse';
    view.style.cursor = held ? 'none' : '';
    ptr.style.transition = held ? 'none' : glide;
    ptr.classList.toggle('on', held);
    if (!held) { hot(rows[0]); mark(true); rest(); }
  });
  view.addEventListener('pointermove', (e) => {
    if (!held) return;
    const b = view.getBoundingClientRect();
    ptr.style.transform = `translate(${e.clientX - b.left - 4}px, ${e.clientY - b.top - 3}px)`;
    hot(e.target.closest('.fares li'));
  });
}

// a routine switched off puts its bot to sleep (mascot.js does the face)
for (const t of $$('.rows .toggle')) t.addEventListener('click', () => {
  if (!document.documentElement.classList.contains('mk-ready')) t.setAttribute('aria-checked', t.getAttribute('aria-checked') !== 'true');
});

// the newest note in the notebook types itself in once, and is really yours to edit. emptied, it goes back to what it said
const note = $('[data-note]');
if (note) {
  const said = note.textContent;
  try { note.contentEditable = 'plaintext-only'; } catch { note.contentEditable = 'true'; }
  note.setAttribute('role', 'textbox'); note.setAttribute('aria-label', 'a note you can edit'); note.spellcheck = false;
  note.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); note.blur(); } });
  note.addEventListener('input', () => { $('[data-note-foot]').textContent = 'edited by you. nova will remember'; });
  note.addEventListener('blur', () => { if (!note.textContent.trim()) note.textContent = said; });
  $('[data-edit]').addEventListener('click', () => { note.focus(); getSelection().selectAllChildren(note); getSelection().collapseToEnd(); });
  if (!still) once(note, async () => {
    for (let i = 1; i <= said.length; i++) { if (document.activeElement === note) return; note.textContent = said.slice(0, i); await wait(42); }
  }, 0.9);
}

const phone = $('[data-ring]');
phone?.addEventListener('click', () => { phone.classList.remove('ringing'); void phone.offsetWidth; phone.classList.add('ringing'); });

for (const b of $$('[data-copy]')) b.addEventListener('click', async () => {
  const label = b.dataset.label ||= b.textContent;
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'copied'; }
  catch { const fig = b.closest('figure') || b.parentElement; getSelection().selectAllChildren($('code', fig) || fig); b.textContent = 'selected'; }
  setTimeout(() => { b.textContent = label; }, 1600);
});

// monthly or yearly: the white pill is a full-size layer cut down with clip-path, and the prices settle on a spring
const bill = $('[data-bill]');
if (bill) {
  const btns = $$('button', bill), ind = $('.seg-ind', bill), root = bill.closest('section');
  const place = () => {
    const b = btns.find((x) => x.getAttribute('aria-pressed') === 'true');
    ind.style.clipPath = `inset(${b.offsetTop}px ${bill.clientWidth - b.offsetLeft - b.offsetWidth}px ${bill.clientHeight - b.offsetTop - b.offsetHeight}px ${b.offsetLeft}px round 999px)`;
  };
  place(); bill.classList.add('is-on');
  if ('ResizeObserver' in window) new ResizeObserver(place).observe(bill);
  bill.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.getAttribute('aria-pressed') === 'true') return;
    btns.forEach((x) => x.setAttribute('aria-pressed', x === b)); place();
    const k = b.dataset.period;
    for (const n of $$('.amt [data-m]', root)) {
      const to = Number(n.dataset[k]);
      n.run?.stop();
      if (M && !still) n.run = M.animate(Number(n.textContent), to, { type: 'spring', duration: 0.5, bounce: 0.15, onUpdate: (v) => { n.textContent = Math.round(v); } });
      else n.textContent = to;
    }
    for (const n of $$('.per[data-m]', root)) n.textContent = n.dataset[k];
    for (const a of $$('a[href*="/signup?plan="]', root)) { const u = new URL(a.href); u.searchParams.set('period', k === 'y' ? 'year' : 'month'); a.href = u.href; }
  });
}

// the hero download is the file for this computer, a plain link that starts at once; the arrow lists every other build.
// on a phone it opens the download page, since the app runs on a computer
const dl = $('[data-dl]');
if (dl) {
  const more = $('.split-more', dl), menu = $('.dl-menu', dl), main = $('.split-main', dl);
  // site.js (loaded after this file) finds the build
  addEventListener('DOMContentLoaded', async () => {
    const key = await window.madaniBuild?.();
    if (key === 'phone') { main.href = '/download'; main.removeAttribute('download'); return; }
    const item = key && $(`[data-key="${key}"]`, menu);
    if (!item) return;
    main.href = item.href;
    $('.dl-os', dl).replaceChildren($('.os', item).cloneNode(true));
  });
  const open = (on) => { menu.hidden = !on; more.setAttribute('aria-expanded', on); };
  more.addEventListener('click', () => open(menu.hidden));
  document.addEventListener('click', (e) => { if (!dl.contains(e.target)) open(false); });
  dl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { open(false); more.focus(); } });
}

// a dashed arrow swoops from the pointer into the closing download button whenever you are near it. every point is on a
// spring, so the curve follows the pointer with a little lag and settles instead of snapping
const cta = $('.end .btn.dark');
if (cta && fine && !still) {
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), line = document.createElementNS(NS, 'path'), head = document.createElementNS(NS, 'path');
  svg.setAttribute('class', 'aim'); svg.setAttribute('aria-hidden', 'true'); line.setAttribute('class', 'aim-line'); head.setAttribute('class', 'aim-head');
  svg.append(line, head); document.body.append(svg);
  const REACH = 760, K = 0.14, DAMP = 0.7;
  const spring = () => ({ x: 0, y: 0, vx: 0, vy: 0 });
  const pts = { s: spring(), a: spring(), b: spring(), e: spring() };
  let mx = -1, my = -1, show = 0, frame = 0, fresh = true;
  const pull = (p, x, y) => {
    if (fresh) { p.x = x; p.y = y; p.vx = p.vy = 0; return; }
    p.vx = (p.vx + (x - p.x) * K) * DAMP; p.vy = (p.vy + (y - p.y) * K) * DAMP; p.x += p.vx; p.y += p.vy;
  };
  const f = (n) => n.toFixed(1);
  const tick = () => {
    frame = 0;
    const r = cta.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const inside = mx >= r.left - 8 && mx <= r.right + 8 && my >= r.top - 8 && my <= r.bottom + 8;
    const d = Math.hypot(mx - cx, my - cy);
    // it fades in as you come within reach, and out again over the last stretch, so the button itself takes over
    const edge = Math.hypot(Math.max(r.left - mx, 0, mx - r.right), Math.max(r.top - my, 0, my - r.bottom));
    const want = mx < 0 || inside || r.bottom < 0 || r.top > innerHeight ? 0 : Math.max(0, Math.min(1, (REACH - d) / 220, (edge - 40) / 160));
    // land on the side of the button that faces you, heading straight into it
    // the other button sits to its right, so from that side the arrow comes in over the top or from below instead
    const side = mx < cx && cx - mx - r.width / 2 > Math.abs(my - cy) * 0.8;
    const dir = side ? [mx < cx ? 1 : -1, 0] : [0, my < cy ? 1 : -1];
    const ex = side ? (mx < cx ? r.left - 12 : r.right + 12) : Math.min(Math.max(mx, r.left + 24), r.right - 24);
    const ey = side ? cy : (my < cy ? r.top - 10 : r.bottom + 10);
    const span = Math.hypot(ex - mx, ey - my), reachIn = Math.min(Math.max(span * 0.42, 36), 240);
    // the first handle leaves the pointer sideways toward the button and dips a little, like a thrown line
    const ax = mx + (ex - mx) * 0.42, ay = my + Math.min(span * 0.28, 140) * (ey >= my ? 0.4 : 1);
    const bx = ex - dir[0] * reachIn, by = ey - dir[1] * reachIn;
    const lx = ax - mx, ly = ay - my, ll = Math.hypot(lx, ly) || 1;
    pull(pts.s, mx + (lx / ll) * 16, my + (ly / ll) * 16); pull(pts.a, ax, ay); pull(pts.b, bx, by); pull(pts.e, ex, ey);
    fresh = false;
    show += (want - show) * 0.16;
    const { s: S, a: A, b: B, e: E } = pts;
    line.setAttribute('d', `M${f(S.x)} ${f(S.y)}C${f(A.x)} ${f(A.y)} ${f(B.x)} ${f(B.y)} ${f(E.x)} ${f(E.y)}`);
    const tx = E.x - B.x, ty = E.y - B.y, tl = Math.hypot(tx, ty) || 1, ux = tx / tl, uy = ty / tl, w = 0.52, h = 12;
    const wing = (sg) => [E.x - h * (ux * Math.cos(w) + sg * uy * Math.sin(w)), E.y - h * (uy * Math.cos(w) - sg * ux * Math.sin(w))];
    const [p1, p2] = [wing(1), wing(-1)];
    head.setAttribute('d', `M${f(p1[0])} ${f(p1[1])}L${f(E.x)} ${f(E.y)}L${f(p2[0])} ${f(p2[1])}`);
    svg.style.opacity = show.toFixed(3);
    const moving = Math.abs(S.vx) + Math.abs(S.vy) + Math.abs(E.vx) + Math.abs(E.vy) > 0.05;
    if (show > 0.01 || want > 0 || moving) frame = requestAnimationFrame(tick);
    else fresh = true;
  };
  const go = () => { frame ||= requestAnimationFrame(tick); };
  addEventListener('pointermove', (e) => { mx = e.clientX; my = e.clientY; go(); }, { passive: true });
  addEventListener('scroll', go, { passive: true });
  document.addEventListener('pointerleave', () => { mx = -1; go(); });
}

// only when someone switches to another tab or app while the page stays open: never on a link, a download, a redirect
// or leaving, so a click-out in the last 1.5 s or a pagehide keeps the real title
const title = document.title;
const MISS = [
  'the bots miss you', 'kitten is crying rn', 'ur bots are gossiping', 'come back bestie', 'pls 🥺 come back',
  'kitten is not ok', 'u left them on read', 'who said u could leave', 'kitten put on a sad song',
  'kitten is writing a breakup text', 'they rearranged the furniture', 'the bots ate ur snacks',
  'not u ghosting the bots', 'u had one job. stay.', 'kitten is pretending to be fine',
  'kitten is at the window 🪟', 'u forgot us already? 💔', 'the bots threw a party without u 🎉',
  'kitten knocked ur cup over ☕', 'kitten is sitting on ur keyboard ⌨️', 'brb crying 😿',
  'come back, it is snack time 🍿', 'kitten is loafing in protest 🍞', 'the bots are doing ur work rn 💼',
  'one more tab? really? 👀', 'kitten left u a voice note 🎙️', 'the bots lit a candle for u 🕯️',
];
let away = 0, gone = false, last = -1;
const leaving = () => { away = Date.now(); };
document.addEventListener('click', (e) => { if (e.target.closest?.('a[href], [download]')) leaving(); }, true);
addEventListener('beforeunload', leaving);
addEventListener('pagehide', () => { gone = true; document.title = title; });
addEventListener('pageshow', () => { gone = false; document.title = title; });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { document.title = title; return; }
  if (gone || Date.now() - away < 1500) return;
  let n = Math.floor(Math.random() * MISS.length);
  if (n === last) n = (n + 1) % MISS.length;
  document.title = MISS[last = n];
});

// the footer knows what time it is
const madani = $('[data-madani]'), hour = new Date().getHours();
if (madani && hour >= 17 && hour < 20) madani.textContent = "it's madani where you are. the bots are just getting started.";
else if (madani && hour < 5) madani.textContent = "it's late. the bots are still up, you don't have to be.";

// every screen: the screens come on one after another the first time the scene is seen; poke juno on any of them and
// she reacts on all three, because it is the same bot
const ev = document.querySelector('[data-ev]');
if (ev && !still) {
  ev.addEventListener('click', (e) => {
    if (!e.target.closest('.ev-scr') || !window.madaniBots) return;
    ev.querySelectorAll('.ev-j').forEach((b, i) => setTimeout(() => window.madaniBots.react(b, 'hop'), i * 60));
  });
}
