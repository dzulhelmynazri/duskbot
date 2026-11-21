// the site's bots: pixel/ draws and moves them; this file finds them in the page and tells them what is going on
// around them. the build already drew each one at rest, so this only takes over
import { MadaniPixel } from './pixel/crowd.js';

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const later = (ms, fn) => setTimeout(fn, ms);
const between = (min, max) => min + Math.random() * (max - min);

// the names the pages use, on what the pixel engine knows
const MOODS = { finished: 'done', curious: 'listening', celebrate: 'excited', busy: 'working', asleep: 'sleeping' };
const MOVES = { tap: 'poke', greet: 'boing', open: 'nod', wiggle: 'wobble', perk: 'hop', celebrate: 'boing', bounce: 'boing' };

const bots = new Map();
$$('svg.bot[data-px], .sea-bots .sb[data-px]').forEach((el, i) => {
  bots.set(el, { el, sea: el.classList.contains('sb'), bot: MadaniPixel.create(el, { body: el.dataset.px, seed: i * 7 + 3, tap: false }) });
});

const botOf = (el) => bots.get(el) || (el?.closest && bots.get(el.closest('svg.bot, .sb'))) || null;
const botsIn = (el) => (el ? [...bots.values()].filter((rec) => el.contains(rec.el)) : []);
const react = (rec, kind) => rec?.bot.react(MOVES[kind] || kind);
const setState = (rec, state) => rec?.bot.setState(MOODS[state] || state);

// a click on a bot is a poke: a bouncy answer, and five quick ones make it dizzy
document.addEventListener('click', (e) => {
  const rec = botOf(e.target) || botOf(e.target.closest?.('[data-own]')?.querySelector('svg.bot'));
  if (rec) rec.bot.poke(e);
});

// for the rest of the page: madaniBots.react(el, 'hop'), madaniBots.state(el, 'working'); el is a bot or anything around bots
window.madaniBots = {
  react: (el, kind) => (botOf(el) ? [botOf(el)] : botsIn(el)).forEach((rec) => react(rec, kind)),
  state: (el, state) => (botOf(el) ? [botOf(el)] : botsIn(el)).forEach((rec) => setState(rec, state)),
};

// runs fn each time el comes on screen or leaves it
function watch(el, fn, threshold = 0) {
  if (!el || !('IntersectionObserver' in window)) return;
  new IntersectionObserver((es) => fn(es[es.length - 1].isIntersecting), { threshold }).observe(el);
}
const hover = (el, fn) => fine && el?.addEventListener('pointerenter', fn);

// kit in the headline: says hi once it is seen, and wobbles when the pointer comes onto the headline
const hero = botOf($('.h-mark'));
if (hero) {
  let greeted = false, wiggled = 0;
  watch(hero.el, (on) => { if (on && !greeted) { greeted = true; later(900, () => react(hero, 'greet')); } }, 0.6);
  hover(hero.el.closest('h1'), () => {
    if (performance.now() - wiggled < 2600) return;
    wiggled = performance.now();
    react(hero, 'wiggle');
  });
}

// a row of the team, or of the where cards: pointing at it gets a small answer from its bot
for (const li of $$('.team-rows li, .wa-row')) hover(li, () => { for (const rec of botsIn(li)) react(rec, 'open'); });

// nova's computer: it works while its pointer reads the fares, and is pleased once it holds the cheapest
const browse = $('[data-play="browse"]');
const held = browse && $('.fares u', browse);
if (held) {
  const nova = botOf($('.fig-head svg.bot', browse.closest('figure') || browse.parentElement));
  let done = 0;
  new MutationObserver(() => {
    clearTimeout(done);
    if (!held.classList.contains('held')) return setState(nova, 'working');
    if (nova?.bot.state !== 'working') return;
    setState(nova, 'finished');
    done = later(5200, () => setState(nova, 'idle'));
  }).observe(held, { attributes: true, attributeFilter: ['class'] });
}

// routines: switched off, its bot goes to sleep; switched back on, it wakes, is happy for a moment, then idles
for (const toggle of $$('.rows .toggle')) {
  const rec = botOf($('svg.bot', toggle.closest('li')));
  if (!rec) continue;
  let back = 0;
  const sync = (first) => {
    clearTimeout(back);
    if (toggle.getAttribute('aria-checked') === 'false') return setState(rec, 'sleeping');
    if (first) return;
    rec.bot.o.after = 'happy';
    setState(rec, 'waking');
    back = later(3700, () => setState(rec, 'idle'));
  };
  sync(true);
  new MutationObserver(() => sync(false)).observe(toggle, { attributes: true, attributeFilter: ['aria-checked'] });
}

// nova's notes: it nods along while you edit the note it keeps
const note = $('[data-note]');
if (note) {
  const rec = botOf($('.fig-head svg.bot', note.closest('figure') || document));
  let nodded = 0;
  note.addEventListener('input', () => {
    if (performance.now() - nodded < 1500) return;
    nodded = performance.now();
    react(rec, 'nod');
  });
}

