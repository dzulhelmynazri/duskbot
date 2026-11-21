// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { CloudDesktop } from "../data/contracts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  cloud: { clouds: null as CloudDesktop[] | null, billing: null, refresh: () => {} },
  session: { account: { id: "fx-sid", email: "sid@madanibot.test" }, setAccount: (_account: null) => {}, toast: (_message: string) => {} },
}));
vi.mock("../data/cloud", () => ({ useCloud: () => state.cloud }));
vi.mock("../data/session", () => ({ useSession: () => state.session }));

const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function render(node: Parameters<Root["render"]>[0]) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return { host, unmount: async () => { roots.splice(roots.indexOf(root), 1); await act(async () => root.unmount()); host.remove(); } };
}

// fixture answers take about 140 ms
async function until(check: () => boolean) {
  for (let i = 0; i < 60 && !check(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  expect(check()).toBe(true);
}

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;

test("the emailed link: token kept out of the URL, sign in again, confirm shows the date, cancel calls the route", async () => {
  const token = "fixture-delete-link".padEnd(43, "0");
  history.replaceState(null, "", `/clouds/fx-cloud/delete?fixture=managed#${token}`);
  const persisted = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => persisted.get(key) ?? null, setItem: (key: string, value: string) => void persisted.set(key, value), removeItem: (key: string) => void persisted.delete(key) });
  const { api } = await import("../lib/api");
  const { DeleteDataPage } = await import("./DeleteData");
  const { longDate } = await import("../lib/format");
  state.cloud.clouds = (await api.clouds()).clouds;
  const setAccount = vi.spyOn(state.session, "setAccount");

  const first = await render(createElement(DeleteDataPage, { id: "fx-cloud" }));
  expect(location.hash).toBe("");
  expect(location.pathname + location.search).toBe("/clouds/fx-cloud/delete?fixture=managed");
  expect(sessionStorage.getItem("madani-dash-delete-token:fx-cloud")).toBe(token);
  expect([...persisted.values()].some((value) => value.includes(token))).toBe(false);
  expect(first.host.querySelector("h1")?.textContent).toBe("delete the data on Sid's Cloud?");

  // the fixture session signed in an hour ago, so the service asks for a fresh sign-in
  await act(async () => button(first.host, "delete in 7 days")!.click());
  await until(() => first.host.querySelector("h1")?.textContent === "sign in again to go on");
  await act(async () => button(first.host, "sign in again")!.click());
  await until(() => setAccount.mock.calls.length > 0);
  expect(setAccount).toHaveBeenCalledWith(null);
  await first.unmount();

  // signed back in: the page comes back with the token from this tab and finishes what was asked
  const attempt = await api.start("sid@madanibot.test");
  await api.verify(attempt.attempt, "12345678");
  const confirm = vi.spyOn(api, "confirmDeleteData");
  const second = await render(createElement(DeleteDataPage, { id: "fx-cloud" }));
  await until(() => second.host.querySelector("h1")?.textContent?.startsWith("deleting on ") ?? false);
  expect(confirm).toHaveBeenCalledWith("fx-cloud", token);
  const scheduledAt = await confirm.mock.results[0]!.value.then((answer: { deleteScheduledAt: number }) => answer.deleteScheduledAt);
  expect(second.host.querySelector("h1")?.textContent).toBe(`deleting on ${longDate(scheduledAt)}`);
  expect(sessionStorage.getItem("madani-dash-delete-token:fx-cloud")).toBeNull();

  const cancel = vi.spyOn(api, "cancelDeleteData");
  await act(async () => button(second.host, "cancel deletion")!.click());
  await until(() => location.pathname === "/cloud");
  expect(cancel).toHaveBeenCalledWith("fx-cloud");
});

test("the cloud page banner shows a scheduled deletion and cancels it", async () => {
  const { api } = await import("../lib/api");
  const { DeletionBanner } = await import("./DeleteData");
  const cancel = vi.spyOn(api, "cancelDeleteData").mockResolvedValue({ ok: true });
  const at = new Date(2026, 10, 16, 12).getTime();
  const cloud = { id: "fx-cloud", name: "Sid's Cloud", provider: "managed", deleteScheduledAt: at } as CloudDesktop;
  const { host } = await render(createElement(DeletionBanner, { cloud }));
  expect(host.querySelector("h2")?.textContent).toBe("deleting on 16 Nov 2026");
  await act(async () => button(host, "cancel deletion")!.click());
  expect(cancel).toHaveBeenCalledWith("fx-cloud");
});
