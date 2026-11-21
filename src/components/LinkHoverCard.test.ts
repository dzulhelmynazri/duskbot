// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { parseGithubUrl } from "@/lib/github-refs";
import { renderToStaticMarkup } from "react-dom/server";
import { forgetLinkPreviews } from "@/lib/link-preview";
import type { LinkPreview } from "../../shared/link-preview";
import { CARD_EXIT_MS, HOVER_CLOSE_GRACE_MS, HOVER_OPEN_DELAY_MS, imageRatio, LinkHoverCard, LinkPreviewCard, LONG_PRESS_MS, placeCard, PREVIEW_WAIT_MS } from "./LinkHoverCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const box = (left: number, top: number, width = 60, height = 20) => ({ left, top, width, height, right: left + width, bottom: top + height });

describe("placeCard", () => {
  const view = { width: 800, height: 600 };
  const card = { width: 320, height: 120 };
  it("sits above the link, centered on it", () => {
    expect(placeCard(box(300, 400), card, view)).toEqual({ left: 170, top: 272, side: "above" });
  });
  it("flips below when there is no room above", () => {
    expect(placeCard(box(300, 40), card, view)).toEqual({ left: 170, top: 68, side: "below" });
  });
  it("stays inside the window at either edge", () => {
    expect(placeCard(box(0, 400), card, view).left).toBe(8);
    expect(placeCard(box(780, 400, 20), card, view).left).toBe(800 - 320 - 8);
    expect(placeCard(box(10, 400), { width: 400, height: 120 }, { width: 380, height: 600 }).left).toBe(8);
  });
});

class LoadingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) { queueMicrotask(() => (value.includes("broken") ? this.onerror : this.onload)?.()); }
}

