// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/places", async (original) => ({ ...await original<typeof import("@/lib/places")>(), usePlaces: () => ({ beside: true, places: [] }) }));
const { AccountsSheet, useAccounts } = await import("./AccountMenu");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = { active: { id: "a", email: "a@example.test" } };
const bridge = {
  list: vi.fn(async () => view),
  onChanged: vi.fn(() => () => {}),
  signOut: vi.fn(async () => ({ outcome: "signed-out", view: { active: null } })),
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = { accounts: bridge, app: { ownPage: true } };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); });

/** the open question: one on its way out (inert, still drawn) is closed */
const dialog = () => [...document.body.querySelectorAll<HTMLElement>("[role=alertdialog], [role=dialog][aria-modal=true]:not([data-accounts-sheet])")].find((el) => !el.closest("[data-leaving]")) ?? null;
const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);

it("the accounts sheet asks before signing out of madani cloud, with art and what happens; cancel keeps the account", async () => {
  await act(async () => { root.render(createElement(AccountsSheet, { onClose: vi.fn() })); });
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-accounts-sign-out]")!.click(); });
  expect(bridge.signOut).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain("Sign out of madani cloud?");
  expect(dialog()?.textContent).toContain("Your plan and your cloud bots keep going.");
  expect(dialog()?.querySelector("svg, canvas, img, [data-pixel-icon]")).not.toBeNull();
  await act(async () => { (button("Cancel") ?? button("Cancel")!).click(); });
  expect(dialog()).toBeNull();
  expect(bridge.signOut).not.toHaveBeenCalled();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-accounts-sign-out]")!.click(); });
  const confirm = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Sign out")!;
  await act(async () => { confirm.click(); });
  expect(bridge.signOut).toHaveBeenCalledWith("a");
});

it("the You menu and settings sign out through the same question", async () => {
  let access: ReturnType<typeof useAccounts> | null = null;
  function Probe() { access = useAccounts(); return access.signOutConfirm as never; }
  await act(async () => { root.render(createElement(Probe)); });
  await act(async () => { access!.signOut("a"); });
  expect(bridge.signOut).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain("Sign out of madani cloud?");
  const confirm = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Sign out")!;
  await act(async () => { confirm.click(); });
  expect(bridge.signOut).toHaveBeenCalledWith("a");
  expect(dialog()).toBeNull();
});

it("the account card shows the photo, name, address and plan, and Open dashboard opens the account dashboard", async () => {
  const at = Date.UTC(2026, 11, 14, 12);
  bridge.list.mockResolvedValueOnce({ active: { id: "a", email: "a@example.test", name: "Ada Lovelace", avatarUrl: "https://photos.example.test/ada.png", plan: { status: "active", tier: "pro", renewsAt: at } } } as never);
  const openPage = vi.fn(async () => ({ opened: true })), openDashboard = vi.fn(async () => {});
  (window as unknown as { madaniDesktop: Record<string, unknown> }).madaniDesktop.cloudAccount = { openPage, openDashboard };
  await act(async () => { root.render(createElement(AccountsSheet, { onClose: vi.fn() })); });
  const card = host.querySelector<HTMLElement>("[data-accounts-active]")!;
  expect(card.querySelector("img")?.getAttribute("src")).toBe("https://photos.example.test/ada.png");
  expect(card.textContent).toContain("Ada Lovelace");
  expect(card.textContent).toContain("a@example.test");
  expect(card.querySelector("[data-accounts-plan]")?.textContent).toBe("madani cloud · Pro");
  expect(card.textContent).not.toContain("Signed in as");
  await act(async () => { button("Open dashboard")!.click(); });
  expect(openDashboard).toHaveBeenCalled();
  expect(openPage).not.toHaveBeenCalled();
  expect(button("Sign out")).toBeDefined();
});

it("without a photo the card shows the avatar drawn from the account id; a photo that fails to load falls back to it", async () => {
  bridge.list.mockResolvedValueOnce({ active: { id: "a", email: "zed@example.test", plan: { status: "free" } } } as never);
  await act(async () => { root.render(createElement(AccountsSheet, { onClose: vi.fn() })); });
  const card = host.querySelector<HTMLElement>("[data-accounts-active]")!;
  expect(card.querySelector("img")).toBeNull();
  expect(card.querySelector("[data-user-avatar]")?.getAttribute("data-user-avatar")).toBe("a");
  expect(card.querySelector("[data-accounts-plan]")?.textContent).toBe("Free");
  act(() => root.unmount());
  root = createRoot(host);
  bridge.list.mockResolvedValueOnce({ active: { id: "a", email: "zed@example.test", name: "Zed Ward", avatarUrl: "https://photos.example.test/gone.png" } } as never);
  await act(async () => { root.render(createElement(AccountsSheet, { onClose: vi.fn() })); });
  await act(async () => { host.querySelector("img")!.dispatchEvent(new Event("error")); });
  expect(host.querySelector("[data-accounts-active] img")).toBeNull();
  expect(host.querySelector("[data-accounts-active] [data-user-avatar]")?.getAttribute("data-user-avatar")).toBe("a");
});

