// the release gate: decides each day whether the next cohort of seo pages may go live, and if so marks today's slice
// live in seo/release.json. it never releases on calendar time alone: the cohort before must be indexed and seen, per
// seo/growth.json (thresholds from omb-ref/seo-research/02-programmatic-playbook.md 3.3 and 3.4).
//   node seo/jobs/release.mjs                      look and explain, change nothing (the default)
//   node seo/jobs/release.mjs --apply              also write seo/release.json when the gate is green
//   node seo/jobs/release.mjs --snapshot=f.json    use a saved search console snapshot instead of asking google
//   node seo/jobs/release.mjs --today=2026-12-20   pretend it is another day (for trying the gate)
// with no search console connected (MADANI_GSC_CREDENTIALS, MADANI_GSC_SITE) and no snapshot, the gate holds: nothing after
// the seed cohort goes out until there is real indexing data. seo/jobs/daily.sh runs this, then the build, then indexnow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, seoDir, saveRelease } from '../records.mjs';
import { localDay } from '../quality.mjs';
import { gscConfigured, gscClient, pace, GSC_ENV } from './gsc.mjs';

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// green, amber or red for one cohort, from its pages' indexing and impressions. pure, so the tests can feed it numbers
export function evaluateGate({ cohort, pages, snapshot, growth, today, seed, weekOfProgram = 1 }) {
  const age = daysBetween(cohort.released, today);
  const need = seed ? growth.gate.seed_index_rate.at_day : growth.measure_day;
  if (age < need) return { state: 'wait', why: `cohort ${cohort.id} is ${age} days old; it is measured at day ${need} (${addDays(cohort.released, need)})` };
  const rows = pages.map((p) => snapshot.pages[p] || null);
  const missing = rows.filter((r) => !r).length;
  if (missing) return { state: 'hold', why: `${missing} of ${pages.length} pages in cohort ${cohort.id} have no search console data yet` };
  const indexed = rows.filter((r) => r.indexed).length;
  const rate = indexed / pages.length;
  const notIndexed = rows.filter((r) => !r.indexed && /not indexed/i.test(r.coverage || '')).length / pages.length;
  const seen = rows.filter((r) => r.indexed && r.impressions > 0).length / (indexed || 1);
  const g = growth.gate;
  const rateGreen = seed ? g.seed_index_rate.green : weekOfProgram >= g.index_rate_late.after_week ? g.index_rate_late.green : g.index_rate.green;
  const seenGreen = weekOfProgram > 10 ? g.impressions_share.green_after_week_10 : g.impressions_share.green;
  const numbers = { pages: pages.length, indexed, index_rate: +rate.toFixed(3), not_indexed_share: +notIndexed.toFixed(3), impressions_share: +seen.toFixed(3) };
  if (rate < g.index_rate.amber || notIndexed > g.not_indexed_share.amber || (!seed && seen < g.impressions_share.amber)) return { state: 'red', numbers, why: 'under the red line: stop, find what the unindexed pages lack, fix the template, consider pruning (seo/jobs/prune-report.mjs)' };
  if (rate < rateGreen || notIndexed > g.not_indexed_share.green || (!seed && seen < seenGreen)) return { state: 'amber', numbers, why: 'between the lines: hold the pace, no new cohort yet' };
  return { state: 'green', numbers, why: 'indexed and seen: the next cohort may go out' };
}

// how many pages of the next cohort go out today: the per-day slice, never more than a quarter of what is indexed in
// total, and never more than twice the last cohort
export function sliceSize({ waiting, growth, indexedTotal, lastCohortSize }) {
  return Math.max(0, Math.min(waiting, growth.caps.per_day, Math.floor(indexedTotal * growth.caps.max_share_of_indexed), Math.max(1, lastCohortSize) * growth.caps.max_growth_vs_last));
}
export const frozen = (growth, today) => growth.freeze.find((f) => today >= f.from && today <= f.until) || null;

