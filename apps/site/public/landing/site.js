// on every page: the phone menu shuts on escape, on a tap outside it, and when the window grows past phone size
{
document.documentElement.classList.add('js');
const menu = document.querySelector('.menu');
if (menu) {
  const shut = () => { menu.open = false; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { shut(); menu.querySelector('summary').focus(); } });
  // pointerdown, not click: touch browsers send no click for a tap on plain text or empty page
  document.addEventListener('pointerdown', (e) => { if (menu.open && !menu.contains(e.target)) shut(); });
  matchMedia('(min-width: 641px)').addEventListener('change', shut);
  // one tint in the menu: it slides to the link under the mouse, a finger or keyboard focus, and rests on this page's link
  const nav = menu.querySelector('nav');
  const pill = Object.assign(document.createElement('span'), { className: 'menu-pill' });
  pill.setAttribute('aria-hidden', 'true');
  nav.prepend(pill);
  const here = () => nav.querySelector('a[aria-current="page"]:not(.cta), a.is-here');
  const linkAt = (e) => { const a = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('a'); return a && nav.contains(a) && !a.classList.contains('cta') ? a : null; };
  const to = (a, focus = false) => {
    pill.classList.toggle('focus', focus);
    if (!a) { pill.classList.remove('on'); return; }
    // from nothing it appears in place; from another link it slides
    const jump = !pill.classList.contains('on');
    if (jump) pill.style.transition = 'none';
    pill.style.height = `${a.offsetHeight}px`;
    pill.style.transform = `translateY(${a.offsetTop}px)`;
    if (jump) { void pill.offsetWidth; pill.style.transition = ''; }
    pill.classList.add('on');
  };
  menu.addEventListener('toggle', () => { pill.classList.remove('on'); if (menu.open) to(here()); });
  nav.addEventListener('pointerdown', (e) => { const a = linkAt(e); if (a) to(a); });
  nav.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse' && !e.buttons) return; const a = linkAt(e); if (a) to(a); });
  // a lifted finger also leaves, so only the mouse sends the tint home on leave
  nav.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'mouse') return; const f = nav.querySelector('a:focus-visible:not(.cta)'); to(f || here(), Boolean(f)); });
  nav.addEventListener('pointercancel', () => to(here()));
  nav.addEventListener('focusin', (e) => { if (e.target.matches(':focus-visible:not(.cta)')) to(e.target, true); });
  nav.addEventListener('focusout', (e) => { if (!nav.contains(e.relatedTarget)) to(here()); });
  addEventListener('pageshow', (e) => { if (e.persisted && menu.open) to(here()); });
}
// ios only shows :active (the faq press) once a page listens for touches
document.addEventListener('touchstart', () => {}, { passive: true });
// a page you point at (or press on a phone) starts loading before the click lands, so the next page is already here.
// where the browser can, it is prerendered whole, images and fonts too, so the change is instant and nothing pops in late
const prerender = HTMLScriptElement.supports?.('speculationrules');
if (prerender) {
  const skip = ['/dashboard/*', '/app/*', '/v1/*', '/api/*', '/explore/*', '/*.*'].map((p) => ({ not: { href_matches: p } }));
  const where = { and: [{ href_matches: '/*' }, ...skip, { not: { selector_matches: '[download], [target], [rel~="nofollow"]' } }] };
  document.head.append(Object.assign(document.createElement('script'), { type: 'speculationrules', textContent: JSON.stringify({ prefetch: [{ where, eagerness: 'moderate' }], prerender: [{ where, eagerness: 'moderate' }] }) }));
}
const fetched = new Set([location.pathname]);
const warm = (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || a.origin !== location.origin || a.target || a.hasAttribute('download') || fetched.has(a.pathname) || /\.[a-z0-9]{1,5}$/i.test(a.pathname)) return;
  fetched.add(a.pathname);
  document.head.append(Object.assign(document.createElement('link'), { rel: 'prefetch', href: a.pathname + a.search }));
};
if (!prerender) {
  document.addEventListener('pointerover', warm, { passive: true });
  document.addEventListener('touchstart', warm, { passive: true });
}
// a double or triple click on a bot would select the paragraph around it; a single press still starts a drag selection
document.addEventListener('mousedown', (e) => { if (e.detail > 1 && e.target.closest?.('svg.bot, .sb[data-px], .cat img')) e.preventDefault(); });
}
// which desktop build fits this computer: mac-arm64, mac-x64, windows or linux-deb, or phone. chromium names the mac's
// chip; other browsers only through the gpu's name, and with neither it guesses apple silicon, what most macs are now.
// pages call it once on load, so the download links are already right when you click
window.madaniBuild = async () => {
  const ua = navigator.userAgent;
  if (/android|iphone|ipad/i.test(ua) || (/mac/i.test(ua) && navigator.maxTouchPoints > 1)) return 'phone';
  if (/windows/i.test(ua)) return 'windows';
  if (/linux|cros/i.test(ua)) return 'linux-deb';
  try {
    const arch = (await navigator.userAgentData?.getHighEntropyValues?.(['architecture']))?.architecture;
    if (arch) return arch === 'arm' ? 'mac-arm64' : 'mac-x64';
  } catch {}
  try {
    const gl = document.createElement('canvas').getContext('webgl'), info = gl?.getExtension('WEBGL_debug_renderer_info');
    if (/intel|amd|radeon|nvidia/i.test(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '')) return 'mac-x64';
  } catch {}
  return 'mac-arm64';
};

// plus and pro start free while the account service runs a trial (MADANI_TRIAL_DAYS); without one the cards stay as built
{
  const buys = [...document.querySelectorAll('.plan a[href*="/signup?plan="]')];
  if (buys.length) fetch('/api/public/config').then((r) => (r.ok ? r.json() : null)).then((config) => {
    const days = config?.plans?.find((plan) => plan.trialDays)?.trialDays;
    if (!Number.isInteger(days) || days < 1) return;
    for (const a of buys) {
      a.textContent = 'start free trial';
      const price = a.closest('.plan')?.querySelector('.plan-price');
      if (price && !price.querySelector('.per-trial')) price.prepend(Object.assign(document.createElement('span'), { className: 'per per-trial', textContent: `${days} ${days === 1 ? 'day' : 'days'} free, then` }));
    }
  }).catch(() => {});
}
