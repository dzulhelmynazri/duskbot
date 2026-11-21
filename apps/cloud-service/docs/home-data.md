# A cloud home's data: what lives where

A managed home is three layers. Only the first one is the person's; the other two are rebuilt, never copied. This is the
manifest any other host (another provider, our own isolated machines) has to honour to take a home over. Paths use the
names in `electron/legacy-names.mjs` (`CLOUD_HOME`), which keep the pre-rename spelling on disk.

| Layer | Path | What | How it moves |
| --- | --- | --- | --- |
| The person's data | `/data` (the home volume) | everything below | the encrypted backup (`backups.ts`), read from the running home |
| Code | `CLOUD_HOME.root` (`node`, the app, `bin/omb-home`), Caddy, the systemd units | the signed home package | installed again from the same signed release (`scripts/build-home-package.mjs`) |
| Machine identity | `CLOUD_HOME.etc` (`boot.json`, `home.env`, `machine`) | the admin secret, the dashboard link keys, the cloud id | issued again by the one-time claim at first boot (`home.ts`, `REDEEM_SCRIPT`); never copied between machines |
| Run state | `CLOUD_HOME.run` (`desktop-image`) | the bot computer image's build status for the current boot | none |
| Bot computers | Docker's images and volumes on the root disk | the image (built on the machine), each desktop's own home and browser | none: a new machine starts them fresh |

## Inside `/data`

The home runs with `HOME=/data` and `MADANI_DATA_DIR=CLOUD_HOME.data`, so tools that write under the home directory land
on the volume too.

| What | Where (under `CLOUD_HOME.data` unless noted) |
| --- | --- |
| Volume marker (which cloud this volume belongs to; a backup is refused without it) | `.omb-cloud-home.json` at the volume root |
| Bots, groups, people | `bots.json`, `bots/`, `groups.json`, `people/` |
| Conversations and runs | `messages.db`, `runtime.db`, `events/`, `attachments/` |
| Workspaces and files | `workspaces/`, `task-workspaces/`, `sync/` |
| Routines and webhooks | `routines.json`, `webhooks.json` |
| Configuration | `config.json`, `engine.json`, `environment-id`, `providers/` |
| Credentials and sessions | `sessions.json`, `mcp-oauth.json`, `cloud-entitlement`, the engines' own sign-ins under `/data` (`.claude`, `.codex`, `.config`, `.hermes`, `engine-homes/`) |
| Browser profiles | `agent-browser-profiles/` (signed-in sites), `browser-engine-key` |
| The dashboard link | `dashboard-link.json` |
| Disposable | `tmp/`, `cache/`, `.cache/`, `.backups/` (the home's own snapshots) |

## Rules for a new host

- Restore `/data` as one volume; keep its marker. Nothing outside `/data` is the person's.
- Install code from a signed release, never from another machine's disk.
- Issue a fresh machine identity through the claim; the old machine's secrets stay with it.
- The power lifecycle needs from a host only what `src/provider.ts` (`MachineProvider`) and a cost profile
  (`src/power/cost.ts`, `ProviderCostProfile`) describe: create, resume, stop, read, run a command, a dead-man lease,
  snapshots of `/data`, and its prices and start limits.
