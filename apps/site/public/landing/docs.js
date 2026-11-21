// the docs: search over a small prebuilt index (docs/search.json), "/" to jump to it, and the list of this page's
// sections following along as you read
{
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const where = $('[data-index]');
let index = null, loading = null;
const load = () => (loading ||= fetch(where.dataset.index).then((r) => r.json()).then((d) => { index = d.map((e) => ({ ...e, lt: e.t.toLowerCase(), lh: e.h.toLowerCase(), lx: e.x.toLowerCase() })); }).catch(() => { loading = null; }));

// every word of the question must be the start of a word somewhere in the entry; titles and headings count for more
function find(q) {
  const words = q.toLowerCase().split(/[^a-z0-9$]+/).filter(Boolean);
  if (!words.length || !index) return [];
  const starts = (text, w) => { let i = text.indexOf(w); while (i > 0 && /[a-z0-9]/.test(text[i - 1])) i = text.indexOf(w, i + 1); return i; };
  const out = [];
  for (const e of index) {
    let score = 0, ok = true;
    for (const w of words) {
      const t = starts(e.lt, w) >= 0, h = starts(e.lh, w) >= 0, x = starts(e.lx, w) >= 0;
      if (!t && !h && !x) { ok = false; break; }
      score += (t ? 5 : 0) + (h ? 8 : 0) + (x ? 2 : 0);
    }
    if (ok) out.push({ e, score: score + (e.h ? 0 : 3) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8).map((r) => r.e);
}
const marked = (text, words) => { let s = esc(text); for (const w of words) s = s.replace(new RegExp(`(^|[^a-z0-9])(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '$1<mark>$2</mark>'); return s; };
function snippet(e, words) {
  const at = Math.max(0, ...words.map((w) => e.lx.indexOf(w)).filter((i) => i >= 0).slice(0, 1));
  const from = at > 60 ? e.x.lastIndexOf(' ', at - 40) + 1 : 0;
  return (from ? '…' : '') + e.x.slice(from, from + 150);
}

for (const box of $$('[data-search]')) {
  const input = $('input', box), hits = $('.hits', box);
  let picked = -1;
  const links = () => $$('a', hits);
  const pick = (i) => {
    const all = links(); picked = all.length ? (i + all.length) % all.length : -1;
    all.forEach((a, n) => a.setAttribute('aria-selected', n === picked));
    if (picked >= 0) { input.setAttribute('aria-activedescendant', all[picked].id); all[picked].scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };
  const show = (on) => { hits.hidden = !on; input.setAttribute('aria-expanded', on); if (!on) pick(-1); };
  const run = async () => {
    const q = input.value.trim();
    if (!q) return show(false);
    await load();
    if (input.value.trim() !== q) return;
    const words = q.toLowerCase().split(/[^a-z0-9$]+/).filter(Boolean), found = find(q);
    hits.innerHTML = found.length
      ? found.map((e, n) => `<a id="${input.id}-hit-${n}" role="option" aria-selected="false" href="${e.u}"><b>${marked(e.h || e.t, words)}${e.h ? `<small>${esc(e.t)}</small>` : ''}</b><span>${marked(snippet(e, words), words)}</span></a>`).join('')
      : `<p class="none">nothing for “${esc(q)}”. try fewer words, or ask <a href="mailto:hello@madani.bot">hello@madani.bot</a>.</p>`;
    show(true); pick(found.length ? 0 : -1);
  };
  input.addEventListener('focus', () => { load(); if (input.value.trim()) run(); });
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (hits.hidden) run(); else pick(picked + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pick(picked - 1); }
    else if (e.key === 'Enter') { const a = links()[picked]; if (a) { e.preventDefault(); location.href = a.href; show(false); } }
    else if (e.key === 'Escape') { if (!hits.hidden) { e.stopPropagation(); show(false); } else input.blur(); }
  });
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) show(false); });
  hits.addEventListener('click', (e) => { if (e.target.closest('a[role="option"]')) show(false); });
}

// "/" goes to the search field, unless you are typing somewhere
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const input = $$('[data-search] input').find((i) => i.offsetParent);
  if (input) { e.preventDefault(); input.focus(); input.select(); }
});

// on this page: the section being read is marked
const toc = $$('.doc-toc a');
if (toc.length && 'IntersectionObserver' in window) {
  const heads = toc.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  const mark = () => {
    const y = scrollY + 120;
    let now = heads[0];
    for (const h of heads) if (h.getBoundingClientRect().top + scrollY <= y) now = h;
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) now = heads[heads.length - 1];
    toc.forEach((a) => a.classList.toggle('on', a.hash === `#${now.id}`));
  };
  const io = new IntersectionObserver(mark, { rootMargin: '-12% 0px -70% 0px' });
  heads.forEach((h) => io.observe(h));
  mark();
}

// the sidebar opens with the page you are on in view
const here = $('.docs-side .docs-nav a[aria-current="page"]'), list = here?.closest('.docs-nav');
if (list) { const down = here.getBoundingClientRect().top - list.getBoundingClientRect().top; if (down > list.clientHeight - 70) list.scrollTop = down - list.clientHeight / 2; }

// the phone's page list closes once a page is chosen
const jump = $('.docs-jump');
jump?.addEventListener('click', (e) => { if (e.target.closest('a')) jump.open = false; });
}
