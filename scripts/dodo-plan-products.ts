#!/usr/bin/env -S node --experimental-strip-types
// Creates or updates the Dodo products that sell each plan as ONE line (plan_pro, plan_team, month and year) and names the
// plain cloud products, so a checkout shows "madani cloud Pro (monthly)" at its full price and no separate licence line.
// Prices come from the billing config (a plan's quote), so the products cannot drift from what the account service charges.
//
//   MADANI_DODO_API_KEY=... MADANI_DODO_MODE=test MADANI_DODO_PRODUCTS='{...}' node scripts/dodo-plan-products.ts [--apply] [--out map.json]
//
// Dry run unless --apply. MADANI_DODO_MODE=live also needs --live. Prints key, product id and what it did; never the API key.
// The --out file is the full MADANI_DODO_PRODUCTS map (existing ids plus the new ones) to put back in the service's env.
import { writeFileSync } from "node:fs";
import { BILLING_CONFIG } from "../apps/dashboard/server/billing/plans.ts";
import { quote } from "../apps/dashboard/server/billing/pricing.ts";

const args = process.argv.slice(2), apply = args.includes("--apply"), live = args.includes("--live");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const key = process.env.MADANI_DODO_API_KEY, mode = process.env.MADANI_DODO_MODE;
if (!key || (mode !== "test" && mode !== "live")) { console.error("set MADANI_DODO_API_KEY and MADANI_DODO_MODE (test or live)"); process.exit(2); }
if (mode === "live" && !live) { console.error("live mode needs --live"); process.exit(2); }
const map: Record<string, string> = process.env.MADANI_DODO_PRODUCTS ? JSON.parse(process.env.MADANI_DODO_PRODUCTS) : {};
const base = `https://${mode}.dodopayments.com`;
async function call(path: string, method: string, body?: unknown) {
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const text = await response.text();
  return text ? JSON.parse(text) as Record<string, any> : null;
}
const price = (cents: number, interval: "month" | "year") => ({ type: "recurring_price", currency: "USD", price: cents, discount: 0, purchasing_power_parity: false, tax_inclusive: false,
  payment_frequency_count: 1, payment_frequency_interval: interval === "month" ? "Month" : "Year", subscription_period_count: 10, subscription_period_interval: "Year" });

// name and what each key is sold as: a plan is its bundle's quote; the cloud-only products keep their own price
const wanted: Array<{ key: string; name: string; cents: number; description: string }> = [];
for (const interval of ["month", "year"] as const) {
  const word = interval === "month" ? "monthly" : "yearly";
  for (const bundle of BILLING_CONFIG.bundles) {
    const total = quote({ ...bundle.cart, interval }, BILLING_CONFIG).totalCents;
    if (bundle.id === "starter") wanted.push({ key: `desktop_shared_s:${interval}`, name: `madani cloud Plus (${word})`, cents: total, description: bundle.highlights.join(". ") });
    if (bundle.id === "pro") wanted.push({ key: `plan_pro:${interval}`, name: `madani cloud Pro (${word})`, cents: total, description: bundle.highlights.join(". ") });
    if (bundle.id === "team") wanted.push({ key: `plan_team:${interval}`, name: `madani cloud Team (${word})`, cents: total, description: bundle.highlights.join(". ") });
  }
}
for (const w of wanted) {
  const id = map[w.key];
  if (!id) {
    console.log(`${w.key}: create "${w.name}" ${w.cents} cents`);
    if (apply) { const made = await call("/products", "POST", { name: w.name, description: w.description, price: price(w.cents, w.key.endsWith(":year") ? "year" : "month"), tax_category: "saas" }); map[w.key] = String(made!.product_id); console.log(`  -> ${map[w.key]}`); }
    continue;
  }
  const have = await call(`/products/${encodeURIComponent(id)}`, "GET");
  const same = have!.name === w.name && have!.price?.price === w.cents && (have!.description ?? "") === w.description;
  console.log(`${w.key}: ${id} ${same ? "ok" : `update to "${w.name}" ${w.cents} cents (was "${have!.name}" ${have!.price?.price})`}`);
  if (!same && apply) await call(`/products/${encodeURIComponent(id)}`, "PATCH", { name: w.name, description: w.description, ...(have!.price?.price === w.cents ? {} : { price: price(w.cents, w.key.endsWith(":year") ? "year" : "month") }) });
}
// the cloud-only products used when a licence is already held keep their price; only their name changes so it never reads as the plan
const renames: Record<string, string> = { "desktop_shared_m": "madani cloud Pro, extra cloud" };
for (const interval of ["month", "year"] as const) for (const [k, label] of Object.entries(renames)) {
  const id = map[`${k}:${interval}`], name = `${label} (${interval === "month" ? "monthly" : "yearly"})`;
  if (!id) continue;
  const have = await call(`/products/${encodeURIComponent(id)}`, "GET");
  console.log(`${k}:${interval}: ${id} ${have!.name === name ? "ok" : `rename to "${name}"`}`);
  if (have!.name !== name && apply) await call(`/products/${encodeURIComponent(id)}`, "PATCH", { name });
}
if (out && apply) { writeFileSync(out, JSON.stringify(map)); console.log(`wrote the product map to ${out}`); }
if (!apply) console.log("dry run: pass --apply to write");
