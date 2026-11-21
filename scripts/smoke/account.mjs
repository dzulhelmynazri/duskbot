// The smoke's madani account on the preview account service, signed in through the desktop app's own account client
// (electron/cloud-account.mjs) with a real sign-in code. Smoke addresses are at qa.madani.test: the account service never
// mails them (no Brevo, no one's inbox) and keeps the code in its test mailbox, read here with the preview ops token
// (MADANI_OPS_TOKEN_PREVIEW in the madani env file, never printed). The session is kept in the smoke profile so a run within a
// day reuses it instead of asking for another code.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PREVIEW_ORIGIN = "https://preview.madani.bot";
const FRESH_SIGN_IN_MS = 20 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function envValue(name, file = process.env.MADANI_ENV_FILE || join(homedir(), ".config", "madanibot", "madani.env")) {
  if (process.env[name]) return process.env[name];
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && match[1] === name) return match[2].replace(/^["']|["']$/g, "");
  }
  return null;
}

/** harness addresses: mail to this domain never leaves the account service (apps/dashboard/server/auth/mail.ts) */
export const TEST_MAIL_DOMAIN = "qa.madani.test";
export const isTestAddress = (email) => String(email).trim().toLowerCase().endsWith(`@${TEST_MAIL_DOMAIN}`);

/** the newest 8-digit sign-in code the account service kept for test address `email` after `since` (ms), or null */
export async function testMailCode(email, since, origin = PREVIEW_ORIGIN) {
  if (!isTestAddress(email)) throw new Error(`${email} is not a test address (@${TEST_MAIL_DOMAIN}); harnesses never send real mail`);
  const token = envValue("MADANI_OPS_TOKEN_PREVIEW") ?? envValue("MADANI_OPS_TOKEN");
  if (!token) throw new Error("MADANI_OPS_TOKEN_PREVIEW is not set (madani env file), so the test mailbox cannot be read");
  const response = await fetch(`${origin}/v1/ops/test-mail?to=${encodeURIComponent(email)}&since=${Math.max(0, since - 5_000)}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the test mailbox answered ${response.status}`);
  return (await response.json()).code ?? null;
}

/**
 * Signs the smoke account in (or restores today's session). Returns { client, state, how }.
 * root: the checkout whose account client runs. profile: the smoke profile folder.
 */
export async function smokeAccount({ root, profile, email, force = false, appVersion = "0.0.0" }) {
  const { createCloudAccountClient } = await import(pathToFileURL(join(root, "electron", "cloud-account.mjs")).href);
  const file = join(profile, "account-session.json");
  let saved = null;
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch {}
  const fresh = !force && saved?.email === email && Date.now() - (saved.signedInAt ?? 0) < FRESH_SIGN_IN_MS;
  const store = {
    read: async () => (fresh ? saved.value : null),
    write: async (value) => {
      saved = { email, signedInAt: saved?.email === email && fresh ? saved.signedInAt : Date.now(), value };
      writeFileSync(file, JSON.stringify(saved));
      chmodSync(file, 0o600);
    },
  };
  if (!isTestAddress(email)) throw new Error(`${email} is not a test address (@${TEST_MAIL_DOMAIN}); harnesses never send real mail`);
  const client = createCloudAccountClient({ origin: PREVIEW_ORIGIN, platform: process.platform, deviceName: "madani smoke", appVersion, store, openBrowser: async () => {}, warn: () => {} });
  let state = await client.start();
  if (state?.status === "connected") return { client, state, how: "kept today's session" };
  const since = Date.now();
  const sent = await client.emailStart(email);
  if (sent.outcome !== "sent") throw new Error(`the account service did not send a code (${sent.outcome})`);
  let code = null;
  for (let tries = 0; tries < 30 && !code; tries++) { await sleep(1_000); code = await testMailCode(email, since); }
  if (!code) throw new Error("no sign-in code in the test mailbox within 30 seconds");
  const signed = await client.emailVerify(code);
  if (signed.outcome !== "signed-in") throw new Error(`sign-in with the emailed code failed (${signed.outcome})`);
  state = client.state();
  if (state.status !== "connected") throw new Error(`signed in but the account is ${state.status}`);
  return { client, state, how: "signed in with an emailed code" };
}
