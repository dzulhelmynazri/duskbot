// The dead-click probe: runs inside the page under test (the chat gallery, the real app), finds every control a person
// can press in a scope, presses one, and reports whether anything observable followed within a second: the page
// changed, it navigated or opened something, it sent a request or a message to the desktop app, focus moved, it
// scrolled, copied or played a sound. A control with none of these did nothing, which is the bug this guards against.
//
// `installDeadClickProbe` is serialised with Function.prototype.toString and evaluated in the page, so it must stay
// self-contained: no imports, no closures over module scope.

export interface ClickTarget {
  /** Stable within one render of the scope: role, accessible name and the position among controls of that name. */
  key: string;
  role: string;
  name: string;
  /** The control's opening tag, for the report. */
  html: string;
  /** Why it is not pressed (it would leave the test or end the session); null when it is. */
  skipped: string | null;
}

export interface ClickResult {
  key: string;
  /** What followed the press; empty means a dead click. */
  effects: string[];
  /** The control vanished before it could be pressed. */
  missing?: boolean;
  /** Something else sits on top of it, so a person cannot press it here. */
  covered?: boolean;
  /** It is the choice already made. */
  chosen?: boolean;
}

export interface DeadClickProbe {
  targets(scope?: string): ClickTarget[];
  press(key: string, scope?: string, waitMs?: number): Promise<ClickResult>;
}

