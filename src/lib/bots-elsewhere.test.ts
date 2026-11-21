import { describe, expect, it } from "vitest";
import { beforeEach, vi } from "vitest";
import { choosePlacesHere, dismissKey, elsewhereCovered, macEmptyFrom, parseBotCounts, elsewhereScreen, emptyHere, parseElsewhereView, SIMULATED_FRESH_INSTALL } from "./bots-elsewhere";

const VPS = { id: "srv", name: "my-vps", why: "moved" as const };
const TEAM = { id: "team", name: "Studio", why: "team" as const };

const memoryStorage = () => { const kept = new Map<string, string>(); return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, String(value)); }, removeItem: (key: string) => { kept.delete(key); }, clear: () => kept.clear() }; };

describe("bots elsewhere", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", memoryStorage()); });

  it("offers the places only until the person has picked where to open once", () => {
    const view = { places: [VPS], known: null };
    expect(elsewhereScreen({ view, empty: true, dismissed: [] })?.kind).toBe("bots-on");
    expect(elsewhereScreen({ view: { ...view, chosen: true }, empty: true, dismissed: [] })).toBeNull();
    expect(elsewhereScreen({ view: { ...SIMULATED_FRESH_INSTALL, chosen: true }, empty: true, dismissed: [] })).toBeNull();
    choosePlacesHere();
    expect(elsewhereScreen({ view, empty: true, dismissed: [] })).toBeNull();
  });

  it("an empty page by choice names where the bots are, for its empty state", () => {
    const view = { places: [VPS, TEAM], known: null, chosen: true };
    expect(macEmptyFrom({ view, empty: true, screen: null })).toEqual(VPS);
    expect(macEmptyFrom({ view, empty: false, screen: null })).toBeNull();
    expect(macEmptyFrom({ view, empty: true, screen: { kind: "bots-on", place: VPS, others: [] } })).toBeNull();
    expect(macEmptyFrom({ view: { places: [], known: null }, empty: true, screen: null })).toBeNull();
  });

  it("counts only the person's own bots: Madani and bots off the sidebar leave a place empty", () => {
    expect(emptyHere([])).toBe(true);
    expect(emptyHere([{ defaultBot: { person: "" } }, { hidden: true }])).toBe(true);
    expect(emptyHere([{ defaultBot: { person: "" } }, {}])).toBe(false);
  });

  it("an empty page with bots elsewhere names the likeliest place, never a blank first run", () => {
    const view = { places: [VPS, TEAM], known: null };
    expect(elsewhereScreen({ view, empty: true, dismissed: [] })).toEqual({ kind: "bots-on", place: VPS, others: [TEAM] });
    expect(elsewhereScreen({ view, empty: false, dismissed: [] })).toBeNull();
    expect(elsewhereScreen({ view: null, empty: true, dismissed: [] })).toBeNull();
    expect(elsewhereScreen({ view: { places: [], known: null }, empty: true, dismissed: [] })).toBeNull();
  });

  it("a fresh install whose account set up elsewhere offers to connect, until the person starts here instead", () => {
    const screen = elsewhereScreen({ view: SIMULATED_FRESH_INSTALL, empty: true, dismissed: [] });
    expect(screen).toEqual({ kind: "set-up-on", setup: { kind: "server", name: "My VPS" } });
    expect(elsewhereScreen({ view: SIMULATED_FRESH_INSTALL, empty: true, dismissed: [dismissKey(screen!)] })).toBeNull();
    const bots = elsewhereScreen({ view: { places: [VPS], known: null }, empty: true, dismissed: [] })!;
    expect(elsewhereScreen({ view: { places: [VPS], known: null }, empty: true, dismissed: [dismissKey(bots)] })).toBeNull();
    expect(elsewhereScreen({ view: { places: [TEAM], known: null }, empty: true, dismissed: [dismissKey(bots)] })?.kind).toBe("bots-on");
  });

  it("takes only well-formed places from main", () => {
    expect(parseElsewhereView({ places: [VPS, { id: 1 }, { id: "x", name: " ", why: "server" }, { id: "y", name: "Y", why: "moon" }], known: { kind: "phone", name: "x" } }))
      .toEqual({ places: [VPS], known: null, chosen: false });
    expect(parseElsewhereView(null)).toEqual({ places: [], known: null, chosen: false });
    expect(parseElsewhereView({ places: [], known: null, chosen: true }).chosen).toBe(true);
  });

  it("steps aside for the sheets its ways out open, so adding a place shows its setup rather than this screen", () => {
    const none = { settings: false, cloudAdd: false, addVps: false, cloudMove: false };
    expect(elsewhereCovered(none)).toBe(false);
    expect(elsewhereCovered({ ...none, settings: true })).toBe(true);
    expect(elsewhereCovered({ ...none, cloudAdd: true })).toBe(true);
    expect(elsewhereCovered({ ...none, addVps: true })).toBe(true);
    expect(elsewhereCovered({ ...none, cloudMove: true })).toBe(true);
    expect(elsewhereCovered({ ...none, placeSetup: true })).toBe(true);
  });

  it("keeps only whole bot counts from main", () => {
    expect(parseBotCounts({ a: 3, b: 0, c: -1, d: 1.5, e: "2" })).toEqual({ a: 3, b: 0 });
    expect(parseBotCounts(null)).toEqual({});
  });
});
