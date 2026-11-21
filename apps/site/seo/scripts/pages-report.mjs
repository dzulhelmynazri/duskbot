// writes the owner's page list (default ~/Desktop/code/omb-ref/SEO-PAGES.md): what is live, what is queued in which
// cohort, and how far each page family can honestly grow, with counts from the data on disk.
//   node seo/scripts/pages-report.mjs [out-file]
import fs from 'node:fs';
import path from 'node:path';
import { plan, HUBS } from '../records.mjs';
import { plan as planActions } from './plan-actions.mjs';

const out = process.argv[2] || path.join(process.env.HOME, 'Desktop/code/omb-ref/SEO-PAGES.md');
const { records, release } = plan({ preview: false });
const KIND = { pillar: 'guide', guide: 'guide', alternative: 'alternative', comparison: 'comparison', integration: 'integration', action: 'app action', 'use-case': 'use case', role: 'role', routine: 'routine', glossary: 'glossary', tool: 'free tool' };
const live = records.filter((r) => r.indexable);
const count = (list) => Object.entries(list.reduce((m, r) => ((m[KIND[r.type]] = (m[KIND[r.type]] || 0) + 1), m), {})).map(([k, v]) => `${v} ${k}${v > 1 && !k.endsWith('s') ? 's' : ''}`).join(', ');
const table = (list) => '| page | kind | what it answers |\n| --- | --- | --- |\n' + [...list].sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path)).map((r) => `| [${r.path}](https://madani.bot${r.path}) | ${KIND[r.type]} | ${r.h1} |`).join('\n');
const cands = planActions();
const apps = new Set(cands.map((c) => c.toolkit)).size;
const connectorFiles = fs.readdirSync(new URL('../facts/connectors/', import.meta.url)).filter((f) => f.endsWith('.json')).length;

const lines = [
  '# madani.bot seo pages', '',
  `Updated ${new Date().toISOString().slice(0, 10)} by \`node seo/scripts/pages-report.mjs\`. How the system works: \`SEO-SYSTEM.md\` beside this file.`, '',
  'Every page is checked against the product docs and dated sources, reviewed, and must pass the build\'s quality gate (enough words of its own, no page more than 40% alike any other, real sources, no false claims). New pages go out in batches (cohorts); the release job checks Search Console every morning at 07:00 and lets the next batch out, up to three times bigger, once the last one is indexed and showing in search. If indexing stalls, it holds.', '',
  `## live now: ${live.length} pages`, '', `${count(live)}. Index pages: ${Object.values(HUBS).filter((h) => records.some((r) => r.indexable && r.hub === Object.keys(HUBS).find((k) => HUBS[k] === h))).map((h) => `[${h.nav}](https://madani.bot${h.at})`).join(', ')}.`, '', table(live), '',
];
for (const c of release.cohorts.filter((c) => records.some((r) => r.state.cohort === c.id && r.state.status === 'queued'))) {
  const q = records.filter((r) => r.state.cohort === c.id && r.state.status === 'queued');
  lines.push(`## queued: batch ${c.id}, ${c.label} (${q.length} pages)`, '', 'Goes out when the batch before it passes the check.', '', table(q), '');
}
lines.push('## where it goes from here: realistic target 2,000 to 5,000 pages this month', '',
  'Each family below has a template (several layouts, so pages differ in shape as well as words) and each page needs its own real data. Codex drafts pages from a hand-written exemplar and detailed instructions; reviewers check every batch; the build rejects anything thin or too similar. The gate then releases them as fast as Google indexes them.', '',
  '| family | address | the real data behind each page | honest ceiling | ready now |', '| --- | --- | --- | --- | --- |',
  `| app actions | /integrations/{app}/{action} | each action's own record in Composio's catalog: what it does, its inputs, the permissions it asks for, and whether Madani treats it as a read, a change or a send; plus a routine and steps written for it | ${cands.length.toLocaleString('en')} across our ${apps} apps (${cands.filter((c) => c.important).length} that Composio marks important); after dropping admin-only actions, about 2,000 to 2,500 worth a page | ${records.filter((r) => r.type === 'action').length} drafted; generator: \`seo/scripts/plan-actions.mjs\` |`,
  `| app integrations | /integrations/{app} | the app's action list from Composio (${connectorFiles} fetched so far; Composio lists 1,722 apps) | 100 to 200 apps people actually connect and search for; each one also opens its own action pages | ${records.filter((r) => r.type === 'integration').length} live |`,
  '| routine library | /routines/{name} | a paste-ready routine: the message, when it runs, what it needs, an example result, ways it goes wrong | 150 to 400 distinct routines | template and exemplar ready |',
  '| app x task | /use-cases/{task} sections or pages | only where a real routine exists for that task in that app | 40 to 80 | partly (use cases) |',
  '| role x app | /for/{role} | a role\'s routine pack in the apps that role uses | 20 to 40 | 7 role pages live |',
  '| task x ai (claude, chatgpt, gemini, grok) | /guides/... | each vendor\'s own feature for that task, sourced and dated (pages that only swap the ai name are not allowed) | 20 to 40 | 6 vendor feature guides live |',
  '| alternatives and comparisons | /alternatives, /vs | dated, sourced facts about each product, checked every few months | 30 to 60 | 24 live |',
  '| guides and pillars | /guides, /{topic} | hand-written, sourced | 40 to 80 | 33 live |',
  '| glossary | /glossary/{term} | a plain definition and a real example | 40 to 80 | 1 |',
  '| free tools | /tools/{tool} | small calculators | 5 to 10 | 1 |', '',
  'Adding these up honestly gives roughly 2,500 to 3,500 pages from the data we have today, more as Madani connects more apps. What would take it further later: tested runs of each app action (a page per action with a real recorded run), measured results of the same task on each AI inside Madani, and a moderated library of routines people share. Without data like that, more pages would just be the same page with a word swapped, which is exactly what Google penalises.', '',
  '## how fast', '',
  'The gate decides. Each batch is measured 7 days after it goes out. If at least 70% is indexed, few pages are stuck in "crawled, not indexed" and a share of them already get impressions, the next batch (up to three times the size) goes out the next morning; if not, it holds and the Monday prune report says which pages to fix or merge. A rough path if Google keeps indexing well: about 200 pages now, 500 to 600 in week 2, 1,500 to 2,000 by week 3, 3,000 or more by the end of the month. If indexing slows, so does this.');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${out}: ${live.length} live, ${records.length - live.length} not live, ${cands.length} action candidates`);
