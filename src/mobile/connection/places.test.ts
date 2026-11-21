import { describe, expect, it } from "vitest";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import type { MobileCloud, MobileComputer, MobileTeamCloud } from "../account/account-client";
import { mergePlaces, pairingText } from "./places";

const record = (id: string, label: string, origin?: string): MobileConnectionRecord => ({ id, environmentId: `env-${id}`, label, transport: "https", origin, sessionRef: `token.${id}`, capabilities: {} as MobileConnectionRecord["capabilities"], addedAt: 1, lastUsedAt: 1 });
const cloud = (id: string, extra: Partial<MobileCloud> = {}): MobileCloud => ({ id, name: `Cloud ${id}`, status: "ready", origin: `https://${id}.madani.bot`, primary: false, asleep: false, ...extra });
const computer = (id: string, extra: Partial<MobileComputer> = {}): MobileComputer => ({ id: `ws_${id}`, name: `Computer ${id}`, kind: "mac", presence: "online", environmentId: `env-${id}`, ...extra });
const team = (id: string, extra: Partial<MobileTeamCloud> = {}): MobileTeamCloud => ({ id, name: `Team ${id}`, status: "ready", origin: `https://${id}.madani.bot`, asleep: false, ...extra });

describe("places", () => {
  it("lists linked places first, then the account's clouds and team clouds the phone does not link to yet", () => {
    const places = mergePlaces({ records: [record("mac", "Studio Mac", "https://192.168.1.4:5331"), record("home", "Home cloud", "https://c1.madani.bot")], activeId: "mac", connected: true,
      account: { clouds: [cloud("c1"), cloud("c2", { asleep: true })], teams: [team("t1")], computers: [] } });
    expect(places.map((place) => [place.name, place.status, place.target.kind])).toEqual([
      ["Studio Mac", "online", "linked"], ["Home cloud", "online", "linked"], ["Cloud c2", "asleep", "cloud"], ["Team t1", "online", "team"],
    ]);
    expect(places.filter((place) => place.active).map((place) => place.name)).toEqual(["Studio Mac"]);
  });

  it("a computer the phone is not connected to reads as not connected; the one in use as its live state", () => {
    const records = [record("mac", "Studio Mac"), record("vps", "Server")];
    expect(mergePlaces({ records, activeId: "mac", connected: false, account: null }).map((place) => place.status)).toEqual(["offline", "offline"]);
    expect(mergePlaces({ records, activeId: "mac", connected: true, account: null }).map((place) => place.status)).toEqual(["online", "offline"]);
  });

  it("leaves out clouds that have ended, and shows a stopped one as asleep", () => {
    const places = mergePlaces({ records: [], activeId: null, connected: false, account: { clouds: [cloud("gone", { status: "ended" }), cloud("off", { status: "stopped" }), cloud("new", { status: "setting_up" })], teams: [], computers: [] } });
    expect(places.map((place) => [place.name, place.status])).toEqual([["Cloud off", "asleep"], ["Cloud new", "offline"]]);
  });

  it("lists the account's computers after the clouds, one row each with its presence, and a linked one only once", () => {
    const places = mergePlaces({ records: [record("mac", "Studio Mac")], activeId: null, connected: false,
      account: { clouds: [], teams: [], computers: [computer("mac", { presence: "asleep" }), computer("pc", { kind: "windows" }), computer("vps", { kind: "vps", presence: "offline", environmentId: null })] } });
    expect(places.map((place) => [place.name, place.status, place.target.kind])).toEqual([
      ["Studio Mac", "asleep", "linked"], ["Computer pc", "online", "computer"], ["Computer vps", "offline", "computer"],
    ]);
  });

  it("lists the clouds of the phone's other accounts too, each opened through its own account, and a linked one once", () => {
    const places = mergePlaces({ records: [record("a", "Alice cloud", "https://ca.madani.bot")], activeId: "a", connected: true,
      account: { clouds: [cloud("ca")], teams: [], computers: [] },
      others: [{ accountId: "bob", places: { clouds: [cloud("cb"), cloud("ca")], teams: [team("tb")], computers: [] } }] });
    expect(places.map((place) => [place.name, place.target.kind, "accountId" in place.target ? place.target.accountId : undefined])).toEqual([
      ["Alice cloud", "linked", undefined], ["Cloud cb", "cloud", "bob"], ["Team tb", "team", "bob"],
    ]);
  });

  it("hands the pairing step the cloud's address and its code", () => {
    expect(pairingText({ origin: "https://c1.madani.bot", code: "ABCD-EFGH-JKLM", expiresAt: 1 })).toBe("https://c1.madani.bot ABCDEFGHJKLM");
  });
});