export function installDeadClickProbe(): void {
  const w = window as unknown as Record<string, unknown> & Window;
  if (w.__deadClicks) return;
  const CONTROL = [
    "button", "a[href]", "summary", "[role=button]", "[role=link]", "[role=menuitem]", "[role=menuitemcheckbox]",
    "[role=menuitemradio]", "[role=tab]", "[role=switch]", "[role=checkbox]", "[role=radio]", "[role=option]",
    "input[type=checkbox]", "input[type=radio]", "input[type=button]", "input[type=submit]", "label[for]",
  ].join(",");
  // presses that would leave the test (a real browser, a payment, quitting) or throw away the fixture's session
  const RISKY = /\b(quit|sign ?out|log ?out|uninstall|restart|relaunch|buy|checkout|upgrade|subscribe|pay now|delete (account|everything)|erase|factory reset)\b/i;

  const counters = { requests: 0, ipc: 0, opened: 0, copied: 0, played: 0, scrolled: 0, navigations: 0 };
  const wrap = <T extends object>(owner: T, key: keyof T, count: keyof typeof counters) => {
    const original = owner[key] as unknown as (...args: unknown[]) => unknown;
    if (typeof original !== "function") return;
    try {
      (owner as Record<string, unknown>)[key as string] = function (this: unknown, ...args: unknown[]) { counters[count] += 1; return original.apply(this, args); };
    } catch { /* read-only: left unobserved */ }
  };
  wrap(w, "fetch" as never, "requests");
  wrap(XMLHttpRequest.prototype, "send", "requests");
  wrap(WebSocket.prototype, "send", "requests");
  wrap(navigator, "sendBeacon" as never, "requests");
  wrap(w, "open" as never, "opened");
  wrap(HTMLMediaElement.prototype, "play", "played");
  wrap(HTMLAnchorElement.prototype, "click", "opened");
  wrap(HTMLFormElement.prototype, "requestSubmit", "requests");
  if (navigator.clipboard) { wrap(navigator.clipboard, "writeText", "copied"); wrap(navigator.clipboard, "write", "copied"); }
  wrap(document, "execCommand" as never, "copied");
  // the desktop app's bridge: every call is a message to the main process
  const bridge = w.madaniDesktop as Record<string, unknown> | undefined;
  const watchBridge = (node: Record<string, unknown> | undefined, depth: number) => {
    if (!node || depth > 2) return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "function") wrap(node, key as never, "ipc");
      else if (value && typeof value === "object") watchBridge(value as Record<string, unknown>, depth + 1);
    }
  };
  watchBridge(bridge, 0);
  // a link the page follows itself (a hash, the router) changes the address; an external one is a request to leave
  addEventListener("hashchange", () => { counters.navigations += 1; });
  addEventListener("popstate", () => { counters.navigations += 1; });
  for (const method of ["pushState", "replaceState"] as const) wrap(history, method, "navigations");
  document.addEventListener("scroll", () => { counters.scrolled += 1; }, true);

  const visible = (element: Element) => {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05 && !element.closest("[inert],[aria-hidden=true]");
  };
  const nameOf = (element: Element) => (element.getAttribute("aria-label") || (element as HTMLElement).innerText || element.getAttribute("title") || element.getAttribute("value") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const roleOf = (element: Element) => element.getAttribute("role") || element.tagName.toLowerCase();
  const disabled = (element: Element) => (element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true" || Boolean(element.closest("fieldset[disabled]"));

  const list = (scope = "body") => {
    const root = document.querySelector(scope) ?? document.body;
    const seen = new Map<string, number>();
    const found: Array<{ element: Element; target: ClickTarget }> = [];
    for (const element of root.querySelectorAll(CONTROL)) {
      // a control inside another control is pressed through its parent
      if (element.parentElement?.closest(CONTROL) && element.parentElement.closest(CONTROL) !== element && root.contains(element.parentElement.closest(CONTROL))) continue;
      if (!visible(element) || disabled(element) || element.closest("[data-dead-click-skip]")) continue;
      const role = roleOf(element);
      const name = nameOf(element);
      const base = `${role}:${name}`;
      const index = seen.get(base) ?? 0;
      seen.set(base, index + 1);
      const href = element instanceof HTMLAnchorElement ? element.getAttribute("href") ?? "" : "";
      const external = Boolean(href) && !href.startsWith("#") && (() => { try { return new URL(href, location.href).origin !== location.origin; } catch { return false; } })();
      // pressing the tab, option or radio already chosen rightly does nothing
      const chosen = /^(tab|radio|option|menuitemradio)$/.test(role) && (element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-checked") === "true" || (element as HTMLInputElement).checked === true);
      const skipped = external ? "a link out of the app" : RISKY.test(name) ? "leaves the test or ends the session" : chosen ? "already chosen" : null;
      found.push({ element, target: { key: `${base}#${index}`, role, name, html: element.outerHTML.slice(0, element.outerHTML.indexOf(">") + 1).slice(0, 240), skipped } });
    }
    return found;
  };

  const press = async (key: string, scope = "body", waitMs = 1000): Promise<ClickResult> => {
    const hit = list(scope).find((one) => one.target.key === key);
    if (!hit) return { key, effects: [], missing: true };
    const element = hit.element as HTMLElement;
    element.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    // a person can only press what is on top: a control under a dialog's backdrop is not theirs to press
    const spot = element.getBoundingClientRect();
    const top = document.elementFromPoint(spot.x + spot.width / 2, spot.y + spot.height / 2);
    if (top && top !== element && !element.contains(top) && !(element instanceof HTMLLabelElement)) return { key, effects: [], covered: true };
    // the shape, tab or option already chosen rightly does nothing when chosen again (state can differ from the listing)
    const chosen = element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-checked") === "true"
      || element.getAttribute("aria-current") === "page" || element.getAttribute("aria-current") === "true"
      || (element.getAttribute("aria-pressed") === "true" && Boolean(element.closest("[role=group],[role=radiogroup],[role=toolbar]")));
    if (chosen) return { key, effects: [], chosen: true };
    // what moves by itself (clocks, spinners, a typing line) is learned first and not counted as the press's doing
    const restless = new Set<Node>();
    const learn = new MutationObserver((records) => { for (const record of records) restless.add(record.target); });
    learn.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    await new Promise((done) => setTimeout(done, 200));
    learn.disconnect();
    const changed: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        if (restless.has(record.target)) continue;
        // the press's own focus ring and pressed look are not an effect
        if (record.type === "attributes" && record.target === element && /^(class|style|data-focus|data-pressed|data-active)/.test(record.attributeName ?? "")) continue;
        changed.push(record.type === "attributes" ? `attr ${record.attributeName}` : record.type);
      }
    });
    watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const before = { ...counters, href: location.href, active: document.activeElement, resources: performance.getEntriesByType("resource").length };
    const opens: string[] = [];
    const leave = (event: Event) => {
      // a link that would load another page is the effect; it is stopped so the run stays on this page
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (anchor && !anchor.getAttribute("href")?.startsWith("#") && !event.defaultPrevented) { opens.push(anchor.href); event.preventDefault(); }
    };
    document.addEventListener("click", leave);
    // a person's press, in the order a mouse sends it: menus that open on pointer down see it too
    const box = element.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
    element.dispatchEvent(new PointerEvent("pointerdown", { ...at, buttons: 1 }));
    element.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
    element.dispatchEvent(new PointerEvent("pointerup", at));
    element.dispatchEvent(new MouseEvent("mouseup", at));
    element.click();
    const seenEffects = () => {
      const effects: string[] = [];
      if (changed.length) effects.push(`dom (${[...new Set(changed)].slice(0, 3).join(", ")})`);
      if (location.href !== before.href || counters.navigations > before.navigations) effects.push("navigation");
      if (opens.length || counters.opened > before.opened) effects.push("opened");
      if (counters.requests > before.requests || performance.getEntriesByType("resource").length > before.resources) effects.push("request");
      if (counters.ipc > before.ipc) effects.push("ipc");
      if (counters.copied > before.copied) effects.push("copy");
      if (counters.played > before.played) effects.push("sound");
      if (counters.scrolled > before.scrolled + 1) effects.push("scroll");
      if (document.activeElement !== before.active && document.activeElement !== element && document.activeElement !== document.body) effects.push("focus");
      return effects;
    };
    // the first sign of an effect ends the wait (and the press settles a moment); only a dead press waits the full time
    const until = performance.now() + waitMs;
    let effects = seenEffects();
    while (!effects.length && performance.now() < until) {
      await new Promise((done) => setTimeout(done, 40));
      effects = seenEffects();
    }
    if (effects.length) await new Promise((done) => setTimeout(done, 250));
    document.removeEventListener("click", leave);
    watch.disconnect();
    return { key, effects };
  };

  const probe: DeadClickProbe = { targets: (scope) => list(scope).map((one) => one.target), press };
  Object.assign(w, { __deadClicks: probe });
}
