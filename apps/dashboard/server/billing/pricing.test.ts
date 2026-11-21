import { describe, expect, it } from "vitest";
import type { Cart } from "../../../../shared/billing-api.ts";
import { BILLING_CONFIG as config, catalogView, DODO_PRODUCT_KEYS, dodoProducts, managedRegionConfig, missingDodoProducts } from "./plans.ts";
import { DEFAULT_RETENTION_DAYS } from "../../../cloud-service/src/retention.ts";
import { changeTiming, dedicatedMonthlyCents, dodoCart, dodoCartKeys, parseCart, quote } from "./pricing.ts";

const preset = (index: number, interval: Cart["interval"] = "month"): Cart => ({ ...structuredClone(config.bundles[index].cart), interval });
const products = Object.fromEntries(["month", "year"].flatMap(interval => ["plan_pro", "plan_team", "license_solo", "license_team", "desktop_shared_s", "desktop_shared_m", "desktop_dedicated", "addon_member", "addon_shared_s", "addon_shared_m", "addon_dedicated", "addon_vcpu", "addon_ram_gb", "addon_disk_20gb"].map(key => [`${key}:${interval}`, `${key}_${interval}`])));

describe("billing pricing", () => {
  it("offers only the managed backend's real region when it runs every desktop kind", () => {
    const managed = managedRegionConfig(config), catalog = catalogView(0, managed);
    expect(catalog.regions).toEqual([{ id: "us-west-2", label: "Oregon", country: "US" }]);
    expect(catalog.poolRegions).toEqual(["us-west-2"]);
    expect(catalog.bundles.find(bundle => bundle.id === "team")!.monthlyCents).toBe(11900);
    for (const bundle of managed.bundles.filter(item => item.cart.desktop.kind !== "none")) expect(parseCart({ ...bundle.cart, interval: "month" }, managed)).not.toBeNull();
    expect(parseCart({ ...structuredClone(config.bundles[1]!.cart), interval: "month" }, managed)).toBeNull();
  });

  it("keeps an ended cloud desktop as long as a managed one: 30 days", () => {
    expect(config.graceDays).toBe(30);
    expect(config.graceDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(catalogView(Date.now(), config).graceDays).toBe(30);
  });

  it("quotes every preset monthly and yearly from one catalog", () => {
    const monthly = [0, config.desktops.shared_s.monthlyCents!, config.licenses.solo.monthlyCents + config.desktops.shared_m.monthlyCents!, config.licenses.team.monthlyCents + dedicatedMonthlyCents(preset(3).desktop.spec!, config)];
    const yearlyMonthly = monthly.map(cents => Math.round((cents * 12 - Math.round(cents * 12 * config.yearlyDiscountPercent / 100)) / 12));
    expect(config.bundles.map((_, index) => quote(preset(index), config).totalCents)).toEqual(monthly);
    expect(config.bundles.map((_, index) => quote(preset(index, "year"), config).monthlyEquivalentCents)).toEqual(yearlyMonthly);
    expect(config.bundles.map((_, index) => quote(preset(index), config).bundle)).toEqual(["free", "starter", "pro", "team"]);
    expect(catalogView(0).bundles.map(bundle => bundle.monthlyCents)).toEqual(monthly);
    // the prices people see: free $0, plus $20, pro $50, team $119; a year is two months free
    expect(monthly).toEqual([0, 2000, 5000, 11900]);
    expect(config.bundles.map((_, index) => quote(preset(index, "year"), config).totalCents)).toEqual([0, 20000, 50000, 119000]);
    expect(catalogView(Date.UTC(2030, 0, 1)).freeWorkUntil).toBeNull();
  });
  it("quotes the live team cart with separate annual line items and discount", () => {
    const result = quote({ interval: "year", license: { kind: "team", members: 5 }, desktop: { kind: "shared_m", region: "fsn1" } }, config);
    const license = config.licenses.team, desktop = config.desktops.shared_m;
    const extraMembers = result.members - license.includedMembers;
    const subtotal = (license.monthlyCents + extraMembers * license.extraMemberCents! + desktop.monthlyCents!) * 12;
    const discount = Math.round(subtotal * config.yearlyDiscountPercent / 100);
    expect(result.lines).toEqual([
      { kind: "license", label: `${license.label}, ${license.includedMembers} members`, amountCents: license.monthlyCents * 12 },
      { kind: "members", label: `${extraMembers} extra members`, amountCents: extraMembers * license.extraMemberCents! * 12 },
      { kind: "desktop", label: `madani cloud ${desktop.label.toLowerCase()}`, amountCents: desktop.monthlyCents! * 12 },
      { kind: "discount", label: "Yearly, 2 months free", amountCents: -discount },
    ]);
    expect(result).toMatchObject({ totalCents: subtotal - discount, monthlyEquivalentCents: Math.round((subtotal - discount) / 12), members: 5, bundle: null, botComputers: 5, machine: { vcpu: 4, ramGb: 8, diskGb: 60 } });
  });
  it("prices and validates dedicated units, ranges and steps", () => {
    expect(dedicatedMonthlyCents({ vcpu: 8, ramGb: 16, diskGb: 160 }, config)).toBe(8900);
    expect(dedicatedMonthlyCents({ vcpu: 2, ramGb: 4, diskGb: 40 }, config)).toBe(2300);
    expect(dedicatedMonthlyCents({ vcpu: 8, ramGb: 16, diskGb: 200 }, config)).toBe(9500);
    for (const spec of [{ vcpu: 2, ramGb: 4, diskGb: 40 }, { vcpu: 4, ramGb: 8, diskGb: 120 }, { vcpu: 8, ramGb: 16, diskGb: 200 }]) expect(parseCart({ ...preset(3), desktop: { kind: "dedicated", region: "sin", spec } }, config)).not.toBeNull();
    for (const spec of [{ vcpu: 3, ramGb: 16, diskGb: 160 }, { vcpu: 34, ramGb: 16, diskGb: 160 }, { vcpu: 8, ramGb: 6, diskGb: 160 }, { vcpu: 8, ramGb: 68, diskGb: 160 }, { vcpu: 8, ramGb: 16, diskGb: 45 }, { vcpu: 8, ramGb: 16, diskGb: 50 }, { vcpu: 8, ramGb: 16, diskGb: 220 }, { vcpu: 16, ramGb: 32, diskGb: 160 }]) expect(parseCart({ ...preset(3), desktop: { kind: "dedicated", region: "fsn1", spec } }, config)).toBeNull();
    // only the sizes the provider makes: an odd shape would be billed as the next size up
    for (const spec of [{ vcpu: 2, ramGb: 16, diskGb: 40 }, { vcpu: 6, ramGb: 12, diskGb: 40 }, { vcpu: 8, ramGb: 8, diskGb: 40 }, { vcpu: 4, ramGb: 4, diskGb: 40 }]) expect(parseCart({ ...preset(3), desktop: { kind: "dedicated", region: "fsn1", spec } }, config)).toBeNull();
  });
  it("sells each plan as one product at its full price, and a custom cart as a base plus add-ons that add up to the quote", () => {
    for (const [interval, months] of [["month", 1], ["year", 10]] as const) {
      expect(dodoCartKeys(preset(2, interval))).toEqual([{ key: `plan_pro:${interval}`, quantity: 1 }]);
      expect(dodoCartKeys(preset(3, interval))).toEqual([{ key: `plan_team:${interval}`, quantity: 1 }]);
      expect(dodoCartKeys(preset(1, interval))).toEqual([{ key: `desktop_shared_s:${interval}`, quantity: 1 }]);
      expect(quote(preset(2, interval), config).totalCents).toBe(5000 * months);
      expect(quote(preset(3, interval), config).totalCents).toBe(11900 * months);
    }
    // a team plan with more seats: still the one plan line, only the extra seats are a quantity
    expect(dodoCartKeys({ ...preset(3), license: { kind: "team", members: 5 } })).toEqual([{ key: "plan_team:month", quantity: 1 }, { key: "addon_member:month", quantity: 3 }]);
    const unit = { license_team: config.licenses.team.monthlyCents, addon_dedicated: config.dedicated.baseCents, addon_vcpu: config.dedicated.perVcpuCents, addon_ram_gb: config.dedicated.perGbRamCents, addon_disk_20gb: config.dedicated.per20GbDiskCents } as Record<string, number>;
    const custom = { ...preset(3), desktop: { kind: "dedicated" as const, region: "fsn1", spec: { vcpu: 4, ramGb: 8, diskGb: 100 } } };
    expect(dodoCartKeys(custom)[0].key).toBe("license_team:month");
    expect(dodoCartKeys(custom).reduce((sum, { key, quantity }) => sum + unit[key.split(":")[0]] * quantity, 0)).toBe(quote(custom, config).totalCents);
  });
  it("rejects malformed carts and normalizes solo members", () => {
    for (const cart of [null, {}, { ...preset(1), interval: "week" }, { ...preset(1), license: { kind: "bad" } }, { ...preset(1), license: { kind: "team", members: config.licenses.team.includedMembers - 1 } }, { ...preset(1), license: { kind: "team", members: 51 } }, { ...preset(1), license: { kind: "team", members: 3.5 } }, { ...preset(1), license: { kind: "solo", members: 2 } }, { ...preset(1), desktop: { kind: "shared_s", region: "sin" } }, { ...preset(1), desktop: { kind: "shared_s", region: "missing" } }, { ...preset(1), desktop: { kind: "shared_s", region: "fsn1", spec: {} } }, { ...preset(1), desktop: { kind: "none", spec: {} } }, { ...preset(1), unexpected: true }]) expect(parseCart(cart, config)).toBeNull();
    expect(parseCart({ ...preset(1), license: { kind: "solo", members: 1 } }, config)).toEqual({ ...preset(1), license: { kind: "solo" } });
    expect(parseCart({ ...preset(1), license: { kind: "team", members: config.licenses.team.includedMembers } }, config)).not.toBeNull();
    expect(quote({ interval: "month", license: { kind: "none" }, desktop: { kind: "shared_s", region: "fsn1" } }).members).toBe(0);
  });
  it("maps license bases, desktop bases and dedicated units", () => {
    expect(dodoCart(preset(1), products)).toEqual([{ productId: "desktop_shared_s_month", quantity: 1, addons: [] }]);
    expect(dodoCart({ ...preset(1), license: { kind: "solo" } }, products)).toEqual([{ productId: "license_solo_month", quantity: 1, addons: [{ addonId: "addon_shared_s_month", quantity: 1 }] }]);
    expect(dodoCart({ ...preset(2), license: { kind: "none" } }, products)).toEqual([{ productId: "desktop_shared_m_month", quantity: 1, addons: [] }]);
    const addons = [{ addonId: "addon_vcpu_year", quantity: 8 }, { addonId: "addon_ram_gb_year", quantity: 16 }, { addonId: "addon_disk_20gb_year", quantity: 6 }];
    expect(dodoCart(preset(3, "year"), products)).toEqual([{ productId: "plan_team_year", quantity: 1, addons: [] }]);
    expect(dodoCart(preset(2), products)).toEqual([{ productId: "plan_pro_month", quantity: 1, addons: [] }]);
    expect(dodoCart({ ...preset(3, "year"), desktop: { kind: "dedicated", region: "fsn1", spec: { vcpu: 8, ramGb: 16, diskGb: 160 } }, license: { kind: "solo" } }, products)![0].productId).toBe("license_solo_year");
    expect(dodoCart({ ...preset(3, "year"), license: { kind: "none" } }, products)).toEqual([{ productId: "desktop_dedicated_year", quantity: 1, addons }]);
    expect(dodoCart({ ...preset(3), license: { kind: "team", members: 5 } }, products)![0].addons[0]).toEqual({ addonId: "addon_member_month", quantity: 5 - config.licenses.team.includedMembers });
    const minimum = { ...preset(3), desktop: { kind: "dedicated" as const, region: "fsn1", spec: { vcpu: 2, ramGb: 4, diskGb: 40 } } };
    expect(dodoCart(minimum, products)![0].addons).not.toContainEqual(expect.objectContaining({ addonId: "addon_disk_20gb_month" }));
    expect(dodoCart(preset(1), {})).toBeNull(); expect(dodoCart({ ...preset(1), license: { kind: "solo" } }, { "license_solo:month": "solo" })).toBeNull();
    expect(dodoCartKeys(minimum).map(({ key }) => key)).toEqual(["license_team:month", "addon_dedicated:month", "addon_vcpu:month", "addon_ram_gb:month"]);
    // every key any cart can ask for is one the config documents, so a complete MADANI_DODO_PRODUCTS never answers 503
    for (const interval of ["month", "year"] as const) for (const license of [{ kind: "none" as const }, { kind: "solo" as const }, { kind: "team" as const, members: 3 }])
      for (const desktop of [{ kind: "none" as const }, { kind: "shared_s" as const, region: "fsn1" }, { kind: "shared_m" as const, region: "fsn1" }, { kind: "dedicated" as const, region: "fsn1", spec: { vcpu: 8, ramGb: 16, diskGb: 160 } }])
        for (const { key } of dodoCartKeys({ interval, license, desktop })) expect(DODO_PRODUCT_KEYS).toContain(key);
    expect(missingDodoProducts(Object.fromEntries(DODO_PRODUCT_KEYS.map(key => [key, "id"])))).toEqual([]);
    expect(missingDodoProducts({ "license_solo:month": "id" })).toHaveLength(DODO_PRODUCT_KEYS.length - 1);
  });
  it("times plan changes: a trial is free, bigger starts now, smaller and yearly to monthly wait; and validates product configuration", () => {
    const [, plus, pro, team] = config.bundles.map(bundle => ({ ...structuredClone(bundle.cart), interval: "month" as const }));
    const year = <T extends { interval: string }>(cart: T) => ({ ...cart, interval: "year" as const });
    expect(changeTiming(plus!, pro!, true)).toEqual({ timing: "trial", mode: "trial" });
    expect(changeTiming(pro!, plus!, true)).toEqual({ timing: "trial", mode: "trial" });
    expect(changeTiming(plus!, pro!, false)).toEqual({ timing: "now", mode: "keep_cycle" });
    expect(changeTiming(plus!, team!, false)).toEqual({ timing: "now", mode: "keep_cycle" });
    expect(changeTiming(pro!, plus!, false)).toEqual({ timing: "scheduled", mode: "scheduled" });
    expect(changeTiming(team!, pro!, false)).toEqual({ timing: "scheduled", mode: "scheduled" });
    expect(changeTiming(pro!, year(pro!), false)).toEqual({ timing: "now", mode: "new_cycle" });
    expect(changeTiming(plus!, year(pro!), false)).toEqual({ timing: "now", mode: "new_cycle" });
    expect(changeTiming(year(pro!), pro!, false)).toEqual({ timing: "scheduled", mode: "scheduled" });
    expect(changeTiming(year(plus!), pro!, false)).toEqual({ timing: "now", mode: "new_cycle" });
    expect(changeTiming(pro!, year(plus!), false)).toEqual({ timing: "scheduled", mode: "scheduled" });
    expect(dodoProducts({ MADANI_DODO_PRODUCTS: '{"license_solo:month":"p1"}' })).toEqual({ "license_solo:month": "p1" });
    expect(() => dodoProducts({ MADANI_DODO_PRODUCTS: '{"bad":1}' })).toThrow();
  });
});
