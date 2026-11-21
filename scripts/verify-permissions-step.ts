// The first run's Mac permissions step in a headless page with a fake bridge (scripts/testing/permissions-step-preview.tsx).
// Run: node --experimental-strip-types scripts/verify-permissions-step.ts            prints the page's URL and waits
//      node --experimental-strip-types scripts/verify-permissions-step.ts <dir>      photographs every state into <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHeadlessChrome } from "./testing/headless-chrome.ts";
import { mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";

// the step asks nothing of a server; /api requests have nowhere to go
const ui = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, {
  entry: "/scripts/testing/permissions-step-preview.tsx", route: "/__permissions-step.html", title: "Mac permissions step", logLevel: "warn", hmr: false,
});
const out = process.argv[2];
try {
  if (!out) {
    console.log(ui.previewUrl);
    await parkUntilSignal();
  } else {
    mkdirSync(out, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "madani-permissions-step-"));
    const page = await openHeadlessChrome(profile);
    try {
      const sizes = { desktop: { width: 1200, height: 800 }, smallest: { width: 768, height: 520 } };
      for (const skin of ["grok", "grok-dark"]) for (const state of ["none", "one", "all", "asked"]) for (const [size, box] of Object.entries(sizes)) {
        await page.send("Emulation.setDeviceMetricsOverride", { ...box, deviceScaleFactor: 2, mobile: false });
        await page.send("Page.navigate", { url: `${ui.previewUrl}?state=${state}&skin=${skin}` });
        await page.until("document.querySelectorAll('[data-permission-state]').length === 3 && !document.querySelector('[data-permission-ask]:disabled')");
        await new Promise((resolve) => setTimeout(resolve, 900));
        const overflow = await page.evaluate("document.documentElement.scrollWidth > innerWidth");
        if (overflow) console.error(`${skin} ${state} ${size}: the page scrolls sideways`);
        const name = `${skin === "grok" ? "light" : "dark"}-${state}-${size}.png`;
        writeFileSync(join(out, name), await page.capture());
        console.log(name);
      }
    } finally {
      page.close();
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
} finally {
  await ui.close();
}
