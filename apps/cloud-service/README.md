# Managed cloud service

The managed cloud desktop backend. It runs inside the account service (`apps/dashboard/server`), which attaches it
with `MADANI_MANAGED=1` and talks to it only through `apps/dashboard/server/clouds/managed.ts`. Everything that names the
provider lives here: the provider client (`src/instabox.ts`), the lifecycle (`src/lifecycle.ts`), the machine setup
(`src/home.ts`), backups, retention, the stray-machine sweep, the fake provider API for tests, the home package
builder, the e2e harnesses, the home's edge config (`deploy/Caddyfile`), the public edge (`edge/worker.js`, notes in `docs/edge.md`) and
the provider notes (`docs/provider.md`).

The app, the home server and the public docs never name the provider. `scripts/provider-names.test.ts` fails the build if
`src`, `electron`, `shared`, `server`, `apps/mobile` or the README does. The provider is named here, in the privacy
policy and DPA as a sub-processor once there are EU customers (required disclosure), and nowhere a user looks.

## How we protect it

The code is in the repo, like OpenBot's. What protects the business is the same as theirs, plus three layers they do not
have: signed releases, opaque public names and offline-verified entitlements.

### Where each secret lives

| Secret | Where | Who uses it |
|---|---|---|
| `INSTABOX_API_KEY` (runtime key) | account service environment only | `src/instabox.ts`, from the reconciler |
| `MADANI_ENTITLEMENT_SIGNING_KEY` (Ed25519, `kid:<pkcs8>`) | account service environment only | `apps/dashboard/server/entitlements.ts` |
| `MADANI_RELEASE_SIGNING_KEY` (Ed25519) | the release CI environment only | `scripts/sign-release.ts` |
| `MADANI_CLOUD_SEAL_KEY` | account service environment | seals each cloud's bootstrap secret and link key at rest; backups key is derived from it unless `MADANI_MANAGED_BACKUP_KEY` is set |
| `MADANI_MANAGED_BACKUP_KEY` (optional) | account service environment | seals backups; never on a machine |
| `MADANI_MANAGED_EDGE_TOKEN` | account service and the edge Worker (`EDGE_TOKEN`) | the edge's route lookup |
| Payment, email, ops tokens | account service environment | billing, notices |
| A cloud's bootstrap secret and dashboard link key | sealed in the account service's store; on its machine in root-only files | the signed admin requests to that home |

The public halves are pinned in code: entitlement keys in `shared/entitlement.ts` and `electron/entitlement.mjs` (a
parity test keeps them equal), release keys in `src/release-signing.ts`. Generate a new pair with
`node apps/cloud-service/scripts/keygen.mjs <kid> <dir>`: it writes the private key 0600 and prints only the public one.

Provider key scope. The runtime key creates, reads, lists, labels, suspends, resumes, starts, stops and deletes this
deployment's machines, runs commands and moves files on them (setup, package install, start after a cold boot, live
backups, restore), publishes their port 8080 and holds activity leases. InstaBox keys are workspace-wide: keep the
service's machines in a workspace of their own, and every list and delete is limited to the deployment's scope label.

### Who can call what

| Route | Caller | Credential |
|---|---|---|
| `/v1/clouds/*`, `/api/cloud/desktop/*` (account service) | the owner's app or browser | the account session (cookie with CSRF, or app bearer) |
| `/v1/clouds/:id/delete-data[/confirm\|/cancel]` | the owner | fresh sign-in (10 minutes), CSRF, emailed one-time link; rate limited; acts only after 7 days through the retention verdict |
| `POST /v1/managed/claims/redeem` | a machine at first boot | the one-time claim; 30 wrong tries per address per 15 minutes (a good one never counts) |
| `GET /v1/managed/edge/route` | the edge Worker | `MADANI_MANAGED_EDGE_TOKEN`; anyone else gets 404 |
| Home `/api/cloud/*` (health, power, sleep, plan, pairing, entitlement) | the account service | HMAC over method, path, body hash, timestamp and nonce with the cloud's bootstrap secret |
| Home API and pairing | the owner's app | a paired session, and only while the home holds a valid entitlement |
| Provider API | the reconciler only | the provider key above |

