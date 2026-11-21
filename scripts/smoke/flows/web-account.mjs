// The browser half of an account step (the account context redirect), as a person does it: the page the app opened
// (its browser sign-in, /cloud/desktop?code=), sign in or up there with a qa.madani.test address (the code read from the
// account service's test mailbox, no mail sent), approve the app, then wherever the app's intent lands: a plain sign-in
// says the app is signed in too, an upgrade goes to the plan's checkout, paid with Dodo's test card in the same tab,
// and comes back to "you're all set". In a headless Chrome of its own.
import { testMailCode, PREVIEW_ORIGIN } from "../account.mjs";
import { until } from "../app.mjs";
import { payDodoTestCheckout } from "../dodo-test-pay.mjs";
import { launchBrowser } from "./browser.mjs";
import { walkthrough } from "./recorder.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** url: what the app opened. Returns { landed, checkoutUrl?, allSet?, signedInPage?, steps } */
export async function webAccountStep(url, { email, pay = false, log = () => {}, shot = null, origin = PREVIEW_ORIGIN } = {}) {
  const browser = await launchBrowser();
  const steps = [];
  const snap = async (label) => { if (shot) { const file = shot(label); if (file) await browser.screenshot(file).catch(() => {}); } };
  const press = (pattern) => until(() => browser.evaluate(`(() => { const b = [...document.querySelectorAll("button,a")].filter((e) => e.getClientRects().length && !e.disabled).find((e) => ${pattern}.test(e.innerText.trim())); if (!b) return false; b.click(); return b.innerText.trim().slice(0, 60) || true; })()`), { timeout: 30_000, what: `${pattern} in the browser` })
    .then((said) => { walkthrough.did(`clicks "${typeof said === "string" ? said : pattern.source}"`, "browser"); return true; });
  try {
    await browser.goto(url).catch(() => {});
    // signed out in this browser: the website's own sign-in (or sign-up) with an emailed code
    // already signed in, the app's one-time handoff lands straight on the page: no sign-in, no approval
    const first = await until(async () => {
      // already signed in, the app's one-time handoff asks once "continue as <you>?" (no sign-in), then lands on the page
      if (/\/handoff/.test(await browser.url()) && /continue as/i.test(await browser.text().catch(() => ""))) { await press(/^continue$/i).catch(() => {}); steps.push("handoff: continue as this account (one click, no sign-in)"); return false; }
      if (/\/billing|test\.checkout\.dodopayments/.test(await browser.url())) return "landed";
      return browser.evaluate(`document.querySelector("input[type=email]") ? "email" : [...document.querySelectorAll("button")].some((b) => /^approve$/i.test(b.innerText.trim())) ? "approve" : false`);
    }, { timeout: 60_000, what: "the sign-in, the approval or the page" });
    if (first === "email") {
      await snap("web-sign-in");
      const since = Date.now();
      await browser.evaluate(`document.querySelector("input[type=email]").focus(); true`);
      await browser.send("Input.insertText", { text: email });
      walkthrough.did("clicks continue", "browser");
      await browser.evaluate(`document.querySelector("form button[type=submit]").click(); true`);
      // a second code to the same address within the resend window is refused: wait, then resend, as a person would
      // "too many tries, wait a minute": the person waits, then presses continue again
      await sleep(2500);
      for (let tries = 0; tries < 4 && /too many tries/i.test(await browser.text().catch(() => "")); tries++) {
        steps.push("told \"too many tries, wait a minute\"; waited and pressed continue again");
        await sleep(65_000);
        walkthrough.did("waits a minute, then clicks continue again", "browser");
        await browser.evaluate(`document.querySelector("form button[type=submit]").click(); true`);
        await sleep(2500);
      }
      let code = await until(() => testMailCode(email, since, origin), { timeout: 20_000, every: 1_000, what: "the website's sign-in code" }).catch(() => null);
      if (!code) {
        await until(() => browser.evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((e) => /^resend/i.test(e.innerText.trim()) && !e.disabled); if (!b) return false; b.click(); return true; })()`), { timeout: 180_000, what: "resend" });
        steps.push("resent the code");
        code = await until(() => testMailCode(email, since, origin), { timeout: 60_000, every: 1_000, what: "the website's sign-in code" });
      }
      await until(() => browser.evaluate(`Boolean(document.querySelector("input[autocomplete=one-time-code], input[inputmode=numeric], form input[type=text]"))`), { what: "the code field" });
      await browser.evaluate(`(document.querySelector("input[autocomplete=one-time-code]") ?? document.querySelector("input[inputmode=numeric]") ?? document.querySelector("form input[type=text]")).focus(); true`);
      await browser.send("Input.insertText", { text: code });
      steps.push("signed in on the website");
    }
    if (first !== "landed") {
      await until(() => browser.evaluate(`[...document.querySelectorAll("button")].some((b) => /^approve$/i.test(b.innerText.trim()))`), { timeout: 60_000, what: "the approval" });
      await snap("web-approve");
      await press(/^approve$/i);
      steps.push("approved the app");
    } else steps.push("already signed in: no second sign-in");
    // where the intent lands: the plan (the name step first for a new account), or the signed-in page
    const landed = await until(async () => { const at = await browser.url(); const text = await browser.text().catch(() => "");
      if (/\/billing/.test(at) || /test\.checkout\.dodopayments\.com/.test(at)) return at;
      return /you are signed in/i.test(text) ? at : false; }, { timeout: 60_000, what: "where the app's step lands" });
    await snap("web-landed");
    if (!/\/billing|dodopayments/.test(landed)) {
      const back = await browser.evaluate(`document.querySelector("[data-back-to-app]")?.getAttribute("href") ?? null`);
      steps.push(`signed-in page, back to the app: ${back}`);
      return { landed, signedInPage: true, backToApp: back, steps };
    }
    // billing, or plans with no plan picked: that page is where the step ends
    if (!/dodopayments/.test(landed) && !/[?&]plan=/.test(landed) && !/[?&]plan=/.test(await browser.url())) { steps.push(`landed on ${new URL(await browser.url()).pathname}`); return { landed: await browser.url(), steps }; }
    // the plan: the website's own steps up to its checkout
    let checkoutUrl = /dodopayments/.test(landed) ? landed : null;
    for (let tries = 0; tries < 20 && !checkoutUrl; tries++) {
      const at = await browser.url();
      if (/test\.checkout\.dodopayments\.com/.test(at)) { checkoutUrl = at; break; }
      if (at.startsWith("https://checkout.dodopayments.com")) throw new Error("a live checkout opened; refusing to pay");
      // the most final step first: a sheet's checkout before the card's "get plus" that opened it
      const said = await browser.evaluate(`(() => { const shown = [...document.querySelectorAll("button")].filter((e) => e.getClientRects().length && !e.disabled);
        for (const want of [/^checkout$/i, /continue to checkout|continue to payment/i, /start (free )?trial/i, /^continue$/i, /^get /i]) { const b = shown.find((e) => want.test(e.innerText.trim())); if (b) { b.click(); return b.innerText.trim().slice(0, 60); } }
        return false; })()`).catch(() => false);
      if (said) walkthrough.did(`clicks "${said}"`, "browser");
      await sleep(3000);
    }
    if (!checkoutUrl) throw new Error(`no checkout after the plan step (at ${await browser.url()})`);
    steps.push(`checkout ${new URL(checkoutUrl).host}`);
    if (!pay) return { landed, checkoutUrl, steps };
    const paid = await payDodoTestCheckout(checkoutUrl, { browser, log });
    steps.push("paid with the test card");
    // back on the website: "you're all set" with the way back to the app
    const allSet = await until(() => browser.evaluate(`Boolean(document.querySelector("[data-all-set]"))`), { timeout: 90_000, what: "you're all set" }).catch(() => false);
    await snap("web-all-set");
    return { landed, checkoutUrl, paidAt: paid.url, allSet: Boolean(allSet), steps };
  } catch (error) {
    await snap("web-failed");
    const at = await browser.url().catch(() => "?"), text = (await browser.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`${error.message} (at ${at}: ${text})`);
  } finally {
    await browser.close();
  }
}

/** the app's most recent browser sign-in link (/cloud/desktop?code=) or plan page it opened since `since` */
export function accountLinkFrom(opened) {
  return opened.find((url) => /\/cloud\/desktop\?code=/.test(url)) ?? opened.find((url) => /\/handoff#|\/billing/.test(url)) ?? null;
}
