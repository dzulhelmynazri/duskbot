// A madani cloud for a test account on preview, bought for real in Dodo's TEST mode (nothing is charged): signs the account
// in (a qa.madani.test address, so no mail is sent), asks the operator grant for a test-mode checkout, pays it with the
// test card in a headless Chrome, and waits until the plan is active. For stress harnesses that need a cloud.
//
//   node scripts/smoke/test-purchase.mjs --email stress@qa.madani.test [--bundle starter] [--name "Stress Cloud"] [--profile DIR]
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envValue, isTestAddress, PREVIEW_ORIGIN, smokeAccount } from "./account.mjs";
import { payDodoTestCheckout } from "./dodo-test-pay.mjs";
import { until } from "./app.mjs";

const args = process.argv.slice(2);
const option = (key, fallback = null) => { const at = args.indexOf(key); return at === -1 ? fallback : args[at + 1] ?? fallback; };
const email = option("--email");
if (!email || !isTestAddress(email)) { console.error("--email <name>@qa.madani.test is required"); process.exit(2); }
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const profile = resolve(option("--profile", join(homedir(), ".cache", "madani-smoke", "purchase", email.replace(/[^a-z0-9]+/gi, "-"))));
mkdirSync(profile, { recursive: true });
const log = (line) => console.log(`[test-purchase] ${line}`);

const { client, how } = await smokeAccount({ root, profile, email });
log(`${email}: ${how}`);
const token = envValue("MADANI_OPS_TOKEN_PREVIEW");
const granted = await fetch(`${PREVIEW_ORIGIN}/v1/billing/ops/grant`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ email, bundle: option("--bundle", "starter"), name: option("--name", "Stress Cloud") }) });
const answer = await granted.json().catch(() => ({}));
if (granted.status !== 202 || !answer.checkoutUrl) throw new Error(`the grant answered ${granted.status} (${answer.code ?? answer.error ?? "no checkout"})`);
log(`test-mode checkout ${answer.checkoutId} for cloud ${answer.cloudId}`);
await payDodoTestCheckout(answer.checkoutUrl, { log });
const state = await until(async () => { const s = await client.refresh?.() ?? client.state(); return s?.clouds?.some((cloud) => cloud.id === answer.cloudId) ? s : false; },
  { what: "the cloud on the account", timeout: 120_000, every: 3_000 }).catch(() => client.state());
const cloud = state?.clouds?.find((item) => item.id === answer.cloudId);
log(`paid; cloud ${answer.cloudId} is ${cloud?.status ?? "not listed yet"}`);
process.exit(0);
