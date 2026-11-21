// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MakingView } from "./MakingStep";

it("a ready cloud opens by itself with no button; only a failed open offers Try again and this computer's own chat", () => {
  const render = (openFailed: boolean) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(MakingView, { making: { kind: "ready" }, opening: false, openFailed, onOpen: () => {}, onHere: () => {} }));
    return host;
  };
  const opening = render(false);
  expect(opening.textContent).toContain("Your cloud is ready");
  expect(opening.querySelector("button"), "no Open chat while it opens by itself").toBeNull();
  const failed = render(true);
  expect(failed.querySelector("[data-funnel-open-cloud]")?.textContent).toBe("Try again");
  expect(failed.querySelector("[data-funnel-use-here]")?.textContent).toBe("Use this computer for now");
  expect(failed.querySelector('[role="alert"]')?.textContent).toMatch(/Couldn't open your cloud/);
});

it("the checklist ticks one step at a time when the Admin jumps ahead", async () => {
  vi.useFakeTimers();
  const { useStepwise, STEP_TICK_MS } = await import("./MakingStep");
  const seen: number[] = [];
  function Probe({ target }: { target: number }) { seen.push(useStepwise(target)); return null; }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe, { target: 0 })));
  await act(async () => root.render(createElement(Probe, { target: 4 })));
  for (let i = 0; i < 4; i++) await act(async () => { vi.advanceTimersByTime(STEP_TICK_MS); });
  expect([...new Set(seen)]).toEqual([0, 1, 2, 3, 4]);
  root.unmount();
  vi.useRealTimers();
});

it("a ready cloud carries its address, and a page that can't be reached isn't one that answers", async () => {
  const { makingFrom, cloudAnswers } = await import("./MakingStep");
  const own = { primary: true, runsOn: "cloud", status: "ready", origin: "https://ada.madani.test" };
  expect(makingFrom({ clouds: [own] } as never)).toEqual({ kind: "ready", origin: "https://ada.madani.test" });
  expect(await cloudAnswers("https://ada.madani.test", (async () => new Response(null)) as typeof fetch)).toBe(true);
  expect(await cloudAnswers("https://ada.madani.test", (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch)).toBe(false);
});

it("a plan that isn't active never says setup is trying again: it says what to check and opens the plan page", async () => {
  const { makingFrom } = await import("./MakingStep");
  const own = (status: string) => ({ clouds: [{ primary: true, runsOn: "cloud", status, origin: null }] }) as never;
  expect(makingFrom(own("payment_problem"))).toEqual({ kind: "payment" });
  expect(makingFrom(own("ended"))).toEqual({ kind: "payment" });
  expect(makingFrom({ machine: { status: "payment-problem" } } as never)).toEqual({ kind: "payment" });
  expect(makingFrom({ machine: { status: "failed" } } as never)).toEqual({ kind: "failed" });
  let opened = 0;
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(MakingView, { making: { kind: "payment" }, opening: false, openFailed: false, onOpen: () => {}, onPlan: () => { opened++; } }));
  expect(host.textContent).not.toMatch(/trying again/);
  expect(host.textContent).toContain("plan page");
  expect(host.querySelector("[data-funnel-plan-page]")?.textContent).toBe("Open your plan page");
  expect(host.querySelector('[aria-current="step"]'), "no step spins while nothing is being made").toBeNull();
  expect(opened).toBe(0);
});

it("the making screen is never a dead end: this computer's chat stays one press away while the cloud is waiting or failed", async () => {
  for (const kind of ["waiting", "failed"] as const) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onHere = vi.fn();
    await act(async () => root.render(createElement(MakingView, { making: { kind }, opening: false, openFailed: false, onOpen: () => {}, onHere })));
    const here = host.querySelector<HTMLButtonElement>("[data-funnel-use-here]");
    expect(here, kind).not.toBeNull();
    await act(async () => here!.click());
    expect(onHere).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    host.remove();
  }
});
