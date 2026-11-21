// tells indexnow (bing, yandex and the other engines that share it; google does not use it) about pages that are new,
// changed or gone since the last ping. it reads what the build wrote: the sitemaps (with each page's lastmod), _gone.json
// and _redirects.json, and keeps what it already sent in seo/indexnow-sent.json, so an unchanged page is never sent
// twice. the key is seo/indexnow-key.txt, which the build hosts at /<key>.txt.
//   node seo/jobs/indexnow.mjs            show what would be sent (the default)
//   node seo/jobs/indexnow.mjs --send     check the key file is live on the site, then send and remember
// run it after a deploy, never before: the engines fetch the key file and the pages right away.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seoDir } from '../records.mjs';

const site = path.join(seoDir, '..', 'public', 'landing');
const sentFile = path.join(seoDir, 'indexnow-sent.json');
export const ENDPOINT = 'https://api.indexnow.org/indexnow';

// every page in the sitemaps with its lastmod, from the built files
export function listed(root = site) {
  const out = {};
  const index = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  for (const [, loc] of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const file = path.join(root, new URL(loc).pathname);
    for (const [, url, lastmod] of fs.readFileSync(file, 'utf8').matchAll(/<loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/g)) out[url] = lastmod;
  }
  return out;
}

// what changed since the last ping: new or newer pages, and pages that are gone or moved
export function changes(now, sent, gone) {
  const urls = Object.entries(now).filter(([u, m]) => sent[u] !== m).map(([u]) => u);
  const removed = gone.filter((u) => sent[u] && sent[u] !== 'gone');
  return { urls: [...urls, ...removed], next: { ...sent, ...now, ...Object.fromEntries(removed.map((u) => [u, 'gone'])) } };
}

export async function run({ send = false, siteUrl = (process.env.SITE_URL || 'https://madani.bot').replace(/\/+$/, ''), log = console.log, fetchImpl = fetch } = {}) {
  const key = fs.readFileSync(path.join(seoDir, 'indexnow-key.txt'), 'utf8').trim();
  const sent = fs.existsSync(sentFile) ? JSON.parse(fs.readFileSync(sentFile, 'utf8')) : {};
  const goneList = [...JSON.parse(fs.readFileSync(path.join(site, '_gone.json'), 'utf8')), ...Object.keys(JSON.parse(fs.readFileSync(path.join(site, '_redirects.json'), 'utf8')))]
    .map((p) => siteUrl + p).filter((u) => sent[u]);
  const { urls, next } = changes(listed(), sent, goneList);
  if (!urls.length) return log('indexnow: nothing new or changed'), { sent: 0 };
  log(`indexnow: ${urls.length} ${send ? 'to send' : 'would be sent (add --send)'}:\n  ${urls.join('\n  ')}`);
  if (!send) return { sent: 0, urls };
  const keyLocation = `${siteUrl}/${key}.txt`;
  const live = await fetchImpl(keyLocation).then((r) => r.ok && r.text()).catch(() => null);
  if (!live || live.trim() !== key) throw new Error(`the key file is not live at ${keyLocation}; deploy the build first`);
  for (let i = 0; i < urls.length; i += 10000) {
    const res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host: new URL(siteUrl).host, key, keyLocation, urlList: urls.slice(i, i + 10000) }) });
    // 200 received, 202 received while the key is checked; 422 is a url not on this host; 429 is too often
    if (res.status !== 200 && res.status !== 202) throw new Error(`indexnow answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    log(`indexnow: answered ${res.status}`);
  }
  fs.writeFileSync(sentFile, JSON.stringify(next, null, 1) + '\n');
  return { sent: urls.length, urls };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run({ send: process.argv.includes('--send') });
