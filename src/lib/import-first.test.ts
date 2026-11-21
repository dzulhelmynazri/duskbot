import { beforeEach, expect, it } from "vitest";
import { importFirst, previousOpenAt, resetPreviousOpenForTests } from "./import-first";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 13);
const ago = (days: number) => new Date(now - days * DAY).toISOString();

beforeEach(() => resetPreviousOpenForTests());

it("leads Settings in the first five days", () => {
  expect(importFirst({ completedAt: ago(1), lastOpenAt: null, bots: 1, now })).toBe(true);
  expect(importFirst({ completedAt: ago(6), lastOpenAt: now - DAY, bots: 1, now })).toBe(false);
  expect(importFirst({ completedAt: "", lastOpenAt: null, bots: 0, now }), "not onboarded yet counts as new").toBe(true);
});

it("leads Settings again after three days away", () => {
  expect(importFirst({ completedAt: ago(60), lastOpenAt: now - 3 * DAY, bots: 2, now })).toBe(true);
  expect(importFirst({ completedAt: ago(60), lastOpenAt: now - 2 * DAY, bots: 2, now })).toBe(false);
});

it("stays at the bottom for someone who already has plenty of bots", () => {
  expect(importFirst({ completedAt: ago(1), lastOpenAt: now - 30 * DAY, bots: 5, now })).toBe(false);
});

it("remembers the previous open once per run and moves it to now", () => {
  const map = new Map<string, string>([["madani.lastOpenedAt", String(now - 20 * DAY)]]);
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  expect(previousOpenAt(storage, now)).toBe(now - 20 * DAY);
  expect(map.get("madani.lastOpenedAt")).toBe(String(now));
  expect(previousOpenAt(storage, now + DAY), "same run reads the first value").toBe(now - 20 * DAY);
});
