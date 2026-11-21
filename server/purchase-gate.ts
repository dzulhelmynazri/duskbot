// Security: the bots' browser may not take a purchase's last step (Place order, Buy now, Pay, Book now) until the person
// tapped "Confirm purchase" on the card confirm_purchase posts, at every access level. The gate reads the control a
// call names from the page as the bot last saw it (the snapshot lines with refs and the page's address), so it holds
// for both browser engines. A click by point (x, y) is named by the control the page has there (withPointNames); one
// that cannot be named counts as the last step on a checkout page.
import { CHECKOUT_PAGE, finishesPurchase } from "../shared/purchase.ts";

/** How long one confirmation lets the browser finish the purchase it covers. */
export const PURCHASE_PASS_MS = 10 * 60_000;

export const PURCHASE_REFUSAL = "madani bot did not click this: it looks like the last step of a purchase, which needs the person's confirmation first. Call confirm_purchase with the order summary you can see on this page (items and quantities, total with shipping, masked payment method, delivery address, expected delivery). It shows the person a card and waits for their tap; once they confirm, take this step again. If they cancel, do not buy.";

type Args = Record<string, unknown>;
interface Page { address: string; refs: Map<string, string> }

const REF = /^\s*(?:@|ref=)?(e\d+)\s*$/u;
const REF_LINE = /^[ \t]*-[^"\n]*"((?:[^"\\\n]|\\.)*)"[^\n]*?\[ref=(e\d+)\]/gmu;
const PAGE_LINE = /\b(?:https?:\/\/[^\s"'<>]+)/u;
const TITLE_LINE = /^Page t\d+: "((?:[^"\\]|\\.)*)"/mu;
const STEP_TOOLS: Readonly<Record<string, string>> = { click: "agent_browser_click", press: "agent_browser_press", fill: "agent_browser_fill" };

const record = (value: unknown): Args => (value && typeof value === "object" && !Array.isArray(value) ? value as Args : {});

function resultText(result: unknown): string {
  const content = record(result).content;
  return Array.isArray(content) ? content.flatMap((part) => (record(part).type === "text" && typeof record(part).text === "string" ? [String(record(part).text)] : [])).join("\n") : "";
}

/** Where a point click's control name is carried to the check: a string, or null when the page could not name it. */
const HIT = "madaniPointName";
const HIT_MARK = /MADANI_HIT:([^\s"'\\]*):END/u;

/** The control under a point, as an agent_browser_eval script: the clickable element around it and its words. A frame
 * there (a card form) has no words this page can read. */
export function pointNameScript(x: number, y: number): string {
  return `(() => { const el = document.elementFromPoint(${Number(x)}, ${Number(y)}); if (!el || el.tagName === "IFRAME") return "MADANI_HIT::END"; const c = el.closest("button,a,[role=button],[role=link],input[type=submit],input[type=button],summary") || el; const t = (c.getAttribute("aria-label") || c.value || c.innerText || c.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 200); return "MADANI_HIT:" + encodeURIComponent(t || "-") + ":END"; })()`;
}

/** The name an eval of pointNameScript returned, or null. */
export function pointName(result: unknown): string | null {
  const found = HIT_MARK.exec(resultText(result))?.[1];
  if (!found) return null;
  try { return found === "-" ? "" : decodeURIComponent(found); } catch { return null; }
}

const isPoint = (args: Args) => typeof args.x === "number" && typeof args.y === "number" && args.ref === undefined && args.selector === undefined && args.text === undefined;

/** The call's arguments with each click by point named through `nameAt`, which answers null when it cannot tell. */
export async function withPointNames(name: string | undefined, args: unknown, nameAt: (x: number, y: number) => Promise<string | null>): Promise<unknown> {
  const given = record(args);
  if (name === "agent_browser_click" && isPoint(given)) return { ...given, [HIT]: await nameAt(given.x as number, given.y as number) };
  if (name !== "agent_browser_batch" || !Array.isArray(given.steps)) return args;
  const steps: unknown[] = [];
  for (const step of given.steps) {
    const one = record(step);
    steps.push(one.do === "click" && isPoint(one) ? { ...one, [HIT]: await nameAt(one.x as number, one.y as number) } : step);
  }
  return { ...given, steps };
}

/** The words a selector names an element by: text=…, :has-text("…"), [name="…"], or its id and classes as words. */
function selectorWords(selector: string): string {
  const quoted = /(?:text=|has-text\(|name=|aria-label=|value=)\s*["']?([^"'\])]+)/iu.exec(selector);
  if (quoted) return quoted[1]!;
  return selector.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[#.\-_[\]=>:"']+/gu, " ");
}

export class PurchaseGate {
  readonly #pages = new Map<string, Page>();
  readonly #passes = new Map<string, number>();
  /** A pass a call is using: given back when that call fails, since nothing was bought. */
  readonly #using = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The person confirmed a purchase for this browser session: its next purchase step goes ahead, once. */
  grant(session: string, ms = PURCHASE_PASS_MS): void {
    this.#passes.set(session, this.#now() + ms);
  }

  /** The refusal for a call that would finish a purchase without a confirmation; a pass it uses is spent. */
  check(session: string, name: string | undefined, args: unknown): string | null {
    if (!this.#finishes(session, name, record(args))) return null;
    const until = this.#passes.get(session);
    if (until !== undefined && until > this.#now()) {
      this.#passes.delete(session);
      this.#using.set(session, until);
      return null;
    }
    this.#passes.delete(session);
    return PURCHASE_REFUSAL;
  }

  /** Keeps the page the bot last saw: its address and title, and each ref's name. */
  observe(session: string, result: unknown): void {
    const using = this.#using.get(session);
    this.#using.delete(session);
    if (using !== undefined && record(result).isError === true) this.#passes.set(session, using);
    const text = resultText(result);
    if (!text) return;
    const address = PAGE_LINE.exec(text)?.[0];
    const title = TITLE_LINE.exec(text)?.[1] ?? "";
    const refs = new Map<string, string>();
    for (const match of text.matchAll(REF_LINE)) refs.set(match[2]!, match[1]!.replace(/\\"/gu, "\""));
    const page = this.#pages.get(session);
    if (refs.size) this.#pages.set(session, { address: address ? `${address} ${title}` : page?.address ?? "", refs });
    else if (address && page) page.address = `${address} ${title}`;
    else if (address) this.#pages.set(session, { address: `${address} ${title}`, refs: new Map() });
  }

  forget(session: string): void {
    this.#pages.delete(session);
    this.#passes.delete(session);
    this.#using.delete(session);
  }

  #finishes(session: string, name: string | undefined, args: Args): boolean {
    if (name === "agent_browser_batch") {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      return steps.some((step) => {
        const { do: action, ...rest } = record(step);
        return typeof action === "string" && STEP_TOOLS[action] !== undefined && this.#finishes(session, STEP_TOOLS[action], rest);
      });
    }
    const page = this.#pages.get(session);
    const address = page?.address ?? "";
    if (name === "agent_browser_press") return /^(?:Enter|NumpadEnter)$/u.test(String(args.key ?? "")) && CHECKOUT_PAGE.test(address);
    if (name === "agent_browser_fill") return args.submit === true && CHECKOUT_PAGE.test(address);
    if (name !== "agent_browser_click") return false;
    if (HIT in args) return typeof args[HIT] === "string" ? finishesPurchase(args[HIT], address) : CHECKOUT_PAGE.test(address);
    return finishesPurchase(this.#controlName(page, args), address);
  }

  #controlName(page: Page | undefined, args: Args): string {
    const target = typeof args.ref === "string" ? args.ref : typeof args.selector === "string" ? args.selector : typeof args.text === "string" ? `text=${args.text}` : "";
    const ref = REF.exec(target)?.[1];
    if (ref) return page?.refs.get(ref) ?? "";
    return selectorWords(target);
  }
}

/** One per server: a browser session belongs to one bot profile, and confirm_purchase grants by that session. */
export const purchaseGate = new PurchaseGate();
