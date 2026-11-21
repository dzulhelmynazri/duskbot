# My Cloud on InstaBox

The account service (`apps/dashboard/server`) runs each paid My Cloud on its own [InstaBox](https://instabox.sh) machine.
The machine runs the same My Cloud home as every Cloud plan (`server/cloud-home-start.ts`, `apps/cloud-service/deploy/Caddyfile`),
installed natively under systemd. Everything else a person sees is the existing My Cloud: pairing, wake, the one-time
move and move back. Your own VPS ("Add your VPS", `apps/link-service/install.sh`) is unchanged.

## InstaBox facts the service relies on

Read from the official docs and OpenAPI (`https://instabox.sh/llms-full.txt`, `https://api.instabox.sh/v1/openapi.json`)
and checked on live machines, 2026-11-11.

- Firecracker microVMs on Debian 13, Docker and buildx in the `universal` template; machines run in AWS us-west-2.
- `/data` is the persistent disk and also holds the machine user's home (`/data/home`), `TMPDIR` (`/data/tmp`), the
  platform's own folders and swap. The root disk (Docker's images and volumes) persists across a stop and a reboot.
- `suspend` keeps memory and processes; `resume` continues where it left off (about 2 to 6 s), or boots fresh when it
  cannot (`runtime.processesPreserved: false`). `stop` keeps files only. A paused machine cannot be stopped or resized
  without a resume first. Stopped disks are never purged.
- Create, start, stop, suspend, resume, delete and snapshot saves take an `Idempotency-Key`; a create whose operation
  failed replays the failure for the same key, so the machine's unique name (`madani-<cloud>-<attempt>-<scope>`) is what
  keeps a retried create from making a second one. `DELETE` needs `X-Confirm-Delete`.
- `exec` runs `bash -lc` as the machine user (passwordless sudo), 10 minutes at most; a minutes-long call is dropped by
  the API, so long work runs detached and is polled. Exec is never retried.
