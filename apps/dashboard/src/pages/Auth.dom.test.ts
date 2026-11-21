// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  session: { setAccount: (_account: unknown) => {} },
  api: {
    authProviders: async () => ({ providers: [{ id: "google", enabled: true }, { id: "apple", enabled: true }] }),
    start: async (_email: string, _intent?: string, _pending?: string, _recover?: boolean) => ({ attempt: "a".repeat(43), resendAfter: 30, expiresIn: 600, codeLength: 8 }),
    verify: async (_attempt: string, _code: string) => ({ account: { id: "acct", email: "sid@madanibot.test" }, created: false }),
    oauthUrl: () => "/v1/auth/oauth/google/start",
  },
}));
vi.mock("../data/session", () => ({ useSession: () => state.session }));
vi.mock("../lib/api", () => ({ api: state.api, FIXTURE: null, ApiError: class extends Error { code?: string } }));

const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function render() {
  const { AuthScreen } = await import("./Auth");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(AuthScreen, { mode: "signin" })));
  return host;
}
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("trouble signing in? asks for the address, sends a recovery start and says what was sent without telling whether an account exists", async () => {
  history.replaceState(null, "", "/sign-in");
  const start = vi.spyOn(state.api, "start");
  const host = await render();
  await act(async () => button(host, "trouble signing in?")!.click());
  expect(host.querySelector("h1")?.textContent).toBe("trouble signing in?");
  expect(host.textContent).toContain("can't access your email?");
  expect(host.querySelector<HTMLAnchorElement>('a[href^="mailto:"]')?.href).toBe("mailto:hello@madani.bot");
  await type(host.querySelector<HTMLInputElement>("#recover-email")!, "sid@madanibot.test");
  await act(async () => button(host, "send sign-in link")!.click());
  expect(start).toHaveBeenCalledWith("sid@madanibot.test", "signin", undefined, true);
  expect(host.textContent).toContain("if an account uses sid@madanibot.test, we sent a link and an 8-digit code.");
  await act(async () => button(host, "use a different email")!.click());
  expect(host.querySelector("h1")?.textContent).toBe("trouble signing in?");
});

test("the emailed link waits for a click, signs in once, and leaves the address bar", async () => {
  const attempt = "b".repeat(43);
  history.replaceState(null, "", `/sign-in?next=/account#attempt=${attempt}&code=12345678`);
  const verify = vi.spyOn(state.api, "verify");
  const host = await render();
  expect(location.hash).toBe("");
  expect(location.pathname + location.search).toBe("/sign-in?next=/account");
  expect(verify).not.toHaveBeenCalled();
  expect(host.querySelector("h1")?.textContent).toBe("your link is ready.");
  await act(async () => button(host, "sign in")!.click());
  expect(verify).toHaveBeenCalledWith(attempt, "12345678");
});

test("the emailed link with its attempt in the query signs in the same way", async () => {
  const attempt = "c".repeat(43);
  history.replaceState(null, "", `/sign-in?attempt=${attempt}#code=12345678`);
  const verify = vi.spyOn(state.api, "verify");
  const host = await render();
  expect(location.hash).toBe("");
  await act(async () => button(host, "sign in")!.click());
  expect(verify).toHaveBeenCalledWith(attempt, "12345678");
});

test("a malformed link is ignored and the page starts at sign-in", async () => {
  history.replaceState(null, "", "/sign-in#attempt=short&code=12");
  const host = await render();
  expect(host.querySelector("h1")?.textContent).toBe("welcome back.");
  expect(button(host, "continue")).not.toBeNull();
});

test("every sign-in button shows; one without keys yet says so in place instead of leaving the page", async () => {
  history.replaceState(null, "", "/sign-in");
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  vi.spyOn(state.api, "authProviders").mockResolvedValue({ providers: [{ id: "google", enabled: true }, { id: "apple", enabled: false }] });
  const host = await render();
  for (const label of ["continue with google", "continue with apple"]) expect(button(host, label)).not.toBeNull();
  expect(button(host, "continue with x"), "no X sign-in").toBeNull();
  await act(async () => button(host, "continue with apple")!.click());
  expect(assign).not.toHaveBeenCalled();
  expect(host.querySelector("#auth-soon")?.textContent).toBe("apple sign-in is coming soon. use email or google for now.");
  expect(host.textContent).toContain("don't have an account? sign up");
});

test("the sent code reads with the right article for its length", async () => {
  for (const [codeLength, line] of [[8, "we sent an 8-digit code to sid@madanibot.test."], [6, "we sent a 6-digit code to sid@madanibot.test."]] as const) {
    history.replaceState(null, "", "/sign-in");
    vi.spyOn(state.api, "start").mockResolvedValue({ attempt: "a".repeat(43), resendAfter: 30, expiresIn: 600, codeLength });
    const host = await render();
    await type(host.querySelector<HTMLInputElement>('input[type="email"]')!, "sid@madanibot.test");
    await act(async () => button(host, "continue")!.click());
    expect(host.textContent).toContain(line);
    await act(async () => roots.pop()!.unmount());
    host.remove();
  }
});
