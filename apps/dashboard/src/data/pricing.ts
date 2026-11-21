import type { Bundle, BillingInterval, CustomPricing, DesktopTier, LicenseTier, MachineSpec, PlanCatalog, Selection } from "./contracts";

export function sizedMonthly(spec: MachineSpec, p: CustomPricing): number {
  return Math.round(p.base + spec.vcpu * p.perVcpu + spec.ramGb * p.perGbRam + (Math.max(0, spec.diskGb - (p.includedDiskGb ?? 0)) / 20) * p.per20GbDisk);
}

export const licenseOf = (c: PlanCatalog, id: string): LicenseTier | null => c.licenses.find((l) => l.id === id) ?? null;
export const desktopOf = (c: PlanCatalog, id: string): DesktopTier | null => c.desktops.find((d) => d.id === id) ?? null;
export const bundleOf = (c: PlanCatalog, id: string): Bundle | null => c.bundles.find((b) => b.id === id) ?? null;

export function licenseMonthly(l: LicenseTier, members: number): number {
  return l.monthly + Math.max(0, members - l.includedMembers) * l.perExtraMember;
}

export function desktopMonthly(d: DesktopTier, size: MachineSpec | null, p: CustomPricing): number {
  return d.sizable && size ? Math.max(d.monthly, sizedMonthly(size, p)) : d.monthly;
}

export const yearly = (monthly: number, c: Pick<PlanCatalog, "yearlyDiscount">) => monthly * (1 - c.yearlyDiscount);

/** a monthly list price as it reads per month on the chosen interval; the catalog only lists monthly prices */
export const perMonthOn = (monthly: number, interval: BillingInterval, c: Pick<PlanCatalog, "yearlyDiscount">) => (interval === "year" ? yearly(monthly, c) : monthly);

export interface CartLine { key: string; label: string; detail: string; monthly: number }

export interface Cart {
  lines: CartLine[];
  /** monthly list price of everything */
  subtotal: number;
  /** a bundle that matches the selection exactly: what it saves per month */
  bundle: Bundle | null;
  bundleSaving: number;
  /** per month, after the yearly discount when yearly */
  discount: number;
  perMonth: number;
  /** what one billing period charges */
  dueNow: number;
  free: boolean;
}

export function matchBundle(sel: Selection, c: PlanCatalog): Bundle | null {
  return c.bundles.find((b) => b.license === sel.license && b.desktop === sel.desktop && (b.license !== "team" || sel.members >= b.members) && (!sel.size || sel.desktop !== "dedicated")) ?? null;
}

export function priceCart(sel: Selection, c: PlanCatalog): Cart {
  const lines: CartLine[] = [];
  const lic = licenseOf(c, sel.license);
  if (lic && lic.monthly > 0) {
    const extra = Math.max(0, sel.members - lic.includedMembers);
    lines.push({ key: "license", label: `${lic.name} license`, detail: `${sel.members} ${sel.members === 1 ? "member" : "members"}${extra ? `, ${extra} extra` : ""}`, monthly: licenseMonthly(lic, sel.members) });
  }
  const desk = sel.desktop === "none" ? null : desktopOf(c, sel.desktop);
  if (desk) {
    const spec = desk.sizable && sel.size ? sel.size : desk;
    lines.push({ key: "desktop", label: `madani cloud, ${desk.name}`, detail: specLine(spec), monthly: desktopMonthly(desk, sel.size, c.custom) });
  }
  const subtotal = lines.reduce((n, l) => n + l.monthly, 0);
  const bundle = matchBundle(sel, c);
  let bundleSaving = 0;
  if (bundle && bundle.monthly > 0) {
    const extras = lic ? Math.max(0, sel.members - Math.max(bundle.members, lic.includedMembers)) * lic.perExtraMember : 0;
    bundleSaving = Math.max(0, subtotal - (bundle.monthly + extras));
  }
  const afterBundle = subtotal - bundleSaving;
  const discount = sel.interval === "year" ? afterBundle * c.yearlyDiscount : 0;
  const perMonth = afterBundle - discount;
  return { lines, subtotal, bundle, bundleSaving, discount, perMonth, dueNow: sel.interval === "year" ? perMonth * 12 : perMonth, free: subtotal === 0 };
}

export function dollars(n: number, cents = false): string {
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  const fixed = whole && !cents ? 0 : 2;
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: fixed, maximumFractionDigits: fixed })}`;
}

export const gb = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(1)} tb` : `${n} gb`);
export const specLine = (s: MachineSpec) => `${s.vcpu} vcpu · ${gb(s.ramGb)} ram · ${gb(s.diskGb)} disk`;
/** a plan in one line: its machine, then priority wake and a work license when it has them */
export const planSpecLine = (s: MachineSpec & { priority: boolean }, work = false) => `${specLine(s)}${s.priority ? ", priority wake" : ""}${work ? ", work license" : ""}`;

/** how the yearly saving reads: "2 months free" when it is exactly that, else a percent */
export const yearlyPerk = (c: Pick<PlanCatalog, "yearlyDiscount">) => (Math.abs(c.yearlyDiscount * 12 - 2) < 0.05 ? "2 months free" : `-${Math.round(c.yearlyDiscount * 100)}%`);

/** a measured wake as it reads on a card: one decimal under 10 s, never "0.0" */
export const wakeSeconds = (medianMs: number): string => (Math.max(100, medianMs) / 1000).toFixed(medianMs < 9_950 ? 1 : 0);

/** what the whole plan costs a period once the cloud is this size, license and all, as the plans page prices it */
export function planTotal(catalog: PlanCatalog, selection: Selection) {
  const cart = priceCart(selection, catalog);
  const year = selection.interval === "year", n = year ? cart.dueNow : cart.perMonth;
  const license = selection.license !== "personal" ? licenseOf(catalog, selection.license) : null;
  return { amount: dollars(n, !Number.isInteger(Math.round(n * 100) / 100)), unit: year ? "/yr" : "/mo", note: license ? `with your ${license.name.toLowerCase()} license` : "cloud size only" };
}
