export const KPI_IDS = ["trials", "trial to paid", "active trials", "cancelling", "trial mrr", "received", "visitors", "signups"] as const;
export type KpiId = (typeof KPI_IDS)[number];

export const TINTS = ["none", "green", "blue", "orange", "purple", "yellow"] as const;
export type Tint = (typeof TINTS)[number];

export const TINT_STYLE: Record<Exclude<Tint, "none">, { label: string; wash: string; ink: string; accent: string }> = {
  green: { label: "green", wash: "var(--wash-lime)", ink: "var(--money-ink)", accent: "var(--viz-new)" },
  blue: { label: "blue", wash: "var(--wash-sky)", ink: "color-mix(in oklab, var(--viz-visitors) 75%, var(--ink))", accent: "var(--viz-visitors)" },
  orange: { label: "coral", wash: "var(--wash-pink)", ink: "var(--coral-deep)", accent: "var(--coral)" },
  purple: { label: "purple", wash: "var(--wash-lilac)", ink: "color-mix(in oklab, var(--viz-renewal) 72%, var(--ink))", accent: "var(--viz-renewal)" },
  yellow: { label: "yellow", wash: "var(--wash-lemon)", ink: "var(--warn)", accent: "var(--warn)" },
};

export const DEFAULT_TINTS: Partial<Record<KpiId, Tint>> = { trials: "green" };

/** the cards the chart can draw as its main bars; visitors and signups already have their own line and dots */
export const CHARTED = ["trials"] as const satisfies readonly KpiId[];
export type ChartedId = (typeof CHARTED)[number];
const isCharted = (id: KpiId): id is ChartedId => (CHARTED as readonly string[]).includes(id);
/** the chart's main series: the first green card it can draw, in the strip's order */
export const mainOf = (layout: KpiLayout): ChartedId | null => layout.order.filter(isCharted).find((id) => tintOf(layout, id) === "green") ?? null;

export interface KpiLayout { order: KpiId[]; tints: Partial<Record<KpiId, Tint>> }
export const KPI_KEY = "madani-admin-kpis";

const isId = (v: unknown): v is KpiId => typeof v === "string" && (KPI_IDS as readonly string[]).includes(v);
const isTint = (v: unknown): v is Tint => typeof v === "string" && (TINTS as readonly string[]).includes(v);

export function normalOrder(order: unknown): KpiId[] {
  const kept = Array.isArray(order) ? [...new Set(order.filter(isId))] : [];
  for (const id of KPI_IDS) if (!kept.includes(id)) kept.push(id);
  return kept;
}

export const tintOf = (layout: KpiLayout, id: KpiId): Tint => layout.tints[id] ?? DEFAULT_TINTS[id] ?? "none";

export function loadLayout(store: Pick<Storage, "getItem"> | null = safeStorage()): KpiLayout {
  let raw: { order?: unknown; tints?: unknown } | null = null;
  try { raw = JSON.parse(store?.getItem(KPI_KEY) ?? "null"); } catch { raw = null; }
  const tints: KpiLayout["tints"] = {};
  if (raw?.tints && typeof raw.tints === "object") for (const [id, tint] of Object.entries(raw.tints)) if (isId(id) && isTint(tint)) tints[id] = tint;
  return { order: normalOrder(raw?.order), tints };
}

export function saveLayout(layout: KpiLayout, store: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()) {
  const tints = Object.fromEntries(Object.entries(layout.tints).filter(([id, tint]) => tint !== (DEFAULT_TINTS[id as KpiId] ?? "none")));
  const plain = layout.order.every((id, i) => id === KPI_IDS[i]) && !Object.keys(tints).length;
  try { if (plain) store?.removeItem(KPI_KEY); else store?.setItem(KPI_KEY, JSON.stringify({ order: layout.order, tints })); } catch { /* private mode keeps the default */ }
}

export function moveTo(order: KpiId[], id: KpiId, index: number): KpiId[] {
  const from = order.indexOf(id);
  const to = Math.max(0, Math.min(order.length - 1, index));
  if (from < 0 || from === to) return order;
  const next = order.filter((x) => x !== id);
  next.splice(to, 0, id);
  return next;
}

export function slotAt(boxes: Array<{ left: number; top: number; width: number; height: number }>, x: number, y: number): number | null {
  const i = boxes.findIndex((b) => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height);
  return i < 0 ? null : i;
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
