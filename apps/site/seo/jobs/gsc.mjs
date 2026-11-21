// a small google search console client for the release gate, with no dependencies: a service account signs its own
// token (rs256 through node:crypto), then asks the url inspection api whether each page is indexed and the search
// analytics api how many impressions each page had. read-only scope.
//   MADANI_GSC_CREDENTIALS  path to the service account's json key file (never commit it; keep it 0600 outside the repo)
//   MADANI_GSC_SITE         the property exactly as search console names it: sc-domain:madani.bot or https://madani.bot/
// limits (developers.google.com/webmaster-tools/limits): url inspection 2,000 a day and 600 a minute per property.
import fs from 'node:fs';
import { createSign } from 'node:crypto';

export const GSC_ENV = { credentials: 'MADANI_GSC_CREDENTIALS', site: 'MADANI_GSC_SITE' };
export const gscConfigured = (env = process.env) => Boolean(env[GSC_ENV.credentials] && env[GSC_ENV.site] && fs.existsSync(env[GSC_ENV.credentials]));

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function gscClient({ credentials = process.env[GSC_ENV.credentials], site = process.env[GSC_ENV.site], fetchImpl = fetch } = {}) {
  const key = JSON.parse(fs.readFileSync(credentials, 'utf8'));
  let token = null, until = 0;
  async function auth() {
    if (token && Date.now() < until - 60_000) return token;
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/webmasters.readonly', aud: key.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = b64url(createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key));
    const res = await fetchImpl(key.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }) });
    if (!res.ok) throw new Error(`search console sign-in failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    token = data.access_token; until = Date.now() + data.expires_in * 1000;
    return token;
  }
  async function call(url, body) {
    const res = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${await auth()}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`search console ${url.split('/').slice(-2).join('/')} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  return {
    site,
    // indexed or not, and why: coverageState is search console's own words ("Submitted and indexed", "Crawled - currently not indexed" ...)
    async inspect(url) {
      const data = await call('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { inspectionUrl: url, siteUrl: site });
      const r = data.inspectionResult?.indexStatusResult || {};
      return { url, verdict: r.verdict || 'VERDICT_UNSPECIFIED', coverage: r.coverageState || '', indexed: r.verdict === 'PASS', lastCrawl: r.lastCrawlTime || null };
    },
    // impressions and clicks per page between two days (inclusive), for pages whose address starts with prefix
    async pages(startDate, endDate, prefix) {
      const out = {};
      for (let startRow = 0; ; startRow += 25000) {
        const data = await call(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
          startDate, endDate, dimensions: ['page'], rowLimit: 25000, startRow, dataState: 'all',
          ...(prefix ? { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: prefix }] }] } : {}),
        });
        for (const row of data.rows || []) out[row.keys[0]] = { impressions: row.impressions, clicks: row.clicks, position: row.position };
        if (!data.rows || data.rows.length < 25000) break;
      }
      return out;
    },
    async sitemaps() { return (await call(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps`)).sitemap || []; },
  };
}

// a pause between url inspections keeps well under 600 a minute
export const pace = (ms = 150) => new Promise((r) => setTimeout(r, ms));
