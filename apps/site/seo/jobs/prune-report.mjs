// the prune report: which live seo pages are not earning their place, by the rules in seo/growth.json "prune"
// (playbook 3.5): at day 60 not indexed or unseen, refresh it once; at day 120 still so, merge it into a page that covers
// the topic or take it down; indexed but no impressions for 180 days, decide. it only writes a report
// (seo/reports/prune-<day>.md); a person decides, then sets the page's status in seo/release.json to "noindex" or
// "pruned" (with "to": "/other-page" to send people on; without, the server answers 410) and rebuilds.
//   node seo/jobs/prune-report.mjs --snapshot=seo/reports/gsc-2026-12-20.json   (or with search console connected)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, seoDir } from '../records.mjs';
import { localDay } from '../quality.mjs';
import { gscConfigured } from './gsc.mjs';

const age = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

export function decide(pages, snapshot, rules, today, siteUrl) {
  const out = [];
  for (const r of pages) {
    const d = r.state.live_at ? age(r.state.live_at, today) : 0, s = snapshot.pages[siteUrl + r.path];
    if (!s || d < rules.refresh_day) continue;
    const weak = !s.indexed || !s.impressions;
    if (s.indexed && !s.impressions && d >= rules.idle_indexed_days) out.push({ path: r.path, days: d, action: 'decide', why: `indexed, no impressions in ${d} days: keep only if it helps people who reach it from other pages, else merge or take down` });
    else if (weak && d >= rules.decide_day) out.push({ path: r.path, days: d, action: r.refreshed ? 'merge or take down' : 'refresh, last chance', why: `${s.indexed ? 'no impressions' : `not indexed (${s.coverage || 'unknown'})`} after ${d} days` });
    else if (weak) out.push({ path: r.path, days: d, action: r.refreshed ? 'wait' : 'refresh', why: `${s.indexed ? 'no impressions' : `not indexed (${s.coverage || 'unknown'})`} after ${d} days: add something only this page has, and links in from 3 related pages` });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const today = localDay(), siteUrl = (process.env.SITE_URL || 'https://madani.bot').replace(/\/+$/, '');
  const file = process.argv.find((a) => a.startsWith('--snapshot='))?.split('=')[1];
  if (!file && !gscConfigured()) { console.log('no data: connect search console (MADANI_GSC_CREDENTIALS, MADANI_GSC_SITE) and run seo/jobs/release.mjs first, or pass --snapshot=seo/reports/gsc-<day>.json'); process.exit(0); }
  const snap = JSON.parse(fs.readFileSync(file || fs.readdirSync(path.join(seoDir, 'reports')).filter((f) => f.startsWith('gsc-')).sort().map((f) => path.join(seoDir, 'reports', f)).at(-1), 'utf8'));
  const { records } = plan({ preview: false });
  const rules = JSON.parse(fs.readFileSync(path.join(seoDir, 'growth.json'), 'utf8')).prune;
  const rows = decide(records.filter((r) => r.indexable), snap, rules, today, siteUrl);
  const md = `# prune report, ${today}\n\nfrom search console data taken ${snap.taken}. nothing here is applied; a person decides (seo/jobs/prune-report.mjs says how).\n\n${rows.length ? `| page | days live | do | why |\n| --- | --- | --- | --- |\n${rows.map((r) => `| ${r.path} | ${r.days} | ${r.action} | ${r.why} |`).join('\n')}` : 'every live page is indexed and seen, or too young to judge.'}\n`;
  fs.mkdirSync(path.join(seoDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(seoDir, 'reports', `prune-${today}.md`), md);
  console.log(md);
}
