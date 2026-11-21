// Security: a bot driving a computer (This Mac, a Local VM, a cloud computer) may not take a purchase's last step until
// the person tapped "Confirm purchase". Each driver bridge keeps what its screen last showed (window titles, page
// addresses, each element's label by index, from the driver's own answers) and marks a click or an Enter that would
// finish a purchase; the harness refuses a marked call unless the conversation holds a confirmation. A click by point,
// or on an element whose label was never seen, cannot be named, so on a checkout or payment page it counts as that step.
import { CHECKOUT_PAGE, finishesPurchase, PURCHASE_BUTTON } from "../shared/purchase.ts";
import { PURCHASE_PASS_MS } from "./purchase-gate.ts";

export const COMPUTER_PURCHASE_REFUSAL = "madani bot did not do this: the screen shows the last step of a purchase or payment, which needs the person's confirmation first. Call confirm_purchase with the order summary on screen (items and quantities, total with shipping, masked payment method, delivery address, expected delivery). It shows the person a card and waits for their tap; once they confirm, take this step again. If they cancel, do not buy.";

/** The query flag a bridge adds to its control check for a call it marked. */
export const PURCHASE_QUERY = "purchase";

type Args = Record<string, unknown>;
const record = (value: unknown): Args => (value && typeof value === "object" && !Array.isArray(value) ? value as Args : {});

const CLICKS = new Set(["click", "double_click", "left_click", "right_click", "tap"]);
const KEYS = new Set(["press_key", "hotkey", "key"]);
const URL_TEXT = /https?:\/\/[^\s"'<>)\]]+/gu;
/** An element with its index in the driver's tree: `[12] AXButton "Place order"`, `12: button "Pay"`, `element_index 12 … "Buy"`. */
const ELEMENT_LINE = /(?:\[(\d+)\]|^\s*(\d+)[:.)]|element_index["':=\s]+(\d+))[^\n"]*?(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|\s([^\n]{1,120}))/gmu;
const TITLE_LINE = /\b(?:title|window|tab)["':=\s]+("?)([^\n"]{1,200})\1/giu;

function textOf(result: unknown): string {
  const content = record(result).content;
  const structured = record(result).structuredContent;
  const parts = Array.isArray(content) ? content.flatMap((part) => (record(part).type === "text" && typeof record(part).text === "string" ? [String(record(part).text)] : [])) : [];
  return [...parts, structured === undefined ? "" : JSON.stringify(structured)].join("\n");
}

/** What one bridge's screen last showed, and whether a call would finish a purchase on it. */
export class ComputerPurchaseWatch {
  #context = "";
  readonly #labels = new Map<string, string>();

  /** A driver's answer: the page addresses and window titles it names, and each element's label by index. */
  observe(result: unknown): void {
    const text = textOf(result);
    if (!text) return;
    const urls = text.match(URL_TEXT) ?? [];
    const titles = [...text.matchAll(TITLE_LINE)].map((match) => match[2]!.trim());
    const labels = new Map<string, string>();
    for (const match of text.matchAll(ELEMENT_LINE)) {
      const index = match[1] ?? match[2] ?? match[3];
      const label = (match[4] ?? match[5] ?? match[6] ?? "").trim();
      if (index && label) labels.set(index, label);
    }
    if (labels.size) {
      this.#labels.clear();
      for (const [index, label] of labels) this.#labels.set(index, label);
    }
    if (urls.length || titles.length) this.#context = [...urls.slice(0, 3), ...titles.slice(0, 3)].join(" ");
    // a page whose own words carry the last step's button counts as one, whatever its address
    if (labels.size && [...labels.values()].some((label) => PURCHASE_BUTTON.test(label) && finishesPurchase(label, ""))) this.#context = `${this.#context} checkout`;
  }

  /** Whether this tools/call would take a purchase's last step on what the screen last showed. */
  finishes(frame: unknown): boolean {
    const params = record(record(frame).params);
    const name = typeof params.name === "string" ? params.name : "";
    const args = record(params.arguments);
    const checkout = CHECKOUT_PAGE.test(this.#context);
    if (KEYS.has(name)) return checkout && /^(?:enter|return|kp_enter|numpadenter)$/iu.test(String(args.key ?? args.keys ?? "").split("+").at(-1) ?? "");
    if (name === "type_text") return checkout && /[\r\n]$/u.test(String(args.text ?? ""));
    if (!CLICKS.has(name) && !/^browser_.*click/u.test(name)) return false;
    const index = args.element_index ?? args.elementIndex ?? args.index;
    const label = (index === undefined ? undefined : this.#labels.get(String(index))) ?? (typeof args.text === "string" ? args.text : undefined);
    if (label !== undefined) return finishesPurchase(label, this.#context);
    return checkout;
  }

  /** The control check's query for this call: the purchase flag when it would finish one. */
  query(frame: unknown): Record<string, string> {
    return this.finishes(frame) ? { [PURCHASE_QUERY]: "1" } : {};
  }
}

/** Per conversation, until when a confirmed purchase lets its computer take the last step. Clicks on a screen cannot be
 * told apart as surely as a page's controls, so a confirmation holds for its whole window rather than one step. */
export class ComputerPurchasePasses {
  readonly #until = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  grant(threadId: string, ms = PURCHASE_PASS_MS): void {
    this.#until.set(threadId, this.#now() + ms);
  }

  /** The control answer that refuses a marked call in this conversation, or null to ask the control gate as usual. */
  hold(threadId: string, query: URLSearchParams): { held: true; helpOpen: false; blockedReason: string } | null {
    if (query.get(PURCHASE_QUERY) !== "1") return null;
    const until = this.#until.get(threadId);
    return until !== undefined && until > this.#now() ? null : { held: true, helpOpen: false, blockedReason: COMPUTER_PURCHASE_REFUSAL };
  }
}

export const computerPurchasePasses = new ComputerPurchasePasses();
