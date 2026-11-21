// one-time brevo setup for the waitlist, safe to rerun: folder "madani", list "madani waitlist", and the contact
// attributes server.js sends (SOURCE text, POSITION number, SIGNED_UP_AT date). sends no email.
//   BREVO_API_KEY=... node brevo-setup.mjs [env-file]
// with an env file, BREVO_WAITLIST_LIST_ID is written (or replaced) in it. the key needs the "contacts" permission.
import fs from 'node:fs';

const key = process.env.BREVO_API_KEY;
if (!key) { console.error('set BREVO_API_KEY'); process.exit(2); }
const api = async (method, p, body) => {
  const r = await fetch(`https://api.brevo.com/v3${p}`, {
    method, headers: { 'api-key': key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw Object.assign(new Error(`${method} ${p}: ${r.status} ${data.code || ''} ${data.message || ''}`), { status: r.status, data });
  return data;
};

const folders = (await api('GET', '/contacts/folders?limit=50')).folders || [];
const folder = folders.find((f) => f.name === 'madani') || await api('POST', '/contacts/folders', { name: 'madani' });
const lists = (await api('GET', '/contacts/lists?limit=50')).lists || [];
const list = lists.find((l) => l.name === 'madani waitlist') || await api('POST', '/contacts/lists', { name: 'madani waitlist', folderId: folder.id });

const have = new Set(((await api('GET', '/contacts/attributes')).attributes || []).filter((a) => a.category === 'normal').map((a) => a.name));
for (const [name, type] of [['SOURCE', 'text'], ['POSITION', 'float'], ['SIGNED_UP_AT', 'date']]) {
  if (!have.has(name)) await api('POST', `/contacts/attributes/normal/${name}`, { type });
}
console.log(`brevo: folder ${folder.id}, list "madani waitlist" id ${list.id}, attributes SOURCE POSITION SIGNED_UP_AT ready`);

const envFile = process.argv[2];
if (envFile) {
  const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => !l.startsWith('BREVO_WAITLIST_LIST_ID=')) : [];
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  lines.push(`BREVO_WAITLIST_LIST_ID=${list.id}`, '');
  fs.writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
  console.log(`wrote BREVO_WAITLIST_LIST_ID to ${envFile}`);
}
