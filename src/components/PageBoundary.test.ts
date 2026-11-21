// @vitest-environment happy-dom
import { createElement, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageBoundary } from "./PageBoundary";

function Broken() {
  useEffect(() => {
    throw new TypeError("desktop.shown is not a function");
  }, []);
  return createElement("p", null, "the page");
}

describe("PageBoundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the page up, with plain words and a reload, when a part of it throws in an effect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(PageBoundary, null, createElement(Broken))));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain("This page hit an error.");
    expect(host.textContent).toContain("Reload to carry on where you were.");
    expect(host.textContent).not.toContain("desktop.shown is not a function");
    expect(host.querySelector("button")?.textContent).toBe("Reload");
    root.unmount();
    host.remove();
  });

  it("says the app updated, not the module address, when a part of it can't load after an update", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // a reload already went out within the minute, so the page waits for the button
    sessionStorage.setItem("madani.staleChunkReloadAt", String(Date.now()));
    function Stale(): never {
      throw new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1:5199/node_modules/.vite/deps/@hpke_core.js?v=1");
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(PageBoundary, null, createElement(Stale))));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain("The app updated. Reload to continue.");
    expect(host.textContent).not.toMatch(/hpke|https?:\/\/|\.js/);
    expect(host.querySelector("button")?.textContent).toBe("Reload");
    root.unmount();
    host.remove();
    sessionStorage.clear();
  });

  it("shows the page itself while nothing throws", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(PageBoundary, null, createElement("p", null, "the page"))));
    expect(host.textContent).toBe("the page");
    root.unmount();
    host.remove();
  });
});
