# Real-setup smoke and the owner checkout gate

The owner's dev app runs from `~/Desktop/code/OpenMausBot`. Agents never move
that checkout themselves. The coordinator moves it in batches through one gate:

```sh
scripts/sync-owner-checkout.sh           # smoke origin/main, then fast-forward the checkout if it passed
scripts/sync-owner-checkout.sh --check   # the same smoke and version check, checkout left alone
```

The gate fetches `origin/main` into its own worktree (`~/.cache/madani-smoke/gate-worktree`)
and runs the smoke there. Only a passing run fast-forwards the checkout
(`git merge --ff-only`). It never stashes, resets or merges. It changes
nothing and says why when:

- the checkout is not on `main`
- the checkout has commits that `origin/main` lacks
- the checkout has local edits in files the update touches

After a move it runs `pnpm install` if the lockfile changed, and tells you to
restart the dev app if `electron/` changed. It also prints the app version next
to the owner's server package (`oracle`) and the preview cloud package
(`omb-home.tgz` on `contabo`), and says which one needs a roll.

## The smoke

```sh
node scripts/smoke/real-setup.mjs [--root DIR] [--out DIR] [--fresh-sign-in] [--only id,id]
```

This is the checkout's own desktop app, isolated: its own Vite port and
`cacheDir`, its own harness port, `HOME`, user data and data folder (all in
`~/.cache/madani-smoke/profile`), and a mock keychain. It never uses the owner's
ports (5199, 8799, 5299, 8899, 9335).

It is never visible. `scripts/smoke/electron-smoke-shim.cjs` makes every window
and view render offscreen with `show: false`, and turns show and focus into
no-ops. It also stubs the dock, tray, notifications, global shortcuts, login
item, native dialogs and system-browser links. Before each launch, a dry run
(`never-visible-check.mjs`) shows that a window told to show stays invisible
and still paints. A watchdog fails the run if any window ever reports itself
visible. Teardown kills the app's whole process group on exit, errors and
signals.

Electron also puts some folders by app name, not by `HOME` or user data. On macOS its logs go to
`~/Library/Logs/madanibot`, which is the owner's log folder. The shim moves logs, crash dumps, temp,
downloads and the other app paths into `profile/app-paths`. The last step checks the owner's setup:
`~/.config/madanibot`, the owner's places and home files and `~/.madanibot/config.json` must be
byte-identical after the run. No owner app file and no new owner log line may name the smoke's server,
port or profile.

The smoke uses the real backends:

| step | what passes |
| --- | --- |
| app starts | main window renders, the welcome or a chat, nothing visible |
| sign in | `qa-smoke@madani.bot` on preview through the app's own account client. The code comes from Brevo's sent log, and the session is reused for 20 hours. The dev app has no sign-in screen (packaged only). |
| My Cloud | the account's cloud answers `/api/health`. The step is skipped while the account has no cloud. |
| settings | every page opens with no raw errors and no hard layout issues (chat-gallery audit) |
| settings fit | the dialog stays inside the window and centred at 1000 and 760 wide |
| add server | the add-a-server sheet renders |
| owner's server | an ssh tunnel to the owner's server (`oracle`, local port 7462) opens. The app is paired as its own device ("madani smoke", first run only) and opens its bots. |
| chat | the test bot (`MADANI_SMOKE_BOT`, default Nova) replies to one short message, or asks for an AI account |
| computer | the bot's screen opens, then take control and hand back |
| routines | the bot's routine list or its empty state loads |
| connect apps | the window opens, and Gmail's connect reaches a Composio or Google page (the link is recorded, not opened) |
| relay | the owner's link has a direct path that answers, or uses Cloudflare. The link service and the Cloudflare relay answer. |

Each step writes a screenshot. `report.md` and `report.json` go to `--out`
(the gate uses `~/.cache/madani-smoke/runs/<time>-<sha>`).

The smoke changes the owner's server in three ways: one paired session, one
message per run to the test bot, and one take-control-and-hand-back on that
bot's screen. It deletes nothing. It needs `ssh oracle` with passwordless sudo
to the server user, `ssh contabo` for the cloud package version, and
`MADANI_BREVO_API_KEY` in `~/.config/madanibot/madani.env`.