### How a machine proves it is ours, and how the app and the home know a cloud is paid for

1. **Create.** The machine is created with no Secrets (`vault: false`) and a boot file holding only its cloud id and a 256-bit one-time
   claim (an HMAC of the cloud id and attempt under the service's backup secret, so a retried create that gets the
   first machine back carries the same claim; the service keeps only its hash, valid 1 hour). The provider's API, its
   logs and its dashboard never see a secret.
2. **First boot.** The setup script redeems the claim at `/v1/managed/claims/redeem` (retrying for up to 55 minutes,
   honouring `Retry-After`) and gets the bootstrap secret, the dashboard link key and its env. It is answered once,
   again within 5 minutes for a lost answer (audited and alerted), then never; a recovery's new machine gets a new
   claim. The setup moves them into root-only files and shreds the boot file.
3. **Install.** Root's `omb-home install` checks the package's sha256 and its release signature against the pinned
   release keys before unpacking.
4. **Entitlement.** Before a cloud counts as running, and hourly after (and on every wake), the account service signs an
   Ed25519 entitlement (24 hours, key id, cloud id, plan, features, an opaque account reference, no email) and pushes it
   through the signed `POST /api/cloud/entitlement`. Every home this service makes has `MADANI_CLOUD_ENTITLEMENT=required`
   in its boot env, and then serves nothing but its liveness probe and the signed admin routes without a valid token
   for its own machine id, pairing included. A home another Admin runs from the same release (without that env) is
   unaffected until that Admin pushes entitlements too. Clock skew of 5 minutes
   either way is tolerated; tokens longer than 7 days are refused whoever signed them.
5. **App.** The session's cloud list carries the same token; the app verifies it offline (`electron/entitlement.mjs`)
   and offers the Cloud desktop only for a cloud whose token verifies for that cloud id. A packaged app trusts only the
   pinned keys; a development build also trusts `MADANI_ENTITLEMENT_DEV_KEYS`.
6. **Rotation.** Pin the next public key in a release first (kid `ent-YYYY-MM`), ship it, then switch the service's
   signing key. Tokens from the old key keep verifying until it is removed from the pinned list in a later release.

### What people see

User-facing origins are `https://<label>.<MADANI_MANAGED_PUBLIC_DOMAIN>`. The label is an HMAC of the cloud id (20 hex
characters): it names no person, no cloud id and no provider. The edge Worker (`edge/worker.js`) maps it to the
machine's own hosted URL through `/v1/managed/edge/route`, caches the answer 60 seconds, forwards WebSockets, strips
`server`/`via`/`x-powered-by` and rewrites redirects. The home answers for both names (`MADANI_CLOUD_UPSTREAM_HOST`) and
keeps the public one as its `MADANI_PUBLIC_URL`. The account service itself talks to the machine's own URL.

DNS and proxy, once:

1. A zone you control, say `desktops.example.com`, on Cloudflare.
2. Deploy `edge/worker.js` with `wrangler deploy` and bindings `ROUTE_URL` (the account service origin), `PUBLIC_DOMAIN`
   (`desktops.example.com`) and the secret `EDGE_TOKEN` (`wrangler secret put EDGE_TOKEN`, same value as the service's
   `MADANI_MANAGED_EDGE_TOKEN`, 32 characters or more).
3. A proxied wildcard record `*.desktops.example.com` (any target; the Worker answers) and the Worker route
   `*.desktops.example.com/*`. Cloudflare's universal certificate covers one wildcard level.
4. Set `MADANI_MANAGED_PUBLIC_DOMAIN=desktops.example.com` on the account service. It refuses to start without it (and
   without the edge token) unless it runs on loopback.

Machines are named `madani-<cloud id>-<attempt>-<scope>` at the provider (no email), labelled with the cloud id and this deployment's scope.

### What cannot be prevented

