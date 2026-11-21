import type { BundleView, Catalog, DedicatedPricing, DesktopOption, LicenseOption, Region } from "../../../../shared/billing-api.ts";
import { quote } from "./pricing.ts";

export interface BillingConfig {
  currency: "USD"; yearlyDiscountPercent: number; graceDays: number; maxCloudsPerAccount: number; checkoutOpenMinutes: number; checkoutsPerHour: number;
  freeWorkUntil: number | null;
  licenses: Record<"solo" | "team", LicenseOption>;
  desktops: Record<"shared_s" | "shared_m" | "dedicated", DesktopOption>;
  dedicated: DedicatedPricing;
  poolQuotas: Record<"shared_s" | "shared_m", { netMbps: number; pids: number }>;
  /** a managed cloud's internet upload a calendar month (UTC), in GB: the owner is alerted, then it is slowed, then paused */
  egressGb: Record<"shared_s" | "shared_m" | "dedicated", { alert: number; steps: Array<{ gb: number; mbit: number }>; pause: number }>;
  appAllowances: Record<"shared_s" | "shared_m" | "dedicated", { computerHours: number; voiceCharacters: number }>;
  /** a free trial on a first cloud plan (MADANI_TRIAL_DAYS, 1 to 30); null sells every plan from the first day */
  trial: { days: number } | null;
  bundles: Array<Pick<BundleView, "id" | "label" | "cart" | "highlights">>;
  regions: Region[]; defaultRegion: string; poolRegions: string[]; products: Record<string, string>;
}

/**
 * MADANI_DODO_PRODUCTS is a JSON object mapping every key below to a dodo id (pricing.ts dodoCartKeys picks them per cart).
 * subscription products, the base line: plan_pro and plan_team (the whole plan at its full price, one line; extra team seats are addon_member),
 * then for carts that are not a plan: license_solo, license_team, desktop_shared_s, desktop_shared_m, desktop_dedicated.
 * add-ons: addon_member, addon_shared_s, addon_shared_m, addon_dedicated, addon_vcpu, addon_ram_gb, addon_disk_20gb.
 * each in :month and :year. base products and addons must match this config's prices; yearly prices include its yearly discount.
 */
export const DODO_PRODUCT_KEYS = ["plan_pro", "plan_team", "license_solo", "license_team", "desktop_shared_s", "desktop_shared_m", "desktop_dedicated",
  "addon_member", "addon_shared_s", "addon_shared_m", "addon_dedicated", "addon_vcpu", "addon_ram_gb", "addon_disk_20gb"]
  .flatMap(key => [`${key}:month`, `${key}:year`]);
/** keys a cart may need that MADANI_DODO_PRODUCTS lacks: any cart needing one answers 503 unavailable */
export function missingDodoProducts(products: Record<string, string>): string[] { return DODO_PRODUCT_KEYS.filter(key => !products[key]); }
export function dodoProducts(env: Record<string, string | undefined>): Record<string, string> {
  if (!env.MADANI_DODO_PRODUCTS) return {};
  const value: unknown = JSON.parse(env.MADANI_DODO_PRODUCTS);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(id => typeof id !== "string" || !id.trim())) throw new Error("Invalid MADANI_DODO_PRODUCTS.");
  return value as Record<string, string>;
}

export function trialConfig(value: string | undefined): BillingConfig["trial"] {
  const days = Number(value);
  return value && Number.isInteger(days) && days >= 1 && days <= 30 ? { days } : null;
}