function mount(href: string, github = parseGithubUrl(href)) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(LinkHoverCard, { href, github, children: (anchor) => createElement("a", { ...anchor, href }, "link") })));
  return { link: () => host.querySelector("a")!, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const card = () => document.querySelector<HTMLElement>("[data-link-preview]");
const fire = async (target: EventTarget, type: string, init: PointerEventInit = {}) =>
  act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", ...init })); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("LinkHoverCard", () => {
  let view: ReturnType<typeof mount>;
  const href = "https://github.com/goatedgrokbotalternative/madanibot/pull/2547";
  const link = () => view.link();

  beforeEach(() => {
    vi.useFakeTimers();
    setLocale("en");
    forgetLinkPreviews();
    vi.stubGlobal("Image", LoadingImage);
    vi.stubGlobal("fetch", answer({ error: "no" }, 404));
    view = mount(href);
  });
  afterEach(() => {
    view.unmount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opens after a short rest and describes the link", async () => {
    await fire(link(), "pointerover");
    await advance(HOVER_OPEN_DELAY_MS - 50);
    expect(card()).toBeNull();
    await advance(50);
    expect(card()?.getAttribute("role")).toBe("tooltip");
    expect(card()?.textContent).toContain("Pull request #2547");
    expect(card()?.textContent).toContain("goatedgrokbotalternative/madanibot");
    expect(card()?.textContent).toContain("github.com");
    expect(link().getAttribute("aria-describedby")).toBe(card()?.id);
  });

  it("stays open while the pointer moves into the card, and closes after leaving it", async () => {
    await fire(link(), "pointerover");
    await advance(HOVER_OPEN_DELAY_MS);
    await fire(link(), "pointerout", { relatedTarget: card() });
    await fire(card()!, "pointerover", { relatedTarget: link() });
    await advance(HOVER_CLOSE_GRACE_MS * 2);
    expect(card()?.dataset.state).toBe("open");
    await fire(card()!, "pointerout", { relatedTarget: document.body });
    await advance(HOVER_CLOSE_GRACE_MS);
    expect(card()?.dataset.state).toBe("closed");
    expect(link().hasAttribute("aria-describedby")).toBe(false);
    await advance(CARD_EXIT_MS);
    expect(card()).toBeNull();
  });

  it("reopens a closing card in place instead of starting over", async () => {
    await fire(link(), "pointerover");
    await advance(HOVER_OPEN_DELAY_MS);
    const first = card();
    await fire(link(), "pointerout", { relatedTarget: document.body });
    await advance(HOVER_CLOSE_GRACE_MS);
    expect(card()?.dataset.state).toBe("closed");
    await fire(link(), "pointerover");
    expect(card()).toBe(first);
    expect(card()?.dataset.state).toBe("open");
  });

  it("never opens for a pointer that only passes over", async () => {
    await fire(link(), "pointerover");
    await fire(link(), "pointerout", { relatedTarget: document.body });
    await advance(HOVER_OPEN_DELAY_MS * 2);
    expect(card()).toBeNull();
  });

  it("opens on a long press and keeps the link from opening", async () => {
    await fire(link(), "pointerdown", { pointerType: "touch", clientX: 5, clientY: 5 });
    await advance(LONG_PRESS_MS);
    expect(card()).not.toBeNull();
    await fire(link(), "pointerup", { pointerType: "touch" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { link().dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
  });

  it("lets a quick tap open the link", async () => {
    await fire(link(), "pointerdown", { pointerType: "touch", clientX: 5, clientY: 5 });
    await fire(link(), "pointerup", { pointerType: "touch" });
    await advance(LONG_PRESS_MS);
    expect(card()).toBeNull();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { link().dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(false);
  });

  it("closes on Escape from the link", async () => {
    await fire(link(), "pointerover");
    await advance(HOVER_OPEN_DELAY_MS);
    act(() => { link().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await advance(CARD_EXIT_MS);
    expect(card()).toBeNull();
  });

  it("closes on Escape while the pointer rests on the card and nothing has focus", async () => {
    await fire(link(), "pointerover");
    await advance(HOVER_OPEN_DELAY_MS);
    await fire(card()!, "pointerover", { relatedTarget: link() });
    act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(card()?.dataset.state).toBe("closed");
    await advance(CARD_EXIT_MS);
    expect(card()).toBeNull();
  });
});

describe("LinkHoverCard with the page's own preview", () => {
  const href = "https://fieldnotes.example/tide?ref=chat";
  const rich: LinkPreview = {
    url: "https://fieldnotes.example/tide?ref=chat",
    title: "How tide pools survive the winter",
    description: "A season of measurements from three rocky shores.",
    siteName: "Field Notes",
    image: { src: "/api/link-preview/image/0123456789abcdef0123456789abcdef", width: 1200, height: 630 },
    video: true,
  };
  let view: ReturnType<typeof mount>;
  beforeEach(() => {
    vi.useFakeTimers();
    setLocale("en");
    forgetLinkPreviews();
    vi.stubGlobal("Image", LoadingImage);
  });
  afterEach(() => {
    view.unmount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks the app's server, never the site, and shows the picture, title, description and address", async () => {
    const fetch = answer({ preview: rich });
    vi.stubGlobal("fetch", fetch);
    view = mount(href, null);
    await fire(view.link(), "pointerover");
    expect(fetch).toHaveBeenCalledWith(`/api/link-preview?url=${encodeURIComponent(href)}`);
    await advance(HOVER_OPEN_DELAY_MS);
    const shown = card()!;
    expect(shown.querySelector("img")?.getAttribute("src")).toBe(rich.image!.src);
    expect(shown.textContent).toContain("How tide pools survive the winter");
    expect(shown.textContent).toContain("A season of measurements");
    expect(shown.textContent).toContain("fieldnotes.example/tide?ref=chat");
    expect(shown.querySelector(".line-clamp-2")?.textContent).toBe(rich.title);
    expect(shown.querySelector(".line-clamp-3")?.textContent).toBe(rich.description);
    expect(shown.querySelectorAll("svg").length).toBeGreaterThan(1);
  });

  it("drops a picture that will not load before the card appears", async () => {
    vi.stubGlobal("fetch", answer({ preview: { ...rich, image: { ...rich.image!, src: "/api/link-preview/image/broken" } } }));
    view = mount(href, null);
    await fire(view.link(), "pointerover");
    await advance(HOVER_OPEN_DELAY_MS);
    expect(card()?.textContent).toContain("How tide pools survive the winter");
    expect(card()?.querySelector("img[src*='link-preview']")).toBeNull();
  });

  it("waits a moment for a slow preview, then shows the address alone and keeps it while open", async () => {
    let finish: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    view = mount(href, null);
    await fire(view.link(), "pointerover");
    await advance(HOVER_OPEN_DELAY_MS);
    expect(card()).toBeNull();
    await advance(PREVIEW_WAIT_MS);
    expect(card()?.textContent).toContain("fieldnotes.example");
    expect(card()?.textContent).toContain("/tide?ref=chat");
    await act(async () => { finish(new Response(JSON.stringify({ preview: rich }))); });
    expect(card()?.textContent).not.toContain("How tide pools");
  });
});

describe("LinkPreviewCard", () => {
  it("falls back to the site's icon, its name and the readable path", () => {
    setLocale("en");
    const html = renderToStaticMarkup(createElement(LinkPreviewCard, { href: "https://www.example.com/docs/caf%C3%A9?x=1" }));
    expect(html).toContain(">example.com</span>");
    expect(html).toContain("/docs/café?x=1");
    expect(html).toContain("/api/site-icon?domain=example.com");
    expect(html).toContain("rounded-2xl bg-composer");
  });

  it("names the link's own host and path, never the page a redirect landed on, which shows only as via", () => {
    setLocale("en");
    const href = "https://docs.example.com/guide/start";
    const landed: LinkPreview = {
      url: "https://login.evil.example.net/phish?next=1",
      title: "Sign in", description: null, siteName: null, image: null, video: false,
    };
    const html = renderToStaticMarkup(createElement(LinkPreviewCard, { href, preview: landed }));
    const address = html.slice(html.indexOf('dir="ltr"'));
    expect(address).toContain(">docs.example.com</span>");
    expect(address).toContain(">/guide/start</span>");
    expect(html).toContain("/api/site-icon?domain=docs.example.com");
    expect(html).not.toContain("/api/site-icon?domain=login.evil.example.net");
    expect(html).not.toContain("/phish");
    expect(html).toContain("Via login.evil.example.net");
    // a redirect that stays on the link's own site adds nothing
    const same = renderToStaticMarkup(createElement(LinkPreviewCard, { href, preview: { ...landed, url: "https://www.docs.example.com/guide/start/" } }));
    expect(same).not.toContain("data-link-preview-via");
  });

  it("keeps a picture's shape within reason and gives video 16:9", () => {
    expect(imageRatio({ width: 1200, height: 630 }, false)).toBeCloseTo(1.905, 2);
    expect(imageRatio({ width: 500, height: 500 }, false)).toBeCloseTo(4 / 3);
    expect(imageRatio({ width: null, height: null }, false)).toBe(1.91);
    expect(imageRatio({ width: 480, height: 360 }, true)).toBeCloseTo(16 / 9);
  });

  it("titles a commit by its short sha", () => {
    const href = "https://github.com/a/app/commit/68189cf0a1b2";
    const html = renderToStaticMarkup(createElement(LinkPreviewCard, { href, github: parseGithubUrl(href) }));
    expect(html).toContain("Commit 68189cf");
    expect(html).toContain("a/app");
  });
});