- Anyone with the source can remove the entitlement check from their own build of the app or the home, or start our
  home package without `MADANI_CLOUD_ENTITLEMENT=required`, and run it against a service of their own. Signed tokens stop
  forged tokens, not a modified copy or a different boot env. A release build never trusts development keys.
- Anyone can buy the same provider, run their own account service and their own Stripe. The recipe is public here, as
  OpenBot's is. What they do not have is our keys, our accounts, our domain, our users' data and the service itself.
- Network inspection (DNS, the certificate behind the provider's URL, the ASN, timing) can reveal the provider to a
  determined user even behind the edge. Hiding is about not advertising it.
- The license (PolyForm Noncommercial) is enforced by law, not code: keep the copyright holder, a CLA, a trademark
  file and terms of service current. Obfuscation is not worth it.

### Deploys

- **Account service.** Built from `main`; secrets come from the deploy environment, never from the repo. Deploy it
  before any home that requires entitlements: a home from this release refuses clients until the service pushes one.
- **Home package.** CI builds it (`node apps/cloud-service/scripts/build-home-package.mjs`), signs it
  (`MADANI_RELEASE_SIGNING_KEY=… node apps/cloud-service/scripts/sign-release.ts release/home/omb-home.tgz --kind home-package --name omb-home --version <v>`),
  publishes the package and its `.sig`, and the service gets `MADANI_MANAGED_HOME_PACKAGE_URL`, `_SHA256` and
  `_SIGNATURE` (or `_SIGNATURE_FILE`). The service checks the signature at start and refuses an unsigned package off
  loopback.
- **Test and production** use different provider keys and, preferably, different provider accounts, and every list and
  delete is limited to the deployment's scope label.

### Compared with OpenBot (ideas only, no code copied)

Same: the machine gets only a short-lived claim, never a secret; hosted mode is claimed, not configured; a dead-man lease;
a wake ahead of each routine; backoff on provider limits. Different: our releases are signed and checked by the machine
(theirs are pinned by checksum only); the user-facing name is ours (they need none because clients reach machines
through their relay); the app and the home verify entitlements offline with pinned keys and an explicit clock
tolerance; machine labels carry no email; backups live off the provider with 30-day retention; a pause keeps the home's
memory, so a wake takes seconds.

## Lifecycle hardening

### Provider limits and conflicts

- A 429 is never a failure: the cloud keeps its state, the step is retried 30 s, 1, 2, 4 then 5 minutes later (or as
  long as `Retry-After` asks, up to 15 minutes), attempts are not counted, and the audit says `provider_limit` once
  per streak; 12 in a row alert the operator. Setup keeps its 45-minute ceiling.
- A 409 or a "busy" answer to a resume or a pause means the machine is already on its way: in progress, not an error,
  never a reason to rebuild.

### Bot computers on a fresh home

The bot computer image is made ready on the machine itself, with no registry credential and nobody's step:
`omb-home install` starts `omb-desktop-image.service` (`omb-home desktop-image`, root, low priority, retried a minute
after a failure), which uses a public registry copy when there is one and otherwise builds from the signed package's
`deploy/bot-desktop` kit. It writes `building`, `ready` or `failed` to `DESKTOP_IMAGE_STATUS`; the home's server, told the
path by `MADANI_BOT_DESKTOP_HOST_BUILD`, waits for it the first time a bot's computer starts. Making the registry package
public would skip the build.

### Idle sleep and waking for routines

The home itself reports, through the signed `GET /api/cloud/power` read once a minute while it is up, whether it is
busy (a turn, a run, a call, a computer, maintenance, recent use, work finished under 2 minutes ago, a run due within
5 minutes) and when its next routine or retry is due; the sleep handshake returns the same. Background polls from open
windows are marked and never count as use, so an idle open app does not keep a machine running. The service sleeps a
home only on the home's word and wakes it 2 minutes before its next run (`MADANI_MANAGED_WAKE_LEAD_MINUTES`); the home
refuses to sleep within 5 minutes of one.

### Memory guard

On every machine: the home's unit (launcher, edge, server and its engines) runs under `MemoryHigh=80%`,
`MemoryMax=90%`, `OOMScoreAdjust=-500` and `OOMPolicy=continue`; bot computers' containers run under `omb-bots.slice`
(`MemoryMax=75%`, docker's `cgroup-parent`); compressed swap of half the memory (`omb-zram`, best effort). Not done yet:
a separate OOM score for engine processes inside the home and holding new turns when free memory is low; both need
changes in the server's process spawning.

## Updates

A running home takes a new release only when it can't break it (`src/home-update.ts`, `shared/update-guard.ts`): the
release (`MADANI_MANAGED_HOME_RELEASE_FILE`, `{ sha256, signature, url | file, clouds? }`, read again when it changes, else the
package the service started with) must be signed, newer than what the home runs, at or above the floor and not blocked
in the signed update policy (`MADANI_UPDATE_POLICY_FILE`, signed with `scripts/sign-update-policy.ts`, read again when it
changes, served unchanged at `GET /v1/updates/policy`), and the policy is not `paused`. With `clouds` (cloud ids, a canary) only
those clouds are offered it. `scripts/release-all.ts` writes both files ([docs](../../docs/releases-auto-update.md)). It goes in only while no turn, routine run, upload or backup
runs. The home then self-tests (`server/update-state.ts`: health, a page in the bot's browser, one read per connected
Google app; only a check that passed on the version before can fail it). A failed self-test, or the next two runs
failing in a row, rolls it back (`omb-home rollback`), never below the floor; a blocked running version rolls back
the same way. That version is never offered to the home again. The machine refuses an older package or one below the
floor on its own as well. The owner sees one line in the app ("Updated to 1.4.2" / "Update rolled back, nothing lost").
Audit actions: `update_applied`, `update_settled`, `update_rolled_back`, `update_refused`, `update_install_failed`,
`update_stuck` (alerted: a rollback is due and nothing allowed is left to go back to).

## Settings

`MADANI_MANAGED=1`, `INSTABOX_API_KEY`, `MADANI_CLOUD_SEAL_KEY`, `MADANI_ENTITLEMENT_SIGNING_KEY`, `MADANI_MANAGED_PUBLIC_DOMAIN`,
`MADANI_MANAGED_EDGE_TOKEN`, and a package (`MADANI_MANAGED_HOME_PACKAGE_URL` or `_FILE`, `_SHA256`, `_SIGNATURE`). Provider:
`INSTABOX_BASE_URL`, `MADANI_MANAGED_PROVIDER_PLAN` (`pro`, `builder`, `team`), `MADANI_MANAGED_PROVIDER_TEMPLATE` (default
`universal`), `MADANI_MANAGED_IDLE_PAUSE_MINUTES` (5 to 30, default 30). Optional: `MADANI_MANAGED_KINDS`, `_SCOPE`,
`_IDLE_MINUTES`, `_LEASE_HOURS`, `_WAKE_LEAD_MINUTES` (default 2), `_EDGE_WAKES_PER_HOUR`, `_BACKUP_DIR`, `_BACKUP_KEY`,
`_BACKUP_KEY_PREVIOUS`, `_BACKUP_HOURS`, `_BACKUP_KEEP`, `_BACKUP_TAIL_DAYS`, `_BACKUP_MAX_MB`, `_RETENTION_DAYS`,
`_DELETE_DELAY_DAYS`, `_LOST_AFTER_MINUTES`, `_HOME_RELEASE_FILE`, `MADANI_RELEASE_PUBLIC_KEYS` (staging keys),
`MADANI_UPDATE_POLICY_FILE`. Details in `docs/provider.md`.

## Tests

`pnpm exec vitest run apps/cloud-service` (a fake InstaBox API, no network). `node --experimental-strip-types
apps/cloud-service/scripts/e2e.ts --fake` runs the whole life against the fake, edge and signed updates included. The
real run on InstaBox, as a person uses a home (provision, bots, computers, desktop stream, websites, pause and resume, a
routine across a pause, crashes, a move in from a local fixture and back), deleting everything it made, is
`scripts/instabox-live.ts`.