async function takeSnapshot(urls, today) {
  const gsc = gscClient();
  const end = addDays(today, -2), start = addDays(end, -27);
  const seen = await gsc.pages(start, end);
  const pages = {};
  for (const url of urls) { const r = await gsc.inspect(url); pages[url] = { ...r, impressions: seen[url]?.impressions || 0, clicks: seen[url]?.clicks || 0 }; await pace(); }
  const snap = { taken: today, site: gsc.site, window: [start, end], pages };
  fs.mkdirSync(path.join(seoDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(seoDir, 'reports', `gsc-${today}.json`), JSON.stringify(snap, null, 1));
  return snap;
}

export async function run({ apply = false, today = localDay(), snapshotFile, siteUrl = (process.env.SITE_URL || 'https://madani.bot').replace(/\/+$/, ''), log = console.log } = {}) {
  const growth = JSON.parse(fs.readFileSync(path.join(seoDir, 'growth.json'), 'utf8'));
  const { release, records } = plan({ preview: false });
  const inCohort = (id, status) => records.filter((r) => r.state.cohort === id && (!status || r.state.status === status));
  const released = release.cohorts.filter((c) => c.released);
  const last = released.at(-1);
  // a cohort that started going out finishes first, slice by slice, without a new gate
  const going = released.find((c) => inCohort(c.id, 'queued').length);
  const next = going || release.cohorts.find((c) => !c.released && inCohort(c.id, 'queued').length);
  if (!next) return log('nothing queued: every cohort is out. add pages (seo/WRITING.md) and a cohort to seo/release.json'), { state: 'idle' };
  const freeze = frozen(growth, today);
  if (freeze) return log(`hold: release freeze until ${freeze.until} (${freeze.why})`), { state: 'freeze' };
  let verdict = { state: 'green', why: `cohort ${next.id} is already going out` };
  if (!going) {
    if (!last) verdict = { state: 'green', why: 'no cohort is out yet: this is the seed' };
    else {
      // too young to measure: say so without asking google
      const seed = last === release.cohorts[0], need = seed ? growth.gate.seed_index_rate.at_day : growth.measure_day, age = daysBetween(last.released, today);
      if (age < need) return log(`wait: cohort ${last.id} is ${age} days old; it is measured at day ${need} (${addDays(last.released, need)})`), { state: 'wait' };
      let snapshot = null;
      if (snapshotFile) snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
      else if (gscConfigured()) {
        try { snapshot = await takeSnapshot(inCohort(last.id).filter((r) => r.indexable).map((r) => siteUrl + r.path), today); } catch (err) { return log(`hold: search console did not answer (${err.cause?.code || err.message}); trying again tomorrow`), { state: 'hold' }; }
      }
      if (!snapshot) return log(`hold: search console is not connected (${GSC_ENV.credentials}, ${GSC_ENV.site}), so cohort ${next.id} waits. see omb-ref/SEO-SYSTEM.md "connect search console"`), { state: 'hold' };
      const week = Math.floor(daysBetween(release.cohorts[0].released, today) / 7) + 1;
      verdict = evaluateGate({ cohort: last, pages: inCohort(last.id).filter((r) => r.indexable).map((r) => siteUrl + r.path), snapshot, growth, today, seed: last === release.cohorts[0], weekOfProgram: week });
      if (verdict.numbers) log(`cohort ${last.id}: ${JSON.stringify(verdict.numbers)}`);
    }
  }
  log(`${verdict.state}: ${verdict.why}`);
  if (verdict.state !== 'green') return verdict;
  const waiting = inCohort(next.id, 'queued').filter((r) => r.review?.status === 'approved');
  const blocked = inCohort(next.id, 'queued').filter((r) => r.review?.status !== 'approved');
  for (const r of blocked) log(`skip ${r.path}: review is ${r.review?.status || 'none'}`);
  const indexedTotal = records.filter((r) => r.indexable).length;
  const lastSize = last ? inCohort(last.id).length : waiting.length;
  const n = last ? sliceSize({ waiting: waiting.length, growth, indexedTotal, lastCohortSize: lastSize }) : waiting.length;
  const today_ = waiting.slice(0, n);
  log(`${apply ? 'releasing' : 'would release'} ${today_.length} of ${waiting.length} waiting in cohort ${next.id}: ${today_.map((r) => r.path).join(', ') || 'none'}`);
  if (apply && today_.length) {
    if (!next.released) next.released = today;
    for (const r of today_) release.pages[r.path] = { ...release.pages[r.path], status: 'live', live_at: today };
    saveRelease(release);
  }
  return { ...verdict, released: today_.map((r) => r.path) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const out = await run({ apply: process.argv.includes('--apply'), today: arg('today') || localDay(), snapshotFile: arg('snapshot') });
  process.exit(out.state === 'red' ? 2 : 0);
}
