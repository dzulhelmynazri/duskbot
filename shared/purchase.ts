// Purchases and other money moves (checkout, payment, booking, subscribing, sending money): the order summary a bot
// shows on the "Confirm purchase" card, and how the harness recognises such a step in an app tool or on a web page.
// Security: a purchase waits for the person's tap at every access level, Full access included.

/** One line of an order. */
export interface PurchaseItem {
  name: string;
  quantity: number;
  /** As the shop shows it, currency included ("$12.99"). */
  price?: string;
}

/** What the "Confirm purchase" card shows. Money is written as the shop shows it. */
export interface PurchaseSummary {
  /** The shop, airline, service or person paid. */
  merchant: string;
  items: PurchaseItem[];
  /** The amount charged, shipping and tax included. */
  total: string;
  shipping?: string;
  /** Masked: "Visa ending 4242". */
  paymentMethod?: string;
  address?: string;
  delivery?: string;
  url?: string;
  /** Booking, subscription or money transfer rather than an order of goods. */
  kind?: "order" | "booking" | "subscription" | "payment";
}

/** On a card that holds a purchase. `recorded`: the person said in their own words to go ahead without asking, so the
 * card is the receipt and was never waited on. */
export interface PurchaseCardField {
  purchase?: PurchaseSummary & { recorded?: true };
}

const MAX_ITEMS = 30;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A full card number (13 to 19 digits, spaces or dashes allowed) is cut to its last four. */
export function maskPaymentMethod(value: string): string {
  return value.replace(/\b(?:\d[ -]?){9,15}(\d{4})\b/gu, "•••• $1");
}

export function parsePurchaseSummary(value: unknown): { ok: true; value: PurchaseSummary } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "summary: give the order summary as an object." };
  const merchant = text(value.merchant, 120);
  const total = text(value.total, 60);
  if (!merchant) return { ok: false, error: "summary.merchant: name the shop or who is paid." };
  if (!total) return { ok: false, error: "summary.total: give the total charged, shipping and tax included, as the shop shows it." };
  const rawItems = Array.isArray(value.items) ? value.items : [];
  if (!rawItems.length) return { ok: false, error: "summary.items: list what is bought, each with name and quantity." };
  const items: PurchaseItem[] = [];
  for (const raw of rawItems.slice(0, MAX_ITEMS)) {
    if (!isRecord(raw)) return { ok: false, error: "summary.items: each item is {name, quantity, price?}." };
    const name = text(raw.name, 200);
    const quantity = raw.quantity === undefined ? 1 : raw.quantity;
    if (!name || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
      return { ok: false, error: "summary.items: each item needs a name and a whole-number quantity of at least 1." };
    }
    const price = text(raw.price, 60);
    items.push({ name, quantity, ...(price ? { price } : {}) });
  }
  const optional = (key: "shipping" | "delivery", max: number) => {
    const found = text(value[key], max);
    return found ? { [key]: found } : {};
  };
  const payment = text(value.payment_method ?? value.paymentMethod, 80);
  const address = text(value.address, 300);
  const url = text(value.url, 2_000);
  const kind = value.kind === "booking" || value.kind === "subscription" || value.kind === "payment" || value.kind === "order" ? value.kind : undefined;
  return {
    ok: true,
    value: {
      merchant, items, total,
      ...optional("shipping", 60),
      ...(payment ? { paymentMethod: maskPaymentMethod(payment) } : {}),
      ...(address ? { address } : {}),
      ...optional("delivery", 120),
      ...(url && /^https?:\/\//iu.test(url) ? { url } : {}),
      ...(kind ? { kind } : {}),
    },
  };
}

