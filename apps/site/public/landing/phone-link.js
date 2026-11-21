// /m/pair and /m/signin: the desktop's qr, opened on a phone without the app. what it carries rides after the #, which
// no server sees; this page reads it, shows the code or the email, and takes it out of the address bar. nothing is sent
(() => {
  const page = document.querySelector('[data-pl]');
  if (!page) return;
  const kind = page.dataset.pl;
  const fragment = location.hash.slice(1);
  const params = new URLSearchParams(fragment);
  if (fragment) history.replaceState(null, '', location.pathname);
  const has = page.querySelector('[data-pl-has]'), value = page.querySelector('[data-pl-value]'), open = page.querySelector('[data-pl-open]');
  if (kind === 'signin') {
    const email = (params.get('email') || '').trim();
    const ok = email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email);
    if (ok) { value.textContent = email; has.hidden = false; }
    open.href = ok ? `madanibot://signin?email=${encodeURIComponent(email)}` : 'madanibot://signin';
    return;
  }
  const code = (params.get('c') || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  let ends = 0;
  try {
    const m = params.get('m') || '';
    ends = JSON.parse(atob(m.replace(/-/g, '+').replace(/_/g, '/'))).grant.expiresAt || 0;
  } catch {}
  const live = code.length === 12 && (!ends || ends > Date.now());
  if (!live) { page.querySelector('[data-pl-none]').hidden = false; return; }
  value.textContent = code.match(/.{1,4}/g).join(' ');
  has.hidden = false;
  const when = page.querySelector('[data-pl-when]');
  const tick = () => {
    const left = Math.ceil((ends - Date.now()) / 60000);
    if (ends && left <= 0) { has.hidden = true; open.hidden = true; page.querySelector('[data-pl-none]').hidden = false; return; }
    when.textContent = ends ? `works for ${left} more min` : '';
    setTimeout(tick, 15000);
  };
  tick();
  if (params.get('m')) { open.href = `madanibot://pair?m=${params.get('m')}`; open.hidden = false; }
  const copy = page.querySelector('[data-pl-copy]');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = 'copied'; } catch { copy.textContent = 'press and hold the code to copy it'; }
  });
})();
