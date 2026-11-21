# What a bot can do on its VPS desktop

A bot with a computer on the person's VPS gets three kinds of tools for it:

- the Cua Driver screen tools (`get_window_state`, `run_steps`, `click`, `type_text`, `launch_app`, ...), through
  `server/vps-container-mcp.ts`;
- `vm_exec`, a shell command inside that desktop as its desktop user, starting in `/home/cua/workspace`, with the exit
  code, stdout and stderr returned (`server/vps-exec.ts`);
- `attach_file` with a `/home/cua/...` path, which copies the file (12 MB at most) from the desktop into the chat.

`vm_exec` and `attach_file` pass the same control gate as screen calls: while a person holds the computer they wait
and then refuse with the take-control text, and they wake a lazily claimed computer the same way.

The bot's own shell tool (Codex `exec_command`, Claude `Bash`) runs on the server, not in the desktop. The VPS prompt
paragraph says so, because a bot that runs `ls /home/cua/workspace` there finds nothing.

## Signing in with the Vault on the desktop

`fill_login` works on the VPS desktop itself (`server/host/desktop-login.ts`, `server/box-login-page.ts`). It passes the
same control gate as a screen call, then reaches the desktop's Chromium over its DevTools relay (`vpsBoxChrome`), picks
the page in front (the focused window's tab, else the only one showing), and runs the same fill as the built-in browser
(`server/login-fill.ts`): every read runs in an isolated world the page cannot see, the page's own address is checked
before each keystroke, and the username, password and any 2FA code go in only as `Input.insertText` to that page's
renderer, so nothing lands in another window. While it types, that desktop's screen calls wait (no screenshot reaches the
model), and a person taking control stops it and clears the password from the page.

With no saved login for the site the bot calls `request_credential` with `credential_id: "login"` and `site`. The card
(a custom secret card with `delivery: "login"`) takes a username, a password and an optional 2FA key; the password and
key leave the app sealed for this server and card, as one JSON value. Save to Vault is on by default and keeps the login
for this bot in the encrypted login store; off (and always for a Team Cloud member), the login is held in memory for that
bot only, until a fill succeeds with it or an hour passes. The bot is then told to call `fill_login`, never the value.
`request_sign_in` stays for what no login fills: a CAPTCHA, a passkey, a phone approval, an OAuth consent.

The desktop's Chromium is started as soon as a turn takes the desktop, waiting out a slow first launch, so `launch_app`,
the browser tools and `fill_login` find it running. A host with no Chrome of its own (an ARM server) offers no host
browser tools; a bot on Auto with its own VPS desktop browses in that desktop's Chromium while it is awake.

## The driver's browser tools are not listed

Cua Driver 0.37.0 in the bot desktop runs in standard mode without `--grant existing-profile`, so `get_browser_state`,
`browser_prepare`, `browser_*` and `page` refuse every Chromium window. The VPS bridge drops them, and the driver's
upkeep tools, from `tools/list` (66 tools to 37 on the v3 image), replaces the driver's MCP instructions with
sandbox guidance, and rewrites a `browser_consent_required` refusal into a next step instead of "authorize it".

Granting `existing-profile` in the image (the profile is the bot's own sandbox Chromium) would bring those typed
browser tools back. That is an image change and a security decision, not made here.

## Check

```sh
pnpm exec vitest run server/vps-exec.test.ts server/sandbox-computer-guidance.test.ts server/vps-routing.test.ts
pnpm exec vitest run server/host/desktop-login.test.ts server/host/fill-login-turn.test.ts server/host/secret-cards.test.ts server/bot-logins.test.ts
MADANI_CDP_E2E=1 pnpm exec vitest run server/box-login-page.e2e.test.ts   # a real Chromium behind a DevTools port, as on the desktop
```

On a live VPS, the same argv `vpsExecArgs` builds can be run by hand against a bot's container
(`docker exec -u cua -w /home/cua/workspace ... sh -c '<wrapper>' madani-exec 60 'ls -l' MARK:`); it prints the output and
`MARK:<exit code>` on stderr.
