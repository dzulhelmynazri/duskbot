## Cookie policy

Effective date: 12 November 2026. Last updated: 15 November 2026.

This policy lists the cookies and browser storage that madani bot uses on madani.bot, including the website, the account dashboard at madani.bot/dashboard, the admin and the API. It also covers the preview site at preview.madani.bot, which works the same way. Our [privacy policy](privacy.md) explains the data behind them.

We do not use advertising cookies, and we do not use third-party analytics or tracking cookies. Every cookie below is set by madani.bot itself, and none is shared with anyone else.

## Strictly necessary cookies

These cookies are needed for signing in and keeping your account secure. They are set only when you use the account dashboard, and they do not need consent. If you block them, sign-in and account functions will not work.

| Name | Purpose | Lasts |
| --- | --- | --- |
| `madani_dash` | Keeps you signed in. HttpOnly, so page scripts cannot read it. | 30 days from sign-in |
| `madani_csrf` | Protects requests that change your account against cross-site request forgery. | 30 days from sign-in |
| `madani_oauth` | Remembers a sign-in with Google or Apple while you are away at that provider. | 10 minutes |

Cloudflare, which sits in front of madani.bot, may set its own strictly necessary security cookies, such as `__cf_bm`, to tell people apart from abusive automated traffic. They do not track you across sites.

## Analytics cookies

Our own small analytics script counts page views, sign-up and download clicks, scrolling and time on page. It sets two first-party cookies, and only outside the EU, the EEA, the UK and Switzerland:

| Name | Purpose | Lasts |
| --- | --- | --- |
| `madani_vid` | A random visitor id, so we can count returning visitors. | 1 year |
| `madani_sid` | A random visit id, so we can group the pages of one visit. | 30 minutes without activity |

If Cloudflare places your connection in the EU, the EEA, the UK or Switzerland, or cannot tell where you are, the script sets no cookies and uses no browser storage, and removes `madani_vid` and `madani_sid` if an earlier visit left them. Our server then counts visits with an id that changes every day and cannot be traced back to you. The privacy policy describes this under Product analytics.

The script does nothing at all when your browser sends Global Privacy Control or Do Not Track.

## Local and session storage

| Name | Where | Purpose | Lasts |
| --- | --- | --- | --- |
| `madani-dash-theme` | Dashboard, local storage | Your light or dark theme choice. | Until you clear it |
| `madani-dash-notify` | Dashboard, local storage | Your notification preferences on this browser. | Until you clear it |
| `madani-dash-visit` | Dashboard, session storage | A random visit id for our first-party product analytics. | Until you close the tab |
| Other `madani-dash-*`, `madani-onboarding-step` and `madani-admin-*` items | Dashboard, local and session storage | Interface state only: the workspace you picked, hints you dismissed, your onboarding step and a pending deletion confirmation. | Until you clear it, or until you close the tab for session storage |
| `madani_ignore` | Website, local storage | Turns our analytics off on this browser. Set only if you visit a page with `?madani_ignore=1`. | Until you clear it |

## The apps

The desktop and phone apps do not use browser cookies. They keep their settings on your device and use a random install id for the anonymous usage info described in the privacy policy, which you can switch off under Settings, Privacy, "help improve madani bot".

## Your choices

You can block or delete cookies and storage in your browser's settings. Blocking the strictly necessary cookies stops sign-in from working. Blocking the analytics cookies has no effect on the site. You can also turn our analytics off on a browser by visiting any page with `?madani_ignore=1`, or by turning on Global Privacy Control.

## Changes and contact

If we add a cookie or change what one does, we update this page and its date. For questions, email privacy@madani.bot.
