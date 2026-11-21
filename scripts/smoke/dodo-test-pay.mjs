// Pays a Dodo Payments TEST-mode checkout page with Dodo's test card, in a headless Chrome (flows/browser.mjs), the way
// a person would: contact details, billing address, then the card. Refuses any page that is not test mode, so it can
// never spend money. Used by the buy-cloud flow and by test-purchase.mjs (the operator grant on preview).
import { launchBrowser } from "./flows/browser.mjs";
import { until } from "./app.mjs";
import { walkthrough } from "./flows/recorder.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const js = (value) => JSON.stringify(value);
export const TEST_CARD = { number: "4242424242424242", expiry: "12/30", cvc: "123", name: "Madani Smoke" };

/** checkoutUrl: a test.checkout.dodopayments.com page. Returns { url: the page it ended on, shots } */
export async function payDodoTestCheckout(checkoutUrl, { shot = null, log = () => {}, timeout = 180_000, browser: given = null } = {}) {
  if (new URL(checkoutUrl).hostname !== "test.checkout.dodopayments.com") throw new Error(`not a Dodo test-mode checkout: ${new URL(checkoutUrl).hostname}`);
  // `browser`: an open tab to pay in (it stays open, on the page the payment came back to)
  const browser = given ?? await launchBrowser();
  const done = async () => { if (!given) await browser.close(); };
  const shots = [];
  const snap = async (label) => { if (!shot) return; const file = shot(label); if (file) { await browser.screenshot(file); shots.push(file); } };
  // react inputs: focus, select all, type through the protocol so the page's own handlers run
  /** a real mouse click in the middle of the element (some checkout buttons ignore a scripted click) */
  const press = async (selector, mark = null) => {
    if (mark) await browser.evaluate(mark);
    const box = await until(() => browser.evaluate(`(() => { const el = document.querySelector(${js(selector)}); if (!el || !el.getClientRects().length || el.disabled) return false; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`), { what: selector, timeout: 30_000 });
    walkthrough.did(`clicks "${(await browser.evaluate(`document.querySelector(${js(selector)})?.innerText?.trim().slice(0, 40) ?? ""`).catch(() => "")) || "continue"}"`, "browser");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await browser.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  };
  const fill = async (selector, text) => {
    await until(() => browser.evaluate(`(() => { const el = document.querySelector(${js(selector)}); if (!el || !el.getClientRects().length) return false; el.focus(); el.select?.(); return true; })()`), { what: selector, timeout: 30_000 });
    await browser.send("Input.insertText", { text });
  };
  try {
    // the page keeps loading trackers; the form below is what counts
    if (!given || !(await browser.url().catch(() => "")).startsWith(checkoutUrl.split("?")[0].replace(/\/session\/.*/, ""))) await browser.goto(checkoutUrl).catch(() => {});
    const stage = await until(() => browser.evaluate(`(() => { if (!/test mode/i.test(document.body.innerText)) return false;
      if (document.querySelector("input[name=fullName]")) return "contact";
      return [...document.querySelectorAll("iframe")].some((f) => /hs\\.dodopayments\\.com/.test(f.src)) ? "card" : false; })()`), { what: "the checkout in test mode", timeout: 60_000 });
    if (stage === "contact") {
      await snap("checkout");
      await fill("input[name=fullName]", TEST_CARD.name);
      const email = await browser.evaluate(`document.querySelector("input[name=email]")?.value ?? ""`);
      if (!email) throw new Error("the checkout did not carry the account's email");
      await browser.click("enter address manually").catch(() => {});
      await sleep(800);
      await fill("input[name=addressLine]", "1 Test Street");
      await fill("input[name=city]", "Bengaluru");
      await fill("input[name=zipCode]", "560001");
      await fill("input[name=state]", "Karnataka");
      await snap("contact");
      await sleep(500);
      await press("button#step1");
      log("contact done, waiting for the card form");
    }
    // the card fields live in the payment processor's own cross-origin frame
    await until(() => browser.evaluate(`Boolean([...document.querySelectorAll("iframe")].find((f) => /hs\\.dodopayments\\.com/.test(f.src) && f.getClientRects().length))`), { what: "the card frame", timeout: 90_000 });
    await snap("payment");
    const card = await browser.frame("hs.dodopayments.com", 60_000);
    const fields = await until(() => card.evaluate(`(() => { const inputs = [...document.querySelectorAll("input")].filter((e) => e.getClientRects().length).map((e) => ({ name: e.name, id: e.id, placeholder: e.placeholder, auto: e.autocomplete }));
      return inputs.length >= 3 ? inputs : false; })()`), { what: "the card inputs", timeout: 60_000 });
    log(`card inputs: ${fields.map((f) => f.auto || f.name || f.placeholder).join(", ")}`);
    const typeIn = async (match, text) => {
      const ok = await card.evaluate(`(() => { const el = [...document.querySelectorAll("input")].filter((e) => e.getClientRects().length).find((e) => ${match}); if (!el) return false; el.focus(); return true; })()`);
      if (!ok) throw new Error(`no card field for ${match}`);
      walkthrough.did(`types the test card's ${text === TEST_CARD.number ? "number (4242 ...)" : text === TEST_CARD.expiry ? "expiry" : "CVC"}`, "browser");
      await card.send("Input.insertText", { text });
      await sleep(400);
    };
    await typeIn(`/cc-number/.test(e.autocomplete) || /card ?number|1234/i.test(e.placeholder + e.name)`, TEST_CARD.number);
    await typeIn(`/cc-exp/.test(e.autocomplete) || /mm|expiry/i.test(e.placeholder + e.name)`, TEST_CARD.expiry);
    await typeIn(`/cc-csc/.test(e.autocomplete) || /cvc|cvv/i.test(e.placeholder + e.name)`, TEST_CARD.cvc);
    await snap("card");
    await sleep(800);
    // "pay now" may sit in the page or in the card frame
    const inPage = await browser.evaluate(`Boolean([...document.querySelectorAll("button")].find((b) => /^pay now$/i.test(b.innerText.trim()) && b.getClientRects().length))`);
    if (inPage) await press(`button[data-madani-pay]`, `[...document.querySelectorAll("button")].find((b) => /^pay now$/i.test(b.innerText.trim()) && b.getClientRects().length)?.setAttribute("data-madani-pay", "1")`);
    else { walkthrough.did(`clicks "Pay"`, "browser"); await card.evaluate(`[...document.querySelectorAll("button")].find((b) => /pay/i.test(b.innerText))?.click(); true`); }
    log("paid, waiting for the confirmation");
    // a card from an Indian address goes through 3-D Secure: the test page's own "complete" button passes it
    const complete = `(() => { const b = [...document.querySelectorAll("button,a,input[type=submit]")].find((e) => /complete( authentication)?$|authori[sz]e/i.test((e.innerText || e.value || "").trim()) && e.getClientRects().length); if (!b) return false; b.click(); return true; })()`;
    let authorized = false;
    const finished = await until(async () => {
      const url = await browser.url().catch(() => ""), text = await browser.text().catch(() => "");
      if (/payment (has )?failed|was declined/i.test(text)) throw Object.assign(new Error(`the test payment failed: ${text.slice(0, 200)}`), { final: true });
      if (/stripe\.com/.test(url) && !authorized) {
        authorized = await browser.evaluate(complete).catch(() => false);
        if (!authorized) for (const host of ["stripe.com", "stripe.network"]) {
          const frame = await browser.frame(host, 2_000).catch(() => null);
          if (frame && await frame.evaluate(complete).catch(() => false)) { authorized = true; break; }
        }
        if (authorized) { log("3-D Secure test page: completed"); await snap("3ds"); }
        return false;
      }
      return !/dodopayments\.com|stripe\.com/.test(url) && /^https?:/.test(url) ? url : /payment successful|thank you/i.test(text) ? url : false;
    }, { what: "the payment confirmation", timeout, every: 1_500 });
    await snap("paid");
    card.close();
    const landed = finished;
    await done();
    return { url: landed, shots };
  } catch (error) {
    await snap("failed").catch(() => {});
    const frames = [];
    const walk = (node) => { frames.push(node.frame.url.slice(0, 90)); for (const child of node.childFrames ?? []) walk(child); };
    try { walk((await browser.send("Page.getFrameTree")).frameTree); } catch {}
    log(`stuck at ${(await browser.url().catch(() => "?")).slice(0, 90)}; frames: ${frames.join(" | ")}; text: ${(await browser.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300)}`);
    await done();
    throw error;
  }
}
