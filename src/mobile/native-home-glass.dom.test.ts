// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { readHomeGlass } from "./native-home-glass";

const box = (left: number, top: number, w: number, h: number) => () => ({ left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON() {} }) as DOMRect;

function home({ page }: { page?: "moving" | "resting" } = {}) {
  document.body.innerHTML = `<div class="madani-mobile"><div class="mobile-nav"><div id="list"><header data-home-bar>
    <button data-home-glass="search" aria-label="Search"></button><button data-home-glass="newBot" aria-label="New bot"></button>
  </header></div>${page ? `<div class="mobile-page" ${page === "moving" ? "data-moving" : ""}></div>` : ""}</div></div>`;
  const root = document.querySelector<HTMLElement>(".madani-mobile")!;
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 390 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 844 });
  document.querySelector<HTMLElement>("#list")!.getBoundingClientRect = box(0, 0, 390, 844);
  const search = root.querySelector<HTMLElement>('[data-home-glass="search"]')!;
  const plus = root.querySelector<HTMLElement>('[data-home-glass="newBot"]')!;
  search.getBoundingClientRect = box(282, 54, 44, 44);
  plus.getBoundingClientRect = box(334, 54, 44, 44);
  return { root, search, plus };
}

afterEach(() => { document.body.innerHTML = ""; });

it("hands the native bar Home's Search and New bot buttons where they rest", () => {
  const { root, search, plus } = home();
  document.elementFromPoint = (x: number) => (x < 330 ? search : plus);
  expect(readHomeGlass(root)).toEqual([
    { kind: "search", frame: { x: 282, y: 54, w: 44, h: 44 }, label: "Search" },
    { kind: "newBot", frame: { x: 334, y: 54, w: 44, h: 44 }, label: "New bot" },
  ]);
});

it("gives the buttons back to the page under a sheet, and while a chat rests over the list", () => {
  const { root } = home();
  const scrim = document.createElement("div");
  document.body.append(scrim);
  document.elementFromPoint = () => scrim;
  expect(readHomeGlass(root), "covered by a sheet's scrim").toBeNull();
  expect(readHomeGlass(home({ page: "resting" }).root), "a chat is open").toBeNull();
});

it("keeps drawing them while a chat page slides over the list, which clips them natively", () => {
  const { root } = home({ page: "moving" });
  document.elementFromPoint = () => document.querySelector(".mobile-page");
  expect(readHomeGlass(root)?.map((b) => b.kind)).toEqual(["search", "newBot"]);
});