function freeWorkUntil(value: string | undefined) {
  if (value === "off") return null;
  if (value && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return Date.UTC(2026, 11, 1);
}

export const BILLING_CONFIG: BillingConfig = {
  // yearly is two months free: 12 months for the price of 10
  currency: "USD", yearlyDiscountPercent: 100 / 6, graceDays: 30, maxCloudsPerAccount: 5, checkoutOpenMinutes: 30, checkoutsPerHour: 30,
  freeWorkUntil: freeWorkUntil(process.env.MADANI_FREE_WORK_UNTIL),
  licenses: {
    solo: { kind: "solo", label: "Work license", monthlyCents: 1200, includedMembers: 1, extraMemberCents: null, maxMembers: 1, priority: false },
    team: { kind: "team", label: "Team license", monthlyCents: 3000, includedMembers: 2, extraMemberCents: 2000, maxMembers: 50, priority: false },
  },
  desktops: {
    shared_s: { kind: "shared_s", label: "Plus", placement: "pool", monthlyCents: 2000, machine: { vcpu: 2, ramGb: 4, diskGb: 20 }, botComputers: 2, priority: false },
    shared_m: { kind: "shared_m", label: "Pro", placement: "pool", monthlyCents: 3800, machine: { vcpu: 4, ramGb: 8, diskGb: 60 }, botComputers: 5, priority: true },
    dedicated: { kind: "dedicated", label: "Dedicated", placement: "dedicated", monthlyCents: null, machine: { vcpu: 8, ramGb: 16, diskGb: 160 }, botComputers: null, priority: true },
  },
  // the sizes and the disk ceiling an InstaBox pro workspace can create (8/16, 200 GB a machine); the team bundle's
  // 8/16/160 comes to $89: 7 + 8 x 4 + 16 x 2 + 6 x 3, so with the $30 team license it is $119 a month and $1190 a year
  dedicated: { baseCents: 700, perVcpuCents: 400, perGbRamCents: 200, per20GbDiskCents: 300, includedDiskGb: 40,
    vcpu: { min: 2, max: 8, step: 2 }, ramGb: { min: 4, max: 16, step: 4 }, diskGb: { min: 40, max: 200, step: 20 },
    sizes: [{ vcpu: 2, ramGb: 4 }, { vcpu: 4, ramGb: 8 }, { vcpu: 8, ramGb: 16 }] },
  poolQuotas: { shared_s: { netMbps: 100, pids: 2048 }, shared_m: { netMbps: 250, pids: 4096 } },
  // InstaBox bills upload past the workspace's shared 1 TB at $0.02/GB and a machine can send 400+ Mbit/s (100+ TB a month):
  // chat, browsing, connectors and updates send a few GB a month, so these only ever meet a proxy, a file host or a loop.
  // full speed up to the first step, then a little slower at each one, then the pause; pro about twice plus, team four times
  egressGb: {
    shared_s: { alert: 30, steps: [{ gb: 40, mbit: 200 }, { gb: 55, mbit: 100 }, { gb: 70, mbit: 50 }, { gb: 90, mbit: 25 }], pause: 100 },
    shared_m: { alert: 60, steps: [{ gb: 80, mbit: 200 }, { gb: 110, mbit: 100 }, { gb: 140, mbit: 50 }, { gb: 180, mbit: 25 }], pause: 200 },
    dedicated: { alert: 120, steps: [{ gb: 160, mbit: 200 }, { gb: 220, mbit: 100 }, { gb: 280, mbit: 50 }, { gb: 360, mbit: 25 }], pause: 400 },
  },
  appAllowances: { shared_s: { computerHours: 720, voiceCharacters: 0 }, shared_m: { computerHours: 720, voiceCharacters: 0 }, dedicated: { computerHours: 720, voiceCharacters: 0 } },
  trial: null,
  // free $0, plus $20 (a cloud machine), pro $50 (a bigger one and a work license for one person), team $119; the starter id sells as Plus
  bundles: [
    { id: "free", label: "Free", cart: { license: { kind: "none" }, desktop: { kind: "none" } }, highlights: ["Your bots, on your computer", "Personal use", "No subscription"] },
    { id: "starter", label: "Plus", cart: { license: { kind: "none" }, desktop: { kind: "shared_s", region: "fsn1" } }, highlights: ["Your bots work in madani cloud", "2 vCPU, 4 GB RAM, 20 GB disk", "Always available, wakes in seconds"] },
    { id: "pro", label: "Pro", cart: { license: { kind: "solo" }, desktop: { kind: "shared_m", region: "fsn1" } }, highlights: ["4 vCPU, 8 GB RAM, 60 GB disk", "Always available, priority wake", "Work license for one person"] },
    { id: "team", label: "Team", cart: { license: { kind: "team", members: 2 }, desktop: { kind: "dedicated", region: "fsn1", spec: { vcpu: 8, ramGb: 16, diskGb: 160 } } }, highlights: ["Dedicated 8 vCPU, 16 GB RAM, 160 GB disk", "Always available, priority wake", "Team license, 2 seats"] },
  ],
  regions: [{ id: "fsn1", label: "Falkenstein", country: "DE" }, { id: "nbg1", label: "Nuremberg", country: "DE" }, { id: "hel1", label: "Helsinki", country: "FI" }, { id: "ash", label: "Ashburn", country: "US" }, { id: "hil", label: "Hillsboro", country: "US" }, { id: "sin", label: "Singapore", country: "SG" }],
  defaultRegion: "fsn1", poolRegions: ["fsn1"],
  products: dodoProducts(process.env),
};

/** the managed backend (InstaBox) runs every machine in AWS us-west-2 and has no region choice */
export const MANAGED_REGION: Region = { id: "us-west-2", label: "Oregon", country: "US" };

/** with every desktop kind on the managed backend, its one real region is the only one offered */
export function managedRegionConfig(config: BillingConfig): BillingConfig {
  const id = MANAGED_REGION.id;
  return { ...config, regions: [MANAGED_REGION], defaultRegion: id, poolRegions: [id],
    bundles: config.bundles.map(bundle => bundle.cart.desktop.kind === "none" ? bundle : { ...bundle, cart: { ...bundle.cart, desktop: { ...bundle.cart.desktop, region: id } } }) };
}

/** a region's label for any region a cloud may be stored with */
export function regionLabel(id: string, config: BillingConfig = BILLING_CONFIG): string | null {
  return [...config.regions, MANAGED_REGION].find(region => region.id === id)?.label ?? null;
}

export function catalogView(now: number, config: BillingConfig = BILLING_CONFIG): Catalog {
  return structuredClone({ v: 1, currency: config.currency, bundles: config.bundles.map(bundle => ({ ...bundle,
    monthlyCents: quote({ ...bundle.cart, interval: "month" }, config).totalCents,
    yearlyMonthlyCents: quote({ ...bundle.cart, interval: "year" }, config).monthlyEquivalentCents })),
  licenses: Object.values(config.licenses), desktops: Object.values(config.desktops), dedicated: config.dedicated, regions: config.regions, poolRegions: config.poolRegions,
  defaultRegion: config.defaultRegion, yearlyDiscountPercent: config.yearlyDiscountPercent,
  freeWorkUntil: config.freeWorkUntil !== null && now < config.freeWorkUntil ? config.freeWorkUntil : null, graceDays: config.graceDays });
}