/** Words in an app tool's action that buy, book, subscribe or move money. */
const MONEY_WORDS = new Set([
  "PURCHASE", "BUY", "CHECKOUT", "ORDER", "ORDERS", "PAY", "PAYMENT", "PAYMENTS", "CHARGE", "PAYOUT", "TRANSFER",
  "BOOK", "BOOKING", "RESERVE", "RESERVATION", "SUBSCRIBE", "SUBSCRIPTION", "DONATE", "INVOICE_PAY", "CAPTURE",
]);
const MONEY_READS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "VIEW", "CHECK", "COUNT", "CANCEL", "REFUND", "UPDATE", "DELETE", "DRAFT"]);
const CREATES = new Set(["CREATE", "PLACE", "SUBMIT", "CONFIRM", "COMPLETE", "EXECUTE", "SEND", "MAKE", "NEW", "ADD", "START", "INITIATE", "PROCESS", "BUY", "PURCHASE", "PAY", "CHECKOUT", "BOOK", "RESERVE", "SUBSCRIBE", "CHARGE", "TRANSFER", "CAPTURE", "DONATE", "PAYOUT"]);

/** Does this app tool buy, book, subscribe or send money? Reads, refunds and cancellations do not. */
export function isPurchaseTool(slug: string): boolean {
  const name = slug.replace(/^mcp__(?:composio|own_apps)__/u, "");
  const action = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/u.test(name) ? name.slice(name.indexOf("_") + 1) : name;
  const tokens = action.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase().split(/[^A-Z0-9]+/u).filter(Boolean);
  if (!tokens.length || MONEY_READS.has(tokens[0]!)) return false;
  return tokens.some((token) => MONEY_WORDS.has(token)) && tokens.some((token) => CREATES.has(token));
}

/** A button or link whose words finish a purchase. Words a shop uses on its last step, in the languages madani bot ships. */
export const PURCHASE_BUTTON = /\b(?:place (?:your |my )?order|buy now|buy it now|complete (?:order|purchase|checkout|payment|booking)|confirm (?:and pay|order|purchase|payment|booking)|pay(?: now| securely| with| \$| €| £| ₹)?|submit (?:order|payment)|order now|checkout now|book now|reserve now|subscribe(?: now)?|start (?:subscription|membership)|send money|send payment|purchase|pagar|comprar(?: ahora)?|realizar pedido|finalizar (?:compra|pedido)|confirmar (?:compra|pedido|pago)|bezahlen|jetzt kaufen|kaufen|zahlungspflichtig bestellen|commander|payer|passer (?:la|ma) commande|acheter)\b|注文を確定|購入する|支払う|ऑर्डर करें|भुगतान करें/iu;

/** Words a button carries that only look like the last step: adding to a cart, going to checkout, saving a card. */
const NOT_YET = /\b(?:add to (?:cart|bag|basket)|go to (?:cart|checkout)|proceed to checkout|view cart|continue to (?:shipping|payment)|save (?:card|address)|apply|purchase (?:history|details|protection)|order (?:history|details|status)|buy (?:it )?again|subscribe to (?:our |the )?newsletter)\b/iu;

/** A page that is the last steps of a purchase, by its address or title. */
export const CHECKOUT_PAGE = /(?:checkout|\/buy\/|\/payment|\/pay\b|\/order[-_/]?review|place[-_]?order|\/purchase|\/billing|\/subscribe|\/booking|\/reserve|\/cart\/confirm|spc\b|gp\/buy)/iu;

/** Is clicking a control with this name a purchase's final step? `page` is the page's address and title. */
export function finishesPurchase(controlName: string, page: string): boolean {
  const name = controlName.trim();
  if (!name || NOT_YET.test(name)) return false;
  if (!PURCHASE_BUTTON.test(name)) return false;
  // "Pay" or "Subscribe" alone is common outside a checkout (a "Pay bills" menu, a newsletter): those need a checkout page.
  return /\b(?:place|buy|complete|confirm|submit|order now|checkout now|book now|reserve now|send money|send payment|purchase|comprar|pedido|kaufen|bestellen|commande|acheter)|注文|購入|ऑर्डर/iu.test(name) || CHECKOUT_PAGE.test(page);
}
