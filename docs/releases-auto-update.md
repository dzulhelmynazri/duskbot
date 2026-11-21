# Publish once, everything updates

After **Release** published `v<version>` (see [releasing](releasing.md)), one command on the Mac, from a clean checkout
of the tag, ships it to every kind of install and watches it:

```sh
node scripts/release-all.ts 0.2.26 --dry-run                     # every step it would take; changes nothing
node scripts/release-all.ts 0.2.26 --canary <cloud id,...>        # staged: canary first, widens on its own
node scripts/release-all.ts 0.2.26 --now                          # everything at once, no watch
node scripts/release-all.ts status [--canary <ids>]               # which version every kind of install runs
node scripts/release-all.ts pause | resume | block <x.y.z>        # the kill switch
```

Each step is recorded in `release/auto/<version>.json`; a rerun skips what is done and keeps a watch's clock, so a
stopped run (exit 3: still waiting, exit 1: halted) is resumed by running it again.

## The steps

1. **Preflight**: HEAD is the tag and clean, the release key is there.
2. **Desktop rollout**: the signed update policy gets `rollout: { "<version>": 10 }` (the first of `--desktop-steps`,
   default `10,50,100`), so only 10% of desktops take it.
3. **Desktop**: `scripts/publish-downloads.sh` (installers, signed `latest.json`, the madani.bot mirror) unless madani.bot
   already announces it.
4. **Cloud package**: builds the home package, signs it (`home-package`), copies it to the account host and writes the
   release file (`MADANI_MANAGED_HOME_RELEASE_FILE`) with `clouds: [ids]`: only those clouds take it.
5. **Canary watch** (`--watch`, default 30 minutes; gives up waiting after 4x): reads `GET /v1/ops/fleet`. It halts
   when a canary cloud rolled the version back or is stuck, or when desktops on it (20 installs or more) send errors at
   3x the rate of the version before. It is healthy once the watch is over and a canary cloud passed its self-test.
6. **Widen**: the release file without `clouds` (every cloud), then each further desktop share with its own watch, and
   100% drops the rollout from the policy.
7. **Own servers**: builds and signs the VPS package and copies it into the link service's `packages/` (tgz first,
   `current.json` last, each by rename). This comes after the canary, so a bad build never reaches servers.
8. **Link agent**: when the tag's `AGENT_VERSION` is newer than what `link.madani.bot/v1/release` serves, it waits for
   `link-agent-sign.yml` to re-sign `agent.mjs` on main, then runs `apps/link-service/deploy/deploy.sh` from main.

A **halt** signs a policy that blocks the version everywhere: clouds roll it back, servers and desktops refuse it.

## How each install reacts

| Install | Checks | Installs | Safety |
| --- | --- | --- | --- |
| Desktop (Mac, Windows, AppImage) | 20 s after launch, every 30 min (+0 to 10 jitter), 30 s after wake | downloads in the background; installs on quit, at a quiet moment (locked or 10 min idle, no turn/call/dictation), or on "restart to update" | signed manifest and sums; the policy holds a paused, blocked, below-floor or out-of-rollout version back, before the download and before a quiet restart |
| Linux .deb | the same schedule | shows a link to its installer | the same manifest checks |
| Own server (VPS) | the agent asks the link service 2 min after start, then every 10 to 15 min; root's timer installs every 15 min | only while no bot works | signature, policy, self-test and rollback (`install.sh`); a paused policy makes the link service offer no build |
| madani cloud | the account service's reconciler, every 15 s while the home is up | only while idle | signature, policy (now with `paused`), self-test and rollback (`home-update.ts`); `clouds` limits who is offered it |

## The policy

One signed document (`apps/cloud-service/scripts/sign-update-policy.ts`, kind `update-policy`):
`{ serial, floor, blocked, paused?, rollout? }`. The tool puts each new one in three places: the account service's
`MADANI_UPDATE_POLICY_FILE` (served at `/v1/updates/policy`, re-read on change), the link service's
`packages/update-policy.json`, and `madani.bot/releases/update-policy.json`. Desktops read the first two URLs in that
order. The serial only grows; nothing takes an older one. A desktop's rollout bucket (0 to 99) is drawn once and kept
in `update-bucket.json` beside its update folder.

Limits: a desktop build from before this reads no policy (no pause or rollout for it); a desktop that already
downloaded an update still installs it when it quits; a server agent from before this keeps its hourly poll until it
takes agent 2.4.7.

## Visibility

`GET /v1/ops/fleet` (account service, `Authorization: Bearer $MADANI_OPS_TOKEN`, 404 otherwise), counts only:
desktops by the version of each opted-in install's newest `app_open` in `days` (default 14) with their `app_error`
counts, managed clouds by version (with how many are on trial) plus the `canary` ids' trial state, and own servers
and agents by the version they reported when they last asked for an update (the link service's `/ops/fleet`, with
`MADANI_LINK_STATS_TOKEN`; in memory, last 24 h).

## Restarting the account service

Production's account service runs under autorunner, which restarts it as SIGTERM, SIGKILL 5 s later, then a new start.
So the service (`apps/dashboard/server/main.ts`, `serve.ts`, `persistence/lease.ts`):

- on SIGTERM stops listening, writes what is pending (3 s at most) and gives the writer lease back, all inside 4.5 s;
- on start takes the port as soon as it is free (it never exits for a taken port) and holds the requests that come
  while it waits for the lease and loads (503 `starting` after 30 s), instead of refusing them;
- waits for a lease a live service still holds for as long as it takes, with a short backoff (it used to exit after
  75 s, and each exit counted as a crash), and takes one whose holder on this host is gone at once.

Release files need no restart: `release.json` and `update-policy.json` are read again when they change.
