// first-party marketing analytics tracker
// ideas from Minilytics (MIT, Copyright (c) 2026 surendrapandar)
(function () {
  "use strict";
  function noop() {}
  function safe(fn) {
    return function () { try { return fn.apply(this, arguments); } catch (e) {} };
  }
  try {
    var w = window, d = document, n = navigator, loc = w.location;
    var queue = (w.madani && w.madani.q) || [];
    w.madani = noop;
    var script = d.currentScript;
    var endpoint = (script && script.getAttribute("data-api")) || "/v1/t";
    var ignored = false;
    try {
      var ignore = new URLSearchParams(loc.search).get("madani_ignore");
      if (ignore === "1") w.localStorage.setItem("madani_ignore", "1");
      if (ignore === "0") w.localStorage.removeItem("madani_ignore");
      ignored = w.localStorage.getItem("madani_ignore") === "1";
    } catch (e) { ignored = ignore === "1"; }
    var local = /^(localhost|0\.0\.0\.0|\[::1\])$|^127\.|\.local$/i.test(loc.hostname) || loc.protocol === "file:";
    if (ignored || n.webdriver || n.globalPrivacyControl === true || n.doNotTrack === "1" ||
        (local && !(script && script.hasAttribute("data-allow-local"))) ||
        /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|python|curl|wget/i.test(n.userAgent)) return;

    function read(name) {
      try {
        var match = d.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
        return match ? match[1] : "";
      } catch (e) { return ""; }
    }
    var vid = read("madani_vid"), sid = read("madani_sid"), first = !sid;
    // nothing is stored until the service answers a page view with {persist: true}; where consent would be needed it
    // answers false and ids live only in this page
    var keep = null, asking = false, domain = "", parts = loc.hostname.split("."), domains = [];
    var suffix = "; path=/; SameSite=Lax" + (loc.protocol === "https:" ? "; Secure" : "");
    if (parts.length > 1 && !/^\d+$/.test(parts[parts.length - 1])) for (var i = parts.length - 2; i >= 0; i--) domains.push(parts.slice(i).join("."));
    function cookie(name, value, age, at) {
      try { d.cookie = name + "=" + value + suffix + "; max-age=" + age + (at ? "; domain=" + at : ""); } catch (e) {}
    }
    function remember(persist) {
      keep = persist;
      if (!persist) {
        ["madani_vid", "madani_sid"].forEach(function (name) {
          if (read(name)) [""].concat(domains).forEach(function (at) { cookie(name, "", 0, at); });
        });
        return;
      }
      if (!domain) domains.some(function (candidate) {
        cookie("madani_test", 1, 60, candidate);
        if (read("madani_test")) { cookie("madani_test", "", 0, candidate); domain = candidate; }
        return domain;
      });
      cookie("madani_vid", vid, 31536000, domain);
      cookie("madani_sid", sid, 1800, domain);
    }
    function random(bytes) {
      var data = new Uint8Array(bytes), binary = "";
      w.crypto.getRandomValues(data);
      for (var j = 0; j < data.length; j++) binary += String.fromCharCode(data[j]);
      return w.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    }
    vid = vid || random(16);
    sid = sid || random(16);
    var pv, path, pagePath, depth = 0, folds = 0, engaged = 0, since = null;
    var sections = [], observer, forms = [], errors = 0, rage;
    function slug(value) {
      return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "");
    }
    function sectionName(el) {
      var classes = (el.getAttribute("class") || "").split(/\s+/).filter(function (name) { return name && name !== "wrap"; });
      return slug(el.getAttribute("data-madani-section") || el.id || classes[0]);
    }
    function sectionOf(el) {
      var section = el.closest("[data-madani-section], section");
      return section ? sectionName(section) : "";
    }
    function labelOf(el) {
      if (el.closest('[contenteditable]:not([contenteditable="false"])')) return "";
      var label = el.getAttribute("data-madani-label") || el.getAttribute("aria-label") ||
        (!el.querySelector("input,textarea,select,[contenteditable]") && el.textContent) || "";
      return /@|\d{4}/.test(label) ? "" : slug(label.trim().split(/\s+/).slice(0, 4).join(" "));
    }
    function scanSections() {
      if (observer) observer.disconnect();
      sections = [];
      if (!w.IntersectionObserver) return;
      var targets = [], view = pv;
      observer = new w.IntersectionObserver(safe(function (entries) {
        if (pv !== view) return;
        time();
        entries.forEach(function (entry) {
          targets.forEach(function (target) {
            if (target.el !== entry.target) return;
            var visible = entry.isIntersecting && entry.intersectionRatio >= 0.5;
            if (visible !== target.visible) target.section.visibleCount += visible ? 1 : -1;
            target.visible = visible;
          });
        });
      }), { threshold: 0.5 });
      Array.prototype.forEach.call(d.querySelectorAll("section, [data-madani-section]"), function (el) {
        var name = sectionName(el), parent = el.parentElement;
        if (!name) return;
        while (parent) {
          if (parent.matches("section, [data-madani-section]") && sectionName(parent) === name) return;
          parent = parent.parentElement;
        }
        var section;
        sections.some(function (item) { if (item.name === name) section = item; return !!section; });
        if (!section) { section = { name: name, ms: 0, visibleCount: 0 }; sections.push(section); }
        targets.push({ el: el, section: section, visible: false });
        observer.observe(el);
      });
    }
    function cleanPath(value) {
      return value.split("/").map(function (segment) { return /@|%40/i.test(segment) ? ":id" : segment; }).join("/").slice(0, 200);
    }
    function send(event, extra) {
      if (keep) cookie("madani_sid", sid, 1800, domain);
      var payload = { v: 1, e: event, vid: vid, sid: sid, pv: pv, h: loc.hostname, p: path };
      Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
      var json = JSON.stringify(payload);
      if (keep === null && !asking && event === "pageview") {
        asking = true;
        try {
          return w.fetch(endpoint, { method: "POST", body: json, keepalive: true, credentials: "include", headers: { "content-type": "text/plain" } })
            .then(function (res) { return res.json(); })
            .then(function (answer) { remember(!!answer && answer.persist === true); }, function () { asking = false; });
        } catch (e) { asking = false; }
      }
      try { if (n.sendBeacon && n.sendBeacon(endpoint, new Blob([json], { type: "text/plain" }))) return; } catch (e) {}
      try { w.fetch(endpoint, { method: "POST", body: json, keepalive: true, headers: { "content-type": "text/plain" } }).catch(noop); } catch (e) {}
    }
    function measure() {
      var height = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
      if (height > 0) {
        depth = Math.max(depth, Math.min(100, Math.max(0, Math.round((w.scrollY + w.innerHeight) / height * 100))));
        folds = Math.round(height / w.innerHeight);
      }
    }
    function time() {
      var now = Date.now();
      if (since !== null) {
        var elapsed = Math.max(0, now - since);
        engaged += elapsed;
        sections.forEach(function (section) { if (section.visibleCount) section.ms += elapsed; });
      }
      since = d.visibilityState === "visible" ? now : null;
    }
    function leave(force, real) {
      if (!pv) return;
      measure();
      time();
      var batch = [];
      sections.forEach(function (section) {
        if (section.ms >= 300 && batch.length < 30) batch.push([section.name, Math.round(section.ms)]);
        section.ms = 0;
      });
      if (batch.length) send("sections", { l: batch });
      if (real) forms.forEach(function (form) {
        if (!form.submitted && !form.abandoned) { goal("form_abandon", form.meta); form.abandoned = true; }
      });
      if (force === true || engaged > 0 || depth > 0) send("leave", { s: depth, t: Math.round(engaged), f: folds });
    }
    function pageview() {
      if (d.prerendering || d.visibilityState === "prerender" || (pv && pagePath === loc.pathname)) return;
      leave(true, true);
      pagePath = loc.pathname;
      path = cleanPath(pagePath);
      pv = random(6);
      depth = engaged = 0;
      forms = [];
      errors = 0;
      rage = null;
      since = d.visibilityState === "visible" ? Date.now() : null;
      scanSections();
      measure();
      var extra = { w: w.innerWidth }, utm = {}, params = new URLSearchParams(loc.search);
      // arc and brave send chrome's user agent
      safe(function () { if (n.brave) extra.b = "brave"; else if (w.getComputedStyle(d.documentElement).getPropertyValue("--arc-palette-title")) extra.b = "arc"; })();
      "utm_source utm_medium utm_campaign utm_content utm_term ref via source".split(" ").forEach(function (key) {
        var value = params.get(key);
        if (value !== null && value.indexOf("@") < 0) utm[key] = value.slice(0, 100);
      });
      if (Object.keys(utm).length) extra.u = utm;
      if (first && d.referrer) {
        try { var host = new URL(d.referrer).hostname; if (host && host !== loc.hostname) extra.r = host; } catch (e) {}
      }
      first = false;
      send("pageview", extra);
    }
    var goal = safe(function (name, meta) {
      if (typeof name !== "string" || !/^[a-z0-9_]{1,40}$/.test(name) || !pv) return;
      var extra = { g: name }, clean = Object.create(null);
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        Object.keys(meta).some(function (key) {
          var value = meta[key];
          if (typeof value === "string") clean[key] = value.slice(0, 100);
          return Object.keys(clean).length === 5;
        });
      }
      if (Object.keys(clean).length) extra.m = clean;
      send("goal", extra);
    });
    function attributes(el) {
      var meta = { section: sectionOf(el), label: labelOf(el) };
      for (var k = 0; k < el.attributes.length; k++) {
        var attr = el.attributes[k];
        if (attr.name.startsWith("data-madani-") && !/^data-madani-(goal|section|label)$/.test(attr.name)) meta[attr.name.slice(10)] = attr.value;
      }
      return meta;
    }
    function start() {
      pageview();
      if (!pv) return;
      w.madani = goal;
      for (var q = 0; q < queue.length; q++) goal.apply(null, queue[q]);
      queue = [];
    }
    function ping() { if (pv && d.visibilityState === "visible") send("ping", {}); }
    w.setInterval(safe(ping), 60000);
    d.addEventListener("visibilitychange", safe(function () {
      if (!pv) start();
      else if (d.visibilityState === "visible") { time(); ping(); }
      else leave();
    }));
    // a page prerendered on hover counts only once it is actually opened
    d.addEventListener("prerenderingchange", safe(function () { if (!pv) start(); }));
    w.addEventListener("pagehide", safe(function () { leave(false, true); }));
    w.addEventListener("scroll", safe(measure), { passive: true });
    ["pushState", "replaceState"].forEach(function (method) {
      var original = w.history[method];
      w.history[method] = safe(function () { var result = original.apply(this, arguments); pageview(); return result; });
    });
    w.addEventListener("popstate", safe(pageview));
    ["error", "unhandledrejection"].forEach(function (event) {
      w.addEventListener(event, safe(function (e) {
        if (pv && errors < 5) {
          errors++;
          var c = e.error || e.reason, m = { label: event === "error" ? "error" : "rejection" };
          if (c && c.name) m.value = slug(String(c.name));
          goal("js_error", m);
        }
      }));
    });
    d.addEventListener("click", safe(function (event) {
      var el = event.target;
      if (el && !el.closest) el = el.parentElement;
      if (!el || !el.closest || el.closest("input, textarea, select, [data-madani-ignore]")) return;
      var now = Date.now(), x = event.clientX, y = event.clientY;
      if (!rage || now - rage.at > 700 || Math.pow(x - rage.x, 2) + Math.pow(y - rage.y, 2) > 900) {
        rage = { at: now, x: x, y: y, count: 0 };
      }
      var target = el.closest('a[href], button, [role="button"]') || el;
      var meta = { section: sectionOf(target), label: labelOf(target) };
      if (++rage.count === 3) goal("rage_click", meta);
      var tagged = el.closest("[data-madani-goal]");
      if (tagged) { goal(tagged.getAttribute("data-madani-goal"), attributes(tagged)); return; }
      var link = el.closest("a[href]"), name = "click";
      if (link) {
        var url = new URL(link.href, loc.href), host = url.hostname;
        if (!/^https?:$/.test(url.protocol)) return;
        var internal = host === loc.hostname || host.slice(-(loc.hostname.length + 1)) === "." + loc.hostname;
        if (internal && /^\/(dashboard|app|signup)(\/|$)/.test(url.pathname)) {
          name = "cta_click";
          meta.from = loc.pathname;
        } else if (/\/download|\.(dmg|exe|msi|appimage|deb|rpm)$|apps\.apple|play\.google/i.test(host + url.pathname)) name = "download_click";
        else if (!internal) { name = "outbound"; meta.host = host; }
        if (name !== "outbound") meta.to = url.pathname;
      }
      if (name === "download_click") {
        var destination = (url.hostname + url.pathname).toLowerCase();
        var platform = slug(link.getAttribute("data-madani-platform"));
        if (!platform) {
          if (/\.dmg|mac/.test(destination)) platform = "mac";
          else if (/\.exe|\.msi|win/.test(destination)) platform = "windows";
          else if (/\.appimage|\.deb|\.rpm|linux/.test(destination)) platform = "linux";
          else if (/apps\.apple|ios/.test(destination)) platform = "ios";
          else if (/play\.google|android/.test(destination)) platform = "android";
          else platform = (meta.label.match(/(?:^|_)(mac|windows|linux)(?:_|$)/) || [])[1];
        }
        if (platform) meta.value = platform;
      } else {
        var value = slug(target.getAttribute("data-madani-value") || target.getAttribute("data-period") || target.getAttribute("data-platform"));
        if (value) meta.value = value;
      }
      if (name !== "click" || (target.matches('a[href], button, [role="button"]') && meta.label)) goal(name, meta);
    }), true);
    d.addEventListener("play", safe(function (event) {
      var el = event.target;
      if (!el || !/^(VIDEO|AUDIO)$/.test(el.tagName) || el.closest("[data-madani-ignore]") || el.madaniPlayed === pv) return;
      el.madaniPlayed = pv;
      goal(el.getAttribute("data-madani-goal") || "video_play", attributes(el));
    }), true);
    d.addEventListener("focusin", safe(function (event) {
      var el = event.target;
      if (!el || !el.matches("input, textarea, select") || el.closest("[data-madani-ignore]")) return;
      var form = el.closest("form");
      if (!form || !form.querySelector('input[type="email"]') || forms.some(function (item) { return item.el === form; })) return;
      var meta = { label: slug(form.getAttribute("data-madani-goal") || form.id || "form"), section: sectionOf(form) };
      forms.push({ el: form, meta: meta, submitted: false });
      goal("form_start", meta);
    }), true);
    d.addEventListener("submit", safe(function (event) {
      var form = event.target;
      if (!form || form.tagName !== "FORM") return;
      forms.forEach(function (item) { if (item.el === form) item.submitted = true; });
      if (form.hasAttribute("data-madani-goal")) { goal(form.getAttribute("data-madani-goal"), attributes(form)); return; }
      var email = form.querySelector('input[type="email"]');
      if (/waitlist|\bwl-form\b/i.test([form.id, form.className, form.getAttribute("action"), form.getAttribute("name")].join(" ")) &&
          email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) goal("waitlist_join");
    }), true);
    start();
  } catch (e) {}
})();
