// @vitest-environment happy-dom
// isolated marketing analytics tracker tests
// ideas from Minilytics (MIT, Copyright (c) 2026 surendrapandar)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { URL } from "node:url";
import { gzipSync } from "node:zlib";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve("apps/dashboard/tracker/dusk.js"), "utf8");
type Payload = {
  v: number; e: string; vid: string; sid: string; pv: string; h: string; p: string;
  u?: Record<string, string>; r?: string; w?: number; g?: string; b?: string;
  m?: Record<string, string>; s?: number; t?: number; l?: [string, number][];
};
type Api = ((name: unknown, meta?: unknown) => void) & { q?: IArguments[] };

describe("marketing tracker", () => {
  let win: Window & { dusk?: Api };
  let script: HTMLScriptElement;
  let payloads: Payload[];
  let pending: Promise<void>[];
  let beacon: ReturnType<typeof vi.fn>;
  let fetch: ReturnType<typeof vi.fn>;
  let now: number;
  let answer: unknown;

  function property(target: object, key: string, value: unknown) {
    Object.defineProperty(target, key, { configurable: true, value });
  }
  function visibility(state: string) {
    property(win.document, "visibilityState", state);
    win.document.dispatchEvent(new win.Event("visibilitychange"));
  }
  async function events() {
    await Promise.all(pending);
    await new Promise(resolve => setTimeout(resolve, 0));
    return payloads;
  }
  function cookieWrites() {
    const writes: string[] = [];
    let prototype: object | null = win.document;
    let descriptor: PropertyDescriptor | undefined;
    while (prototype && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, "cookie");
      prototype = Object.getPrototypeOf(prototype);
    }
    expect(descriptor?.set).toBeTypeOf("function");
    Object.defineProperty(win.document, "cookie", {
      configurable: true,
      get() { return descriptor!.get!.call(this); },
      set(value: string) { writes.push(value); descriptor!.set!.call(this, value); },
    });
    return writes;
  }
  async function load() {
    new Function("window", "document", "navigator", "URL", "URLSearchParams", "Blob", source)(
      win, win.document, win.navigator, win.URL, win.URLSearchParams, win.Blob,
    );
    return events();
  }
  function click(html: string, selector = "a") {
    win.document.body.innerHTML = html;
    const event = new win.MouseEvent("click", { bubbles: true, cancelable: true });
    event.preventDefault();
    win.document.querySelector(selector)!.dispatchEvent(event);
  }
  function submit(html: string) {
    win.document.body.innerHTML = html;
    win.document.querySelector("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  }

  beforeEach(() => {
    win = new Window({ url: "https://preview.dusk.bot/pricing?utm_source=x&email=a@b.c&ref=launch" });
    for (const cookie of win.document.cookie.split(";")) win.document.cookie = `${cookie.split("=")[0]}=; path=/; max-age=0`;
    win.localStorage.clear();
    win.history.replaceState(null, "", "/pricing?utm_source=x&email=a@b.c&ref=launch");
    win.document.body.innerHTML = "";
    property(win.document, "visibilityState", "visible");
    property(win.document, "referrer", "https://search.example/results?private=value");
    property(win.navigator, "userAgent", "Mozilla/5.0 Safari/605.1.15");
    property(win.navigator, "webdriver", false);
    property(win.navigator, "doNotTrack", null);
    property(win.navigator, "globalPrivacyControl", false);
    property(win, "innerWidth", 1280);
    property(win, "innerHeight", 500);
    property(win, "scrollY", 0);
    property(win.document.documentElement, "scrollHeight", 2000);
    script = win.document.createElement("script") as unknown as HTMLScriptElement;
    script.setAttribute("data-api", "https://t.example/v1/t");
    property(win.document, "currentScript", script);
    payloads = [];
    pending = [];
    beacon = vi.fn((_endpoint: string, body: Blob) => {
      pending.push(body.text().then(text => { payloads.push(JSON.parse(text)); }));
      return true;
    });
    answer = { persist: true };
    fetch = vi.fn((_endpoint: string, init: { body: string }) => {
      payloads.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) });
    });
    property(win.navigator, "sendBeacon", beacon);
    property(win, "fetch", fetch);
    now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await win.happyDOM.close();
  });

  it("sends only permitted pageview fields and sets shared secure cookies once the service allows them", async () => {
    const writes = cookieWrites();
    const [page] = await load();
    now++;
    expect(page).toEqual({
      v: 1, e: "pageview", vid: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      sid: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), pv: expect.stringMatching(/^[A-Za-z0-9_-]{8}$/),
      h: "preview.dusk.bot", p: "/pricing", u: { utm_source: "x", ref: "launch" }, r: "search.example", w: 1280,
    });
    expect(fetch.mock.calls[0]).toEqual(["https://t.example/v1/t", {
      method: "POST", body: expect.any(String), keepalive: true, credentials: "include", headers: { "content-type": "text/plain" },
    }]);
    expect(win.document.cookie).toContain(`dusk_vid=${page!.vid}`);
    expect(win.document.cookie).toContain(`dusk_sid=${page!.sid}`);
    expect(win.document.cookie).not.toContain("dusk_test");
    expect(writes).toContain(`dusk_vid=${page!.vid}; path=/; SameSite=Lax; Secure; max-age=31536000; domain=dusk.bot`);
    expect(writes).toContain(`dusk_sid=${page!.sid}; path=/; SameSite=Lax; Secure; max-age=1800; domain=dusk.bot`);
    win.happyDOM.setURL("https://dusk.bot/");
    expect(win.document.cookie).toContain(`dusk_vid=${page!.vid}`);
  });

  it("stores nothing where the service answers persist false, and clears ids kept before", async () => {
    win.document.cookie = "dusk_vid=existing_visitor; path=/";
    win.document.cookie = "dusk_sid=existing_session; path=/; domain=dusk.bot";
    answer = { persist: false };
    const writes = cookieWrites();
    await load();
    now++;
    click('<a href="https://elsewhere.example">elsewhere</a>');
    win.history.pushState(null, "", "/next");
    await events();
    expect(payloads.map(p => p.e)).toEqual(["pageview", "goal", "leave", "pageview"]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(win.document.cookie).toBe("");
    expect(writes.every(write => write.includes("max-age=0"))).toBe(true);
  });

  it.each([null, {}, { persist: "yes" }])("treats the answer %j as persist false", async value => {
    const writes = cookieWrites();
    answer = value;
    await load();
    win.history.pushState(null, "", "/next");
    await events();
    expect(fetch).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it("stores nothing after a failed request and asks again on the next page view", async () => {
    const writes = cookieWrites();
    fetch.mockImplementationOnce((_e: string, init: { body: string }) => { payloads.push(JSON.parse(init.body)); return Promise.reject(new Error("offline")); });
    await load();
    expect(writes).toEqual([]);
    answer = { persist: true };
    win.history.pushState(null, "", "/next");
    await events();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(win.document.cookie).toContain("dusk_vid=");
  });

  it("writes no cookie before the service answers", async () => {
    const writes = cookieWrites();
    fetch.mockImplementationOnce((_e: string, init: { body: string }) => { payloads.push(JSON.parse(init.body)); return new Promise(() => {}); });
    await load();
    expect(payloads).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it("reuses existing IDs and omits referrer in an existing session", async () => {
    win.document.cookie = "dusk_vid=existing_visitor; path=/";
    win.document.cookie = "dusk_sid=existing_session; path=/";
    expect((await load())[0]).toMatchObject({ vid: "existing_visitor", sid: "existing_session" });
    expect(payloads[0]).not.toHaveProperty("r");
  });

  it.each(["", "https://preview.dusk.bot/other"])("omits absent or same-host referrer %s", async referrer => {
    property(win.document, "referrer", referrer);
    expect((await load())[0]).not.toHaveProperty("r");
  });

  it("redacts path segments, bounds the path and filters attribution values", async () => {
    win.history.replaceState(null, "", `/people/a@b.c/encoded%40id/${"a".repeat(220)}?utm_source=a%40b.c&utm_term=${"t".repeat(120)}&via=docs&source=blog&token=secret`);
    const [page] = await load();
    expect(page!.p).toBe(`/people/:id/:id/${"a".repeat(220)}`.slice(0, 200));
    expect(page!.u).toEqual({ utm_term: "t".repeat(100), via: "docs", source: "blog" });
    win.history.pushState(null, "", "/clean");
    await events();
    expect(payloads.at(-1)).not.toHaveProperty("u");
    expect(payloads.at(-1)).not.toHaveProperty("r");
  });

  it.each(["param", "flag"])("honors the ignore %s and installs an inert API", async mode => {
    if (mode === "param") win.history.replaceState(null, "", "/?dusk_ignore=1");
    else win.localStorage.setItem("dusk_ignore", "1");
    await load();
    expect(win.localStorage.getItem("dusk_ignore")).toBe("1");
    expect(() => win.dusk!("test")).not.toThrow();
    click('<a href="https://elsewhere.example">elsewhere</a>');
    expect(beacon).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(win.document.cookie).toBe("");
  });

  it("checks the ignore URL before the persisted flag", async () => {
    win.localStorage.setItem("dusk_ignore", "1");
    win.history.replaceState(null, "", "/?dusk_ignore=0");
    expect(await load()).toHaveLength(1);
    expect(win.localStorage.getItem("dusk_ignore")).toBeNull();
  });

  it.each([["webdriver", true], ["doNotTrack", "1"], ["globalPrivacyControl", true], ["userAgent", "Googlebot/2.1"], ["userAgent", "HeadlessChrome"], ["userAgent", "curl/8"]])("skips %s=%s", async (key, value) => {
    property(win.navigator, key as string, value);
    await load();
    win.dusk!("test");
    expect(beacon).not.toHaveBeenCalled();
    expect(win.document.cookie).toBe("");
  });

  it.each(["http://localhost/", "http://127.1.2.3/", "http://0.0.0.0/", "http://[::1]/", "https://site.local/", "file:///tmp/index.html"])("skips local URL %s", async url => {
    win.happyDOM.setURL(url);
    await load();
    expect(beacon).not.toHaveBeenCalled();
  });

  it("allows explicit local tracking and defaults the endpoint relative to the page", async () => {
    win.happyDOM.setURL("http://localhost/");
    script.setAttribute("data-allow-local", "");
    script.removeAttribute("data-api");
    expect(await load()).toHaveLength(1);
    expect(fetch.mock.calls[0]![0]).toBe("/v1/t");
  });

  it("replays queued calls and sanitizes direct goal metadata", async () => {
    win.dusk = function () { (win.dusk!.q = win.dusk!.q || []).push(arguments); };
    win.dusk("queued_goal", { placement: "hero" });
    await load();
    win.dusk!("buy_1", { text: "x".repeat(120), count: 3, bad: false, nested: {}, infinity: Infinity, nan: NaN, a: "a", b: "b", c: "c", sixth: "drop" });
    await events();
    expect(payloads.map(p => p.e)).toEqual(["pageview", "goal", "goal"]);
    expect(payloads[1]).toMatchObject({ g: "queued_goal", m: { placement: "hero" } });
    expect(payloads[2]!.m).toEqual({ text: "x".repeat(100), a: "a", b: "b", c: "c", sixth: "drop" });
    expect(payloads[2]).not.toHaveProperty("u");
    expect(payloads[2]).not.toHaveProperty("r");
    expect(payloads[2]).not.toHaveProperty("w");
  });

  it("drops invalid goal names", async () => {
    await load();
    for (const name of ["", "UPPER", "has space", "hy-phen", "a".repeat(41), null, 123]) win.dusk!(name);
    expect(await events()).toHaveLength(1);
  });

  it("captures an ancestor's explicit goal and data attributes once", async () => {
    await load();
    click('<a href="/dashboard" data-dusk-goal="hero_click" data-dusk-placement="hero" data-dusk-plan="pro"><span>start</span></a>', "span");
    await events();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ g: "hero_click", m: { placement: "hero", plan: "pro" } });
  });

  it("reports a video or audio play once per page view, by its own goal name when it has one", async () => {
    await load();
    win.document.body.innerHTML = '<section id="demo"><video aria-label="Launch video" data-dusk-value="hero"></video><video data-dusk-goal="launch_video_play"></video></section>';
    const [plain, named] = [...win.document.querySelectorAll("video")];
    plain!.dispatchEvent(new win.Event("play"));
    plain!.dispatchEvent(new win.Event("play"));
    named!.dispatchEvent(new win.Event("play"));
    await events();
    expect(payloads.slice(1)).toMatchObject([{ g: "video_play", m: { section: "demo", label: "launch_video", value: "hero" } }, { g: "launch_video_play", m: { section: "demo" } }]);
  });

  it("names arc and brave, which send chrome's user agent", async () => {
    property(win.navigator, "brave", {});
    const [page] = await load();
    expect(page).toMatchObject({ e: "pageview", b: "brave" });
  });

  it.each([
    ['<a href="/docs">Read the setup guide today</a>', "click", { label: "read_the_setup_guide", to: "/docs" }],
    ['<button data-period="Year Plan" aria-label="Choose yearly">ignored</button>', "click", { label: "choose_yearly", value: "year_plan" }],
    ['<div role="button" data-dusk-label="Pick a platform" data-platform="Mac OS"><span>pick</span></div>', "click", { label: "pick_a_platform", value: "mac_os" }],
    ['<button data-dusk-goal="hero_click" data-dusk-label="Start now">start</button>', "hero_click", { label: "start_now" }],
    ['<a href="/dashboard">Start now</a>', "cta_click", { label: "start_now", to: "/dashboard", from: "/pricing" }],
    ['<a href="https://elsewhere.example/">More info</a>', "outbound", { label: "more_info", host: "elsewhere.example" }],
  ])("adds click context for %s", async (html, goal, meta) => {
    await load();
    click(`<section class="wrap pricing-table">${html}</section>`, "span, a, button, [role=button]");
    await events();
    expect(payloads[1]).toMatchObject({ g: goal, m: { ...meta, section: "pricing_table" } });
    expect(Object.keys(payloads[1]!.m!).length).toBeLessThanOrEqual(5);
  });

  it.each([
    '<button>email person@example.com</button>', '<button>order 12345</button>', '<button></button>',
    '<input type="button" value="private">', '<textarea>private</textarea>', '<select><option>private</option></select>',
    '<div data-dusk-ignore><button>ignore</button></div>', '<div contenteditable="true" role="button">typed words</div>',
    '<button><span contenteditable="true">typed words</span></button>',
  ])("does not capture private or ignored clicks: %s", async html => {
    await load();
    click(html, "button, input, textarea, option, [role=button]");
    expect(await events()).toHaveLength(1);
  });

  it("bounds click labels and prefers an explicit section name and value", async () => {
    await load();
    click(`<section id="fallback" data-dusk-section="Hero / Intro"><button data-dusk-label="${"A".repeat(60)}" data-dusk-value="Pro Plan" data-period="month">start</button></section>`, "button");
    await events();
    expect(payloads[1]!.m).toEqual({ section: "hero_intro", label: "a".repeat(40), value: "pro_plan" });
  });

  it.each([
    ["/download/mac", "download", "", "mac"], ["/Dusk.DMG", "download", "", "mac"],
    ["/dusk.exe", "download", "", "windows"], ["/dusk.msi", "download", "", "windows"],
    ["/dusk.appimage", "download", "", "linux"], ["/dusk.deb", "download", "", "linux"], ["/dusk.rpm", "download", "", "linux"],
    ["https://apps.apple.com/app/dusk", "download", "", "ios"], ["https://play.google.com/store/apps/dusk", "download", "", "android"],
    ["/download/ios", "download", "", "ios"], ["/download/android", "download", "", "android"],
    ["/download", "Get Windows", "", "windows"], ["/download", "Get Linux", "", "linux"], ["/download", "Get Mac", "", "mac"],
    ["/download/mac", "download", 'data-dusk-platform="Windows"', "windows"], ["/download", "download", "", undefined],
  ])("records the download platform for %s (%s)", async (href, label, attr, platform) => {
    await load();
    click(`<section id="downloads"><a href="${href}" ${attr}>${label}</a></section>`);
    await events();
    expect(payloads[1]).toMatchObject({ g: "download_click", m: { section: "downloads", label: label.toLowerCase().replace(/ /g, "_") } });
    expect(payloads[1]!.m!.value).toBe(platform);
  });

  it("reports rage clicks once per burst, within the time and distance limits", async () => {
    await load();
    win.document.body.innerHTML = '<section id="hero"><button>Start now</button></section>';
    const press = (x: number, y: number, ms: number) => {
      now += ms;
      win.document.querySelector("button")!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
    };
    press(10, 10, 0);
    press(20, 10, 350);
    press(10, 40, 350);
    press(10, 10, 0);
    await events();
    expect(payloads.filter(p => p.g === "rage_click")).toEqual([expect.objectContaining({ m: { section: "hero", label: "start_now" } })]);
    press(10, 10, 701);
    press(40, 40, 0);
    press(40, 40, 0);
    await events();
    expect(payloads.filter(p => p.g === "rage_click")).toHaveLength(1);
    press(40, 40, 0);
    await events();
    expect(payloads.filter(p => p.g === "rage_click")).toHaveLength(2);
    win.history.pushState(null, "", "/next");
    press(40, 40, 0);
    press(40, 40, 0);
    await events();
    expect(payloads.filter(p => p.g === "rage_click")).toHaveLength(2);
  });

  it("caps errors at five per view and sends neither messages nor stacks", async () => {
    await load();
    for (let i = 0; i < 7; i++) win.dispatchEvent(new win.ErrorEvent("error", { message: "private@example.com", error: new Error("secret") }));
    win.dispatchEvent(new win.Event("unhandledrejection"));
    await events();
    expect(payloads.filter(p => p.g === "js_error").map(p => p.m)).toEqual(Array(5).fill({ label: "error", value: "error" }));
    win.history.pushState(null, "", "/next");
    win.dispatchEvent(new win.Event("unhandledrejection"));
    await events();
    expect(payloads.at(-1)).toMatchObject({ g: "js_error", m: { label: "rejection" } });
    expect(JSON.stringify(payloads)).not.toMatch(/private|secret|stack/);
  });

  it.each(["pagehide", "spa"])("tracks form starts and abandons each form only once on %s", async end => {
    await load();
    win.document.body.innerHTML = '<section id="signup"><form id="Join Waitlist"><input type="text" value="private words"><input type="email" value="person@example.com"></form><form data-dusk-goal="Contact Us"><input type="email"></form><form><input type="email"></form><form id="no-email"><input></form></section>';
    const fields = win.document.querySelectorAll("input");
    for (const field of fields) field.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
    fields[0]!.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
    if (end === "pagehide") win.dispatchEvent(new win.Event("pagehide"));
    else win.history.pushState(null, "", "/next");
    win.dispatchEvent(new win.Event("pagehide"));
    await events();
    const labels = ["join_waitlist", "contact_us", "form"];
    expect(payloads.filter(p => p.g === "form_start").map(p => p.m)).toEqual(labels.map(label => ({ section: "signup", label })));
    expect(payloads.filter(p => p.g === "form_abandon").map(p => p.m)).toEqual(labels.map(label => ({ section: "signup", label })));
    expect(JSON.stringify(payloads)).not.toMatch(/private words|person@example/);
  });

  it("does not count a tab switch as abandoning a form, only a real leave", async () => {
    await load();
    win.document.body.innerHTML = '<form id="signup"><input type="email"></form>';
    win.document.querySelector("input")!.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
    visibility("hidden");
    visibility("visible");
    await events();
    expect(payloads.filter(p => p.g === "form_abandon")).toHaveLength(0);
    visibility("hidden");
    win.dispatchEvent(new win.Event("pagehide"));
    await events();
    expect(payloads.filter(p => p.g === "form_abandon")).toHaveLength(1);
  });

  it("does not abandon submitted forms and restarts form tracking for a new view", async () => {
    await load();
    win.document.body.innerHTML = '<form id="signup"><input type="email"></form>';
    const focus = () => win.document.querySelector("input")!.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
    focus();
    win.document.querySelector("form")!.dispatchEvent(new win.Event("submit", { bubbles: true }));
    visibility("hidden");
    visibility("visible");
    focus();
    win.history.pushState(null, "", "/next");
    focus();
    win.dispatchEvent(new win.Event("pagehide"));
    await events();
    expect(payloads.filter(p => p.g === "form_start")).toHaveLength(2);
    expect(payloads.filter(p => p.g === "form_abandon")).toHaveLength(1);
    expect(payloads.find(p => p.g === "form_abandon")!.pv).toBe(payloads.at(-1)!.pv);
  });

  it("accumulates half-visible sections, excludes hidden time and deduplicates nested names", async () => {
    const observers: { callback: (entries: object[]) => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    property(win, "IntersectionObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(public callback: (entries: object[]) => void, options: object) {
        expect(options).toEqual({ threshold: 0.5 });
        observers.push(this);
      }
    });
    win.document.body.innerHTML = '<section data-dusk-section="Hero / Intro"><section id="hero_intro"></section></section><section class="wrap pricing-table"></section><section class="wrap"></section><section id="brief"></section><section id="pricing-table"></section>';
    const nodes = win.document.querySelectorAll("section");
    await load();
    const intersect = (index: number, ratio: number) => observers[0]!.callback([{ target: nodes[index], isIntersecting: ratio > 0, intersectionRatio: ratio }]);
    expect(observers[0]!.observe.mock.calls.map(call => call[0])).toEqual([nodes[0], nodes[2], nodes[4], nodes[5]]);
    intersect(0, 0.5);
    intersect(2, 0.49);
    intersect(4, 1);
    now += 200;
    intersect(4, 0);
    intersect(2, 1);
    intersect(5, 1);
    now += 300;
    intersect(0, 0);
    now += 100;
    visibility("hidden");
    win.dispatchEvent(new win.Event("pagehide"));
    await events();
    expect(payloads.filter(p => p.e === "sections").map(p => p.l)).toEqual([[["hero_intro", 500], ["pricing_table", 400]]]);
    now += 5000;
    visibility("visible");
    now += 350;
    win.document.body.innerHTML = '<section id="next"></section>';
    win.history.pushState(null, "", "/next");
    await events();
    expect(payloads.filter(p => p.e === "sections").at(-1)).toMatchObject({ p: "/pricing", pv: payloads[0]!.pv, l: [["pricing_table", 350]] });
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(observers[1]!.observe).toHaveBeenCalledWith(win.document.querySelector("section"));
    observers[0]!.callback([{ target: nodes[0], isIntersecting: true, intersectionRatio: 1 }]);
    observers[1]!.callback([{ target: win.document.querySelector("section"), isIntersecting: true, intersectionRatio: 1 }]);
    now += 300;
    win.dispatchEvent(new win.Event("pagehide"));
    await events();
    expect(payloads.filter(p => p.e === "sections").at(-1)).toMatchObject({ p: "/next", l: [["next", 300]] });
  });

  it("limits section batches to thirty and works without IntersectionObserver", async () => {
    let observe!: (entries: object[]) => void;
    property(win, "IntersectionObserver", class {
      constructor(callback: typeof observe) { observe = callback; }
      observe() {}
      disconnect() {}
    });
    win.document.body.innerHTML = Array.from({ length: 31 }, (_, i) => `<section id="section_${i}"></section>`).join("");
    await load();
    observe(Array.from(win.document.querySelectorAll("section"), target => ({ target, isIntersecting: true, intersectionRatio: 1 })));
    now += 300;
    win.dispatchEvent(new win.Event("pagehide"));
    await events();
    expect(payloads.find(p => p.e === "sections")!.l).toHaveLength(30);
    property(win, "IntersectionObserver", undefined);
    win.history.pushState(null, "", "/next");
    now += 500;
    win.dispatchEvent(new win.Event("pagehide"));
    await events();
    expect(payloads.filter(p => p.e === "sections")).toHaveLength(1);
    expect(payloads.at(-1)).toMatchObject({ e: "leave", p: "/next" });
  });

  it.each(["/dashboard", "/dashboard/signup", "/app", "/signup/new", "https://preview.dusk.bot/dashboard/billing"])("tracks CTA %s", async href => {
    await load();
    click(`<a href="${href}"><span>start</span></a>`, "span");
    await events();
    expect(payloads[1]).toMatchObject({ g: "cta_click", m: { to: new URL(href, win.location.href).pathname, from: "/pricing" } });
  });

  it.each(["/download/mac", "https://cdn.example/Dusk.DMG?token=private", "/dusk.exe", "/dusk.msi", "/dusk.appimage", "/dusk.deb", "/dusk.rpm"])("tracks download %s", async href => {
    await load();
    click(`<a href="${href}">download</a>`);
    await events();
    expect(payloads[1]).toMatchObject({ g: "download_click", m: { to: new URL(href, win.location.href).pathname } });
  });

  it("tracks external hosts without leaking URLs or misclassifying suffix lookalikes", async () => {
    await load();
    click('<a href="https://evilpreview.dusk.bot/signup?email=a@b.c">external</a>');
    await events();
    expect(payloads[1]).toMatchObject({ g: "outbound", m: { host: "evilpreview.dusk.bot" } });
    click('<a href="mailto:a@b.c">email</a>');
    now += 701;
    click('<a href="/docs">docs</a>');
    expect(await events()).toHaveLength(3);
    expect(payloads[2]).toMatchObject({ g: "click", m: { label: "docs", section: "", to: "/docs" } });
  });

  it.each(["id", "class", "action", "name"])("tracks valid waitlist forms by %s without sending email", async attr => {
    await load();
    submit(`<form ${attr}="join-waitlist"><input type="email" value="person@example.com"></form>`);
    await events();
    expect(payloads[1]).toMatchObject({ e: "goal", g: "waitlist_join" });
    expect(payloads[1]).not.toHaveProperty("m");
    expect(JSON.stringify(payloads)).not.toContain("person@example.com");
  });

  it("tracks the dusk.bot waitlist form by its wl-form class", async () => {
    await load();
    submit('<form class="wl-form" data-wl-form novalidate><input type="email" value="person@example.com"></form>');
    await events();
    expect(payloads[1]).toMatchObject({ e: "goal", g: "waitlist_join" });
  });

  it("ignores invalid waitlist forms and honors explicit form goals", async () => {
    await load();
    submit('<form id="waitlist"><input type="email" value="invalid"></form>');
    submit('<form><input type="email" value="a@b.c"></form>');
    submit('<form id="waitlist" data-dusk-goal="custom_join" data-dusk-placement="footer"><input type="email" value="a@b.c"></form>');
    await events();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ g: "custom_join", m: { placement: "footer" } });
  });

  it("sends leave for the old path before a fresh SPA pageview", async () => {
    await load();
    const initial = payloads[0]!;
    now += 250;
    win.history.pushState(null, "", "/signup?utm_source=spa");
    await events();
    expect(payloads.map(p => p.e)).toEqual(["pageview", "leave", "pageview"]);
    expect(payloads[1]).toMatchObject({ pv: initial.pv, p: "/pricing", s: 25, t: 250 });
    expect(payloads[2]).toMatchObject({ p: "/signup", u: { utm_source: "spa" } });
    expect(payloads[2]!.pv).not.toBe(initial.pv);
    expect(payloads[2]!.sid).toBe(initial.sid);
    win.history.replaceState(null, "", "/signup?ref=query_only#hash");
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    expect(await events()).toHaveLength(3);
    win.history.replaceState(null, "", "/next");
    await events();
    expect(payloads.slice(-2).map(p => p.e)).toEqual(["leave", "pageview"]);
    win.happyDOM.setURL("https://preview.dusk.bot/back");
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await events();
    expect(payloads.at(-1)!.p).toBe("/back");
  });

  it("reports cumulative scroll and visible time on hides and pagehide", async () => {
    await load();
    property(win, "scrollY", 1000);
    win.dispatchEvent(new win.Event("scroll"));
    now += 120;
    visibility("hidden");
    await events();
    expect(payloads[1]).toMatchObject({ e: "leave", s: 75, t: 120, f: 4 });
    now += 5000;
    visibility("visible");
    property(win, "scrollY", 0);
    now += 80;
    visibility("hidden");
    win.dispatchEvent(new win.Event("pagehide"));
    await events();
    expect(payloads.slice(-2)).toEqual([expect.objectContaining({ s: 75, t: 200 }), expect.objectContaining({ s: 75, t: 200 })]);
    expect(new Set(payloads.map(p => p.pv)).size).toBe(1);
  });

  it("suppresses empty hides but always closes a view on pathname changes", async () => {
    property(win.document, "visibilityState", "hidden");
    property(win, "innerHeight", 0);
    await load();
    visibility("hidden");
    win.dispatchEvent(new win.Event("pagehide"));
    expect(await events()).toHaveLength(1);
    win.history.pushState(null, "", "/next");
    await events();
    expect(payloads.map(p => p.e)).toEqual(["pageview", "leave", "pageview"]);
    expect(payloads[1]).toMatchObject({ s: 0, t: 0 });
  });

  it("waits through prerender and replays queued goals after the pageview", async () => {
    property(win.document, "visibilityState", "prerender");
    win.dusk = function () { (win.dusk!.q = win.dusk!.q || []).push(arguments); };
    win.dusk("queued");
    expect(await load()).toHaveLength(0);
    now += 1000;
    visibility("visible");
    await events();
    expect(payloads.map(p => p.e)).toEqual(["pageview", "goal"]);
    now += 50;
    visibility("hidden");
    await events();
    expect(payloads.at(-1)!.t).toBe(50);
  });

  it.each(["false", "missing", "throws"])("falls back to fetch when beacon %s", async mode => {
    if (mode === "false") beacon.mockReturnValue(false);
    if (mode === "missing") property(win.navigator, "sendBeacon", undefined);
    if (mode === "throws") beacon.mockImplementation(() => { throw new Error("unavailable"); });
    await load();
    win.dusk!("later");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual(["https://t.example/v1/t", {
      method: "POST", body: expect.any(String), keepalive: true, headers: { "content-type": "text/plain" },
    }]);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({ e: "goal", g: "later" });
  });

  it("swallows storage, transport and public API errors", async () => {
    property(win, "localStorage", { getItem() { throw new Error("blocked"); } });
    beacon.mockImplementation(() => { throw new Error("blocked"); });
    fetch.mockRejectedValue(new Error("offline"));
    await expect(load()).resolves.toEqual([]);
    expect(() => win.dusk!("goal", { get value() { throw new Error("getter"); } })).not.toThrow();
    expect(() => win.history.pushState(null, "", "https://other.example/")).not.toThrow();
    expect(() => visibility("hidden")).not.toThrow();
    await Promise.resolve();
  });

  it("pings every minute while the page is visible, and again when it comes back", async () => {
    const timers: Array<() => void> = [];
    vi.spyOn(win, "setInterval").mockImplementation(((fn: () => void, ms: number) => { if (ms === 60000) timers.push(fn); return 1; }) as typeof win.setInterval);
    await load();
    expect(timers).toHaveLength(1);
    timers[0]!();
    let sent = await events();
    expect(sent.filter(p => p.e === "ping")).toEqual([expect.objectContaining({ v: 1, e: "ping", p: "/pricing", h: "preview.dusk.bot" })]);
    visibility("hidden");
    timers[0]!();
    sent = await events();
    expect(sent.filter(p => p.e === "ping")).toHaveLength(1);
    visibility("visible");
    sent = await events();
    expect(sent.filter(p => p.e === "ping")).toHaveLength(2);
  });

  it("fits the gzip budget", () => {
    expect(gzipSync(source).length).toBeLessThanOrEqual(5440);
  });
});
