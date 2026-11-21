@AGENTS.md

## Getting someone started

When someone clones or forks this repo and asks to set it up, initialize it, or just start working:

1. `pnpm install`
2. Run the app: `pnpm dev:app` starts the UI (127.0.0.1:5199) and the desktop window, which runs the harness (127.0.0.1:8799) as its own child, so This Mac works. The harness restarts when a file in `server/` or `shared/` changes (`MADANI_DEV_SERVER_WATCH=0` turns that off) and when it dies; stop a separate `pnpm dev:server` first, the app refuses a taken port. Browser only: `pnpm dev:server` plus `pnpm dev` (no This Mac there).
3. Test bots: the first harness start on a brand-new workspace adds eight invented test bots (Nova, Quill, Rivet, Tally, Echo, Juno, Basil, Moss) in a "Test bots" sidebar section, with chats, memory, skills, a room, routines (all off) and webhooks, so nobody starts from zero bots. It happens once per workspace and never again, even after they are removed. If they are missing, run `pnpm test-bots` while the server is up; `pnpm test-bots --remove` deletes only what it created. `MADANI_NO_TEST_BOTS=1` skips the automatic seeding.
4. Messages to the test bots get real replies through the person's own engine sign-in (Claude Code etc.), so they use that account's usage.

`pnpm demo` starts a fully separate copy with the same test bots and richer history (harness 8899, UI 5299, data in ~/.madanibot-demo); `pnpm demo stop` stops it.
