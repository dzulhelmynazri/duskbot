// checks seo records against the quality gate without writing the seo pages or needing their pictures:
//   node seo/check.mjs seo/pages/integration/slack.json [more files ...]      (no files: every record)
// prints each problem and exits 1 if any. links to addresses in seo/planned.json are fine here even before those pages
// exist. the real build is stricter: it also needs the pictures and every linked page's record.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).path);
try {
  const out = execFileSync(process.execPath, [path.join(here, '..', 'build-pages.mjs'), process.env.MADANI_REPO || path.join(here, '..', '..', '..')], {
    env: { ...process.env, SEO_CHECK: '1', SEO_CHECK_ONLY: only.join(',') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(out.split('\n').filter((l) => /^(warning|problem|all checks|\d+ problems)/.test(l)).join('\n') + '\n');
} catch (err) {
  process.stdout.write(String(err.stdout || '').split('\n').filter((l) => /^(warning|problem|all checks|\d+ problems)/.test(l)).join('\n') + '\n');
  if (!/problem:/.test(String(err.stdout || ''))) process.stderr.write(String(err.stderr || err.message));
  process.exit(1);
}