it("the plan line names the plan only, never a renewal or end date", async () => {
  const at = Date.UTC(2026, 11, 14, 12);
  const { accountPlanText } = await import("./AccountMenu");
  expect(accountPlanText({ status: "active", tier: "pro", renewsAt: at })).toBe("madani cloud · Pro");
  expect(accountPlanText({ status: "active", tier: "pro", endsAt: at, cancelled: true })).toBe("madani cloud · Pro");
  expect(accountPlanText({ status: "free" })).toBe("Free");
});

it("the avatar opens the picker: Shuffle rolls a drawing, Save keeps it on the account, and a failed save says so and keeps the picker", async () => {
  const setAvatar = vi.fn(async (choice: string | null) => ({ outcome: "failed", view: { active: { id: "a", email: "a@example.test", ...(choice ? { avatar: choice } : {}) } } }));
  (bridge as Record<string, unknown>).setAvatar = setAvatar;
  bridge.list.mockResolvedValueOnce({ active: { id: "a", email: "a@example.test", avatarUrl: "https://lh3.googleusercontent.com/a/x=s96-c" } } as never);
  try {
    await act(async () => { root.render(createElement(AccountsSheet, { onClose: vi.fn() })); });
    const face = host.querySelector<HTMLButtonElement>("[data-accounts-avatar]")!;
    expect(face.getAttribute("aria-label")).toBe("Change avatar");
    await act(async () => { face.click(); });
    const picker = () => document.body.querySelector<HTMLElement>("[data-avatar-picker]");
    expect(picker()?.getAttribute("role")).toBe("dialog");
    expect(document.activeElement?.hasAttribute("data-avatar-shuffle")).toBe(true);
    // a Google photo and nothing picked: the photo is the avatar, and the drawing from the account id stays a choice
    expect(host.querySelector("[data-accounts-avatar] img")?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/a/x=s96-c");
    expect(picker()!.querySelector("[data-avatar-photo]")?.textContent).toBe("Use my Google photo");
    expect(picker()!.querySelector("[data-avatar-photo]")?.getAttribute("aria-pressed")).toBe("true");
    expect(picker()!.querySelectorAll("[data-avatar-swatch]")).toHaveLength(6);
    expect(picker()!.querySelector("[data-avatar-swatch][aria-pressed=true]")).toBeNull();
    expect(picker()!.querySelector<HTMLButtonElement>("[data-avatar-save]")!.disabled).toBe(true);
    await act(async () => { picker()!.querySelector<HTMLButtonElement>("[data-avatar-shuffle]")!.click(); });
    const rolled = picker()!.querySelector("[data-avatar-swatch][aria-pressed=true]")!.getAttribute("data-avatar-swatch")!;
    expect(rolled).toMatch(/^g:[a-z0-9]{8}$/);
    await act(async () => { picker()!.querySelector<HTMLButtonElement>("[data-avatar-save]")!.click(); });
    expect(setAvatar).toHaveBeenCalledWith(rolled);
    expect(picker()!.querySelector("[data-avatar-error]")?.textContent).toBe("Your avatar wasn't saved. Check your connection, then try again.");
    setAvatar.mockImplementationOnce(async (choice) => ({ outcome: "saved", view: { active: { id: "a", email: "a@example.test", ...(choice ? { avatar: choice } : {}) } } }));
    await act(async () => { picker()!.querySelector<HTMLButtonElement>("[data-avatar-swatch=default]")!.click(); });
    await act(async () => { picker()!.querySelector<HTMLButtonElement>("[data-avatar-save]")!.click(); });
    expect(setAvatar).toHaveBeenLastCalledWith("drawn");
    expect(picker()).toBeNull();
    await act(async () => { face.click(); });
    await act(async () => { picker()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(picker()).toBeNull();
  } finally { delete (bridge as Record<string, unknown>).setAvatar; }
});
