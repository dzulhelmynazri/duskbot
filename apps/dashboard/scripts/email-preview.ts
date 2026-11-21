// node apps/dashboard/scripts/email-preview.ts <out dir> [local asset dir]
// writes every account email as html and text, light and dark screenshots and emails-sheet.png. the html points at the
// hosted art (MADANI_EMAIL_ASSET_BASE); a local asset dir answers those requests instead, for art not deployed yet.
// playwright is not a dependency here: PLAYWRIGHT_FROM names a folder whose node_modules has it, CHROMIUM_PATH a browser.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { samples } from "../server/email/samples.ts";
import { emailConfig } from "../server/email/templates.ts";

const out = resolve(process.argv[2] ?? "email-previews"), local = process.argv[3] ? resolve(process.argv[3]) : null;
const cfg = emailConfig(process.env, { publicUrl: process.env.MADANI_DASHBOARD_PUBLIC_URL ?? "https://preview.madani.bot", pageBase: process.env.MADANI_DASHBOARD_PAGE_BASE ?? "/dashboard" });
const { chromium } = createRequire(join(resolve(process.env.PLAYWRIGHT_FROM ?? "."), "package.json"))("playwright");
mkdirSync(out, { recursive: true });

const all = samples(cfg);
const browser = await chromium.launch({ headless: true, args: ["--use-mock-keychain", "--password-store=basic"], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const missing = new Set<string>();
async function shoot(html: string, file: string, scheme: "light" | "dark", width = 640) {
  const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme });
  if (local) await page.route(`${cfg.assets}/**`, async (route: { request(): { url(): string }; fulfill(o: object): Promise<void> }) => {
    const path = join(local, route.request().url().slice(cfg.assets.length + 1));
    if (!existsSync(path)) { missing.add(path); return route.fulfill({ status: 404, body: "" }); }
    await route.fulfill({ status: 200, body: readFileSync(path), contentType: path.endsWith(".woff2") ? "font/woff2" : "image/png" });
  });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}
for (const { id, email } of all) {
  writeFileSync(join(out, `${id}.html`), email.html);
  writeFileSync(join(out, `${id}.txt`), `Subject: ${email.subject}\n\n${email.text}\n`);
  await shoot(email.html, join(out, `${id}-light.png`), "light");
  await shoot(email.html, join(out, `${id}-dark.png`), "dark");
  if (id === "02-welcome") await shoot(email.html, join(out, `${id}-mobile.png`), "light", 375);
}
const tiles = all.map(({ id, email }) => `<figure><figcaption><b>${id}</b> ${email.subject.replace(/[&<>]/g, "")}</figcaption><div><img src="${id}-light.png"><img src="${id}-dark.png"></div></figure>`).join("");
const sheet = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#f3f3f5;font:13px/1.4 -apple-system,sans-serif;color:#222}
main{display:grid;grid-template-columns:repeat(3,1fr);gap:28px 22px;align-items:start}figure{margin:0}figcaption{margin:0 0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
figure div{display:grid;grid-template-columns:1fr 1fr;gap:6px;align-items:start}img{width:100%;display:block;border:1px solid #ddd}</style><main>${tiles}</main>`;
writeFileSync(join(out, "sheet.html"), sheet);
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(`file://${join(out, "sheet.html")}`, { waitUntil: "load" });
await page.screenshot({ path: join(out, "emails-sheet.png"), fullPage: true });
await browser.close();
writeFileSync(join(out, "README.txt"), all.map(({ id, email, trigger }) => `${id}\n  subject: ${email.subject}\n  sent on: ${trigger}`).join("\n\n") + "\n");
if (missing.size) { console.error(`missing assets:\n${[...missing].join("\n")}`); process.exitCode = 1; }
console.log(`${all.length} emails in ${out}`);