- A public port answers 503 while its machine is paused by us and does not wake it. The port proxy reaches the machine
  from its own loopback with `Host: 127.0.0.1:<port>` and the public name in `X-Forwarded-Host` (the edge, `@proxied`,
  takes that name as the Host only from a loopback peer and only when it is one of the machine's own names).
- An activity lease (30 s to 1 h) keeps the machine's own idle pause off; the idle pause (5 to 30 minutes) is our
  dead-man switch if this service stops.
- Limits: 30 starts (create, start, resume) a minute per Pro workspace (50 Builder, 100 Team). Prices: vCPU 0.4 c/h,
  memory 0.225 c/GiB-h, billed per second while running (2 vCPU / 4 GiB is 1.7 c/h); disk beyond the plan's 200 GiB
  0.008 c/GiB-h; a paused machine pays only disk.
- Egress is datacenter addresses: Google Search, Amazon, eBay and Reuters block or challenge a bot's browser; Bing,
  BBC, the Guardian, GitHub, Airbnb, OpenStreetMap, YouTube, Vimeo and Wikipedia load.

## The live screen

The home's server answers the app's WebRTC offer for a bot computer's screen (`server/screen-direct.ts`) with
node-datachannel, staged in the package's `node_modules` by `scripts/prepare-duckdb.mjs`. Its UDP sockets are pinned
to `HOME_SCREEN_DIRECT_PORTS` (30000-30063, `src/home.ts`, the server image's range).

InstaBox publishes no UDP: `POST /v1/machines/{id}/ports` takes `protocol` `http` (an HTTPS proxy) or `tcp` (raw TCP
behind TLS with SNI, admin-only preview), and the API has no firewall rule or public address for a machine (OpenAPI read
2026-11-13). Its egress is shared datacenter addresses, so the machine sits behind the platform's NAT. Nothing can be
opened from outside, and a screen goes:

- **peer to peer** when hole punching works: the server learns its NAT address from STUN and both sides send first;
- **through Cloudflare TURN** when the app's relay candidate wins (the server only sends out to it);
- **over the link relay** otherwise, as before.

`GET /api/desktop-viewer/transport` on the home counts which. A provider-side change is needed for inbound UDP: a UDP
publish (or a public address with a firewall rule) for 30000-30063 on each machine, or one UDP port if the server
moves to ICE UDP mux. Many short UDP flows may also be what InstaBox's `abuse_network_flows` check watches; ask them
before turning screens on for every home.

## Lifecycle

The code is `apps/cloud-service/src/lifecycle.ts`, the adapter `src/instabox.ts`, what runs on the machine `src/home.ts`.

- **Provision** when the plan is paid: one machine per cloud, 2 vCPU / 4 GiB or larger, labelled `omb.cloud` and
  `omb.scope`, with no InstaBox credentials or Secrets on it (`vault: false`). The boot file (a one-time claim) and the
  setup script are uploaded and the setup runs detached; then the signed package is installed and the home started on
  the machine's public port 8080.
- **Bot computers.** The bot computer image is not pulled from a registry: `omb-home install` (and every `omb-home start`
  while it is not ready) starts `omb-desktop-image.service`, which runs `omb-home desktop-image` as root, beside the
  docker gate that never builds. It uses the registry's copy when one is public, else builds the image from the signed
  package's own kit (`deploy/bot-desktop/build.sh`), at low priority, retried a minute after a failure. Its state
  (`building`, `ready`, `failed`) is in `DESKTOP_IMAGE_STATUS` under `CLOUD_HOME.run`. The home's server learns that path
  from `MADANI_BOT_DESKTOP_HOST_BUILD` and, when a bot's computer is first started, waits for the build (telling the chat
  it is building) instead of building through the gate; a failed build answers at once with a clear message. The image
  survives pauses, stops and reboots on the root disk.
- **Sleep.** The dashboard reads the home's power once a minute and asks the power policy (`src/power/policy.ts`)
  whether a stop is worth it. The rails (`src/power/rails.ts`, at InstaBox's scale `INSTABOX_RAILS`) hold every stop and
  start to hard limits. A stop goes through the sleep handshake (`server/cloud-power.ts`), then a `sync` and a suspend:
  the home's processes are frozen, not stopped, so a resume continues the turn queue, the bot computers and their
  browsers where they were. The policy, its rails and the cost study are in `docs/power.md`.
- **Wake** on intent only: the app (`/api/cloud/desktop/wake`) for a send, a click or typing, never for opening or
  viewing; the dashboard's power button; the Slack edge and webhooks through our domain; a routine, 2 minutes before its
  run (`MADANI_MANAGED_WAKE_LEAD_MINUTES`). The reconciler runs `omb-home start` after every resume; it is a no-op when the
  home kept running with its origin, and starts it after a cold boot. The home notices a resume by the clock jump and its
  due timers re-check the wall clock every minute, so a routine due during a pause runs within a minute.
- **Back up** `/data` (what lives there: `docs/home-data.md`) from the running home: `omb-home snapshot` copies each
  SQLite database through an online backup and the rest as it is, the service downloads it, seals it and keeps it in
  `MADANI_MANAGED_BACKUP_DIR`. Taken before an idle sleep when one is due, before the sleep that ends a plan, and after two
  backup intervals awake. The home never holds a credential for that storage.
- **Recover** a lost machine (repeated 404s and absent from the list): a fresh machine, then the newest verified backup
  restored into it in place (only our entries of `/data` are swapped; the platform's stay). A cold-booted machine is not
  lost: its home is started again.
- **Retain.** When a plan ends, the final backup is taken from the running home and it sleeps; a home that paused itself
  with no final backup as new as its data is woken once to take one. The cloud is kept for 30 days and the owner is
  notified at the end and 7 days before deletion. It is deleted only through `deletionVerdict`
  (`src/retention.ts`), which reads the billing store, never a request. A deleted account's clouds are not kept: the
  account's deletion confirms each one's delete at once (`accountDeleted` in lifecycle.ts, past any paid period; only a
  hold stops it), and the billing service sweeps every 10 minutes for any a failed step or restart left behind.
- **Machines a recovery replaced** are kept asleep (their disk costs nothing up to the plan's storage), paused if found
  running, and deleted only with their cloud.

Every action is one line in `managed-audit.jsonl`. A deletion is a plain log line too; it never emails (lifecycle is in admin and the daily digest).

## Configuration (account service)

- **Required:** `MADANI_MANAGED=1`; `INSTABOX_API_KEY` (only this service holds it); `MADANI_CLOUD_SEAL_KEY`;
  `MADANI_MANAGED_HOME_PACKAGE_SHA256` with `MADANI_MANAGED_HOME_PACKAGE_FILE` or an https `MADANI_MANAGED_HOME_PACKAGE_URL`
  (build it with `node apps/cloud-service/scripts/build-home-package.mjs`). Off loopback also
  `MADANI_MANAGED_HOME_PACKAGE_SIGNATURE` (or `_SIGNATURE_FILE`), `MADANI_MANAGED_PUBLIC_DOMAIN` and `MADANI_MANAGED_EDGE_TOKEN`.
- **Provider:** `INSTABOX_BASE_URL` (tests and staging), `MADANI_MANAGED_PROVIDER_PLAN` (`pro`, `builder` or `team`: its
  starts a minute; default `pro`), `MADANI_MANAGED_PROVIDER_TEMPLATE` (default `universal`), `MADANI_MANAGED_IDLE_PAUSE_MINUTES`
  (5 to 30, default 30: the machine's own dead-man pause).
- **Optional:** `MADANI_MANAGED_BACKUP_KEY` (43 base64url characters; otherwise derived from `MADANI_CLOUD_SEAL_KEY`). Its
  fingerprint is kept in the data folder, and a different key refuses to start unless the old one is set as
  `MADANI_MANAGED_BACKUP_KEY_PREVIOUS`, which seals every backup again first. Also `MADANI_MANAGED_KINDS`, `_SCOPE`,
  `_IDLE_MINUTES`, `_LEASE_HOURS`, `_WAKE_LEAD_MINUTES` (1 to 30, default 2), `_EDGE_WAKES_PER_HOUR`, `_BACKUP_DIR`,
  `_BACKUP_HOURS`, `_BACKUP_KEEP`, `_BACKUP_TAIL_DAYS`, `_BACKUP_MAX_MB`, `_RETENTION_DAYS`, `_DELETE_DELAY_DAYS`,
  `_LOST_AFTER_MINUTES`, `_HOME_RELEASE_FILE`, `MADANI_UPDATE_POLICY_FILE`, `MADANI_RELEASE_PUBLIC_KEYS` (staging keys).
- **Minimums:** `MADANI_MANAGED_RETENTION_DAYS` is at least 30 and `MADANI_MANAGED_DELETE_DELAY_DAYS` at least 7; shorter
  values stop the service at startup.
- **Sizing:** the 30 starts a minute per Pro workspace bind first. Up to about 300 homes per workspace the policy beats
  every fixed idle timer; from about 600 it loses, and at 1,000 or more synchronized routines run late. Use a bigger plan
  or a second workspace before that.

## Deleting a cloud's data on request

Only the owner can delete a cloud's data early.

1. They call `POST /v1/clouds/:id/delete-data`. This needs the cookie session with its CSRF header, a sign-in from the
   last 10 minutes, and no active plan.
2. That emails a one-time link. Confirming it (`POST .../delete-data/confirm {token}`) schedules deletion 7 days out.
3. Until then, `POST .../delete-data/cancel` undoes it.

No route deletes anything directly. The reconciler acts after the delay, through the same verdict as every other
deletion.

## What moves with a home

The unit is the `/data` volume. `src/bundle.ts` (`scripts/home-bundle.ts`) describes one as a versioned manifest of every
file's path, size, sha256 and layer, and seals a bundle under a passphrase for a move outside the service. A machine
identity is issued again by the claim; bot computers' Docker volumes live on the root disk and start fresh elsewhere.
This Mac or a VPS to My Cloud, and back, is the app's own move (`electron/one-home.mjs`, `one-home-again.mjs`), which
talks only to the home's HTTP API.

## End-to-end checks

`node --experimental-strip-types apps/cloud-service/scripts/e2e.ts --fake` runs the whole life against a loopback fake of
the InstaBox API. `apps/cloud-service/scripts/instabox-live.ts` runs it on real InstaBox under a scope label of its own
and deletes every machine it made at the end.