// the room: once it is read, each bot answers being tagged, in the order of the messages; pointing at a tag again
// gets the same answer from that bot
const room = $('.chan');
if (room) {
  const all = (colour, kind) => $$(`svg.bot.c-${colour}`, room).map(botOf).forEach((rec) => react(rec, kind));
  let read = false;
  watch(room, (on) => {
    if (!on || read) return;
    read = true;
    later(300, () => all('tangerine', 'nod'));
    later(1100, () => all('sun', 'hop'));
    later(2100, () => all('pink', 'greet'));
  }, 0.6);
  for (const at of $$('.at.yellow, .at.pink', room)) hover(at, () => all(at.classList.contains('yellow') ? 'sun' : 'pink', 'hop'));
}

// the terraces: each bot works on its task, finishes it (a hop, happy eyes), rests a little, then takes the next one,
// on its own clock. only while the strip is on screen
const terraces = $$('.terr .tb svg.bot').map(botOf).filter(Boolean);
if (terraces.length && !still) {
  let on = false;
  const shift = (rec, wait) => {
    clearTimeout(rec.shift);
    rec.shift = later(wait, () => {
      if (!on) return;
      setState(rec, 'working');
      rec.shift = later(between(6500, 11000), () => {
        if (!on) return;
        setState(rec, 'finished');
        rec.shift = later(between(4200, 6500), () => {
          if (!on) return;
          setState(rec, 'idle');
          shift(rec, between(2500, 6000));
        });
      });
    });
  };
  watch($('.terr'), (now) => {
    if (now === on) return;
    on = now;
    terraces.forEach((rec, i) => {
      if (on) shift(rec, 400 + i * 650);
      else { clearTimeout(rec.shift); setState(rec, 'idle'); }
    });
  });
}

// the four steps: pointing at one makes its terrace bot hop, and the bots in the create-a-bot card hop in a row
for (const li of $$('.steps > li')) hover(li, () => {
  react(botOf($(`.terr .t${li.dataset.step} svg.bot`)), 'hop');
  botsIn($('.shapes', li)).forEach((rec, i) => later(i * 70, () => react(rec, 'hop')));
});

// the bot beside the questions: it listens when one opens, then nods
const listener = botOf($('.listener svg.bot'));
if (listener) {
  let nod = 0;
  for (const d of $$('.qs details')) d.addEventListener('toggle', () => {
    if (!d.open) return;
    clearTimeout(nod);
    setState(listener, 'curious');
    nod = later(2400, () => { setState(listener, 'idle'); react(listener, 'nod'); });
  });
}

// the sea in the last picture: the swimmers come up one by one the first time it is seen, and when the pointer gets
// close one ducks under, coming back up a moment later. their eyes follow a near pointer on their own
const end = $('.end'), water = $('.sea-bots');
if (end && water && 'IntersectionObserver' in window && !still) {
  const box = water.viewBox.baseVal;
  const crew = [...bots.values()].filter((rec) => rec.sea).map((rec) => {
    const m = rec.el.transform.baseVal.consolidate().matrix;
    return { el: rec.el, bot: rec.bot, x: m.e + 50 * m.a, y: m.f + 45 * m.a, size: 100 * m.a, under: false, timer: 0 };
  });
  let live = false, shown = false, bobbing = 0, pending = false, point = null;
  const up = (b) => { b.under = false; b.el.classList.remove('dive'); };
  const dive = (b, ms) => {
    b.under = true;
    b.el.classList.add('dive');
    clearTimeout(b.timer);
    b.timer = later(ms, () => up(b));
  };
  const surface = () => {
    shown = true;
    [...crew].sort(() => Math.random() - 0.5).forEach((b, i) => later(250 + i * 140, () => {
      b.el.classList.add('up');
      if (Math.random() < 0.5) b.bot.react('hop');
    }));
  };
  end.classList.add('arm');
  watch(end, (on) => {
    live = on;
    end.classList.toggle('off', !on);
    clearInterval(bobbing);
    if (!on) return;
    if (!shown) surface();
    bobbing = setInterval(() => {
      const free = crew.filter((b) => !b.under);
      if (free.length) dive(free[Math.floor(Math.random() * free.length)], 520);
    }, 2600);
  });
  const near = () => {
    pending = false;
    if (!live || !point) return;
    const r = water.getBoundingClientRect(), k = r.width / box.width;
    for (const b of crew) {
      if (b.under || Math.hypot(point.x - (r.left + b.x * k), point.y - (r.top + b.y * k)) > 22 + b.size * k) continue;
      dive(b, between(900, 1700));
    }
  };
  if (fine) addEventListener('pointermove', (e) => {
    point = { x: e.clientX, y: e.clientY };
    if (!pending) { pending = true; requestAnimationFrame(near); }
  }, { passive: true });
}
