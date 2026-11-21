# Releasing

For a normal release, run **Actions → Prepare next release → Run workflow** and
choose a patch, minor, or custom version. It opens a tiny version-bump PR;
merging that PR automatically starts **Release** and assembles a draft from the
exact merge commit. Review and publish the draft when it is ready.

The existing **Actions → Release → Run workflow** button remains available for
reruns and recovery. It
builds macOS (arm64 + x64, signed, notarized, stapled), Windows, and Ubuntu
from a single pinned commit, verifies every artifact the way a user would
receive it, and assembles the canonical draft in
[madani bot releases](https://github.com/dzulhelmynazri/madani-bot/releases).
Tick **publish** to publish the release immediately, or leave it unticked to
review the draft first.

The release commit must have passed CI on every platform: the **CI passed on
the release commit** job waits (while the platforms build) for a ci.yml run
whose `CI` check passed with every Linux, Windows and macOS shard, on the
pinned commit or a commit with the same tree, and stops the release before any
draft if the commit's CI failed. A push to main runs the Linux shards only, so
unless the release branch's own CI (started by **Prepare next release**) or a
nightly run covered the same tree, the job runs the full CI on the commit
itself on a temporary `release-ci/v<version>` branch, which takes about as
long as the platform builds. After a flaky failure, re-run the failed CI jobs;
a release still waiting picks up the new attempt, and a release that already
stopped needs only `gh run rerun <id> --failed`. `ship_without_ci` skips the
wait, for emergencies only. See [CI job selection](ci.md#main-and-releases).

The workflow refuses to overwrite an already-published version. Manual Release
runs still require `package.json`'s version to be bumped on the selected ref.
A release is rejected if any installer, stable download
name, size, or digest is absent or inconsistent.

GitHub generates the release body (the changelog) from pull requests since the previous tag. Write PR titles for
people: they become the release notes on the downloads repo.

## Putting a release on madani.bot

The private repo's release is the canonical record; people download from the public downloads repo and madani.bot.
After publishing, run on the Mac:

```sh
scripts/publish-downloads.sh v0.1.142            # DRY_RUN=1 first to only verify
```

It downloads the release, checks every installer against the run's signed `SHA256SUMS`, uploads the installers to
the public `dzulhelmynazri/madani-bot-releases` release (stable `/releases/latest/download/` names that
madani.bot/download links to), then puts `latest.json` and `SHA256SUMS` on madani.bot through the deployd landing site.
Desktop apps read `https://madani.bot/releases/latest.json` (every 30 minutes) and accept it only when a pinned release key
signed it. To also put the release on madani clouds and own servers, with a canary and a staged desktop rollout, run
[`scripts/release-all.ts`](releases-auto-update.md) instead: it runs this script as one of its steps.

### The Mac browser part

The Mac installers leave out the bots' browser (agent-browser and Chromium's headless shell, about 92 MB zipped).
`pnpm package:mac` runs `scripts/pack-browser-part.mjs`, which signs it with the release's Developer ID (hardened
runtime), zips it as `MadaniBot-<version>-browser-darwin-<arch>.zip` in `release/`, and writes the `parts.json` the app
ships, pinning the zip's size and SHA-256 and the signing team. Both release paths notarize the zip and upload it with
the installers; `publish-downloads.sh` copies it to the public downloads release, where the app fetches it on its first
open (`server/app-parts.ts`) and uses it only after the size, SHA-256 and every Mach-O's signature check out. A release
without these zips leaves new Mac installs without a browser. Windows and Linux still bundle the browser (Linux's
AppArmor profile is bound to its install path).

### How the Mac app updates itself

`electron/app-update.mjs`, packaged Mac builds only:

1. Every 30 minutes (plus up to 10 minutes of jitter, the first 20 seconds after start, and 30 seconds after a wake), reads `latest.json`, checks its signature, and when the version is newer reads
   `https://madani.bot/releases/<version>/SHA256SUMS` and checks it against the sha256 the signature vouches for.
2. Downloads `MadaniBot-<version>-<arch>.zip` from the public downloads release
   (`https://github.com/dzulhelmynazri/madani-bot-releases/releases/download/v<version>/...`) into
   `~/Library/Application Support/<app>/app-update/` and checks it against `SHA256SUMS`.
3. Hands the zip to Electron's `autoUpdater` (Squirrel.Mac) through a feed on `127.0.0.1` at a random path, open only
   for that one download. Squirrel.Mac unpacks it and refuses it unless it is signed with the same Developer ID as the
   running app.
4. The sidebar shows "restart to update". The update installs when the person clicks it, when they quit, or at a quiet
   moment: the screen locked or nobody used the Mac or typed in the app for 10 minutes, and nothing running on this
   computer's server (a turn, a routine, a move, a sign-in) or in a Live call.

Anything that fails on the way, and every build that is not Developer ID signed (`codesign -dv` names no
`Developer ID Application` authority and team), falls back to the old behaviour: one notification per version that
opens madani.bot/download (`electron/update-notice.mjs`). Windows and Linux keep that notification.

What is needed once the Apple certificate exists:

- The `MAC_CERT_P12_BASE64` / `MAC_CERT_PASSWORD` and notarization secrets below, so the release job signs, notarizes
  and staples. The zips the job makes (`ditto -c -k --sequesterRsrc --keepParent` on the stapled app) are already what
  Squirrel.Mac takes; nothing else in the build changes.
- Every release after the first signed one must be signed with a certificate from the same team: Squirrel.Mac compares
  the new app's designated requirement with the running one's. A new certificate from the same team is fine; another
  team means one manual download.
- Builds people installed before the certificate (unsigned or ad hoc) cannot update themselves: they get the
  notification once and need one manual download of a signed build. From then on updates install themselves.
- Check one release end to end on a Mac: install version N from the dmg into `/Applications`, publish N+1, wait for the
  first check (2 minutes after start) or restart the app, and see "restart to update" appear. The log
  (`~/Library/Logs/<app>/`) says `app update: <version> is ready`.
- The app must run from a folder the person can write to (`/Applications` for an admin, or `~/Applications`).
  Squirrel.Mac cannot replace an app run from the dmg itself or one macOS translocated; those report an error in the
  log and keep the notification.

### Until the Mac build is notarized

Without `MAC_CERT_P12_BASE64` the release job builds the Mac app ad-hoc signed (`-c.mac.identity=-`) and skips
notarizing and stapling. macOS stops a downloaded dmg the first time, so `apps/site/releases.json` has
`"macNotarized": false`: madani.bot/download leads with `curl -fsSL https://madani.bot/install-mac | sh`
(`apps/site/install-mac.sh`, served by the site), which downloads this Mac's zip with curl (no quarantine flag),
checks it against the release's `SHA256SUMS` (whose hash the signed `latest.json` carries), installs it into
`/Applications` and opens it, and shows the three Open Anyway steps for the dmg. These builds cannot update themselves
(see above). Once the certificate is in, set `"macNotarized": true` and the page goes back to the dmg alone.

## Why the gates exist

Each verification step in `release.yml` maps to a real incident from the
hand-cut releases (0.1.15–0.1.25): stale build output breaking the code
signature, a bare import killing the packaged server on launch while every
check stayed green, helper paths resolving outside the app after bundling,
stapling silently invalidating every published hash, and a finished release
sitting invisible as a draft. Don't remove a gate without reading the comment
above it.

## Bundled browser gates

Desktop builds also stage a pinned engine and Chromium Headless Shell before
packaging. Pre-signing checks validate complete resources and upstream hashes;
native browser smoke tests and macOS signature checks run on the packaged
output. See [browser packaging](browser-packaging.md) for update ownership,
license provenance and Linux sandbox constraints. Missing browser resources
must fail the build, not ship an installer that downloads them on first use.

## One-time setup: release secrets

Set these in **madani bot → Settings → Secrets and variables → Actions**.

The **Prepare next release** workflow also needs
**Settings → Actions → General → Workflow permissions → Allow GitHub Actions
to create and approve pull requests** enabled. The workflow only creates the
version PR; it never approves or merges it.

The Mac signing secrets, exactly these names (the Mac job signs, notarizes and staples only when
`MAC_CERT_P12_BASE64` is set; without it the build is ad-hoc signed):

| Secret | Value |
|---|---|
| `MAC_CERT_P12_BASE64` | base64 of `~/.config/madanibot/apple/developer-id.p12` |
| `MAC_CERT_PASSWORD` | `APPLE_DEVELOPER_ID_P12_PASSWORD` from `~/.config/madanibot/madani.env` |
| `APPLE_API_KEY_P8_BASE64` | base64 of the App Store Connect API key (`AuthKey_<KEYID>.p8`) |
| `APPLE_API_KEY_ID` | the key's Key ID |
| `APPLE_API_ISSUER_ID` | the Issuer ID for a Team key; leave unset for an Individual key |

### 1. `MAC_CERT_P12_BASE64` + `MAC_CERT_PASSWORD`

The Developer ID Application certificate (team `S85QBF7KWC`). Its private key never left this Mac: it is
`~/.config/madanibot/apple/developer-id.key`, the certificate Apple issued for its CSR is `developer_id.cer` beside it,
and the first run of `scripts/release-mac-local.sh` (any mode but `--dry-run`) joins them into `developer-id.p12` with a
generated password saved as `APPLE_DEVELOPER_ID_P12_PASSWORD` in `madani.env`. To hand it to Actions without printing
either:

```sh
base64 -i ~/.config/madanibot/apple/developer-id.p12 | gh secret set MAC_CERT_P12_BASE64 -R dzulhelmynazri/madani-bot
sed -n 's/^APPLE_DEVELOPER_ID_P12_PASSWORD=//p' ~/.config/madanibot/madani.env | gh secret set MAC_CERT_PASSWORD -R dzulhelmynazri/madani-bot
```

### 2. `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID`

An App Store Connect API key for notarization (better than an app-specific
password for CI: revocable, scoped, no 2FA dance):

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Generate a **Team Key** (Developer role is enough for notarizing; App Manager also covers TestFlight uploads), or an
   Individual Key under your own user
3. Download the `.p8` (one chance only) into `~/.config/madanibot/apple/`, `chmod 600` it, and fill in `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER` (Team keys only) and `APPLE_API_KEY_PATH` in `madani.env`

```sh
source_env() { sed -n "s/^$1=//p" ~/.config/madanibot/madani.env; }
base64 -i "$(source_env APPLE_API_KEY_PATH)" | gh secret set APPLE_API_KEY_P8_BASE64 -R dzulhelmynazri/madani-bot
source_env APPLE_API_KEY_ID | gh secret set APPLE_API_KEY_ID -R dzulhelmynazri/madani-bot
source_env APPLE_API_ISSUER | gh secret set APPLE_API_ISSUER_ID -R dzulhelmynazri/madani-bot   # Team keys only
```

### 3. `MADANI_RELEASE_SIGNING_KEY`

The Ed25519 release key (`kid:<pkcs8 base64url>`) whose public half is pinned in
`apps/cloud-service/src/release-signing.ts` and `server/update-check.ts` (a test keeps them equal). The assemble job
signs `latest.json` with it; without it the release still builds but apps never hear about it. A new key:
`node apps/cloud-service/scripts/keygen.mjs rel-2027-01 ~/.config/madanibot/keys`, pin the printed public key in both
files, ship an app with it, and only then switch the secret.

### Releasing the Mac app from this Mac (no Actions)

`scripts/release-mac-local.sh` does the whole Mac job locally: build both arches, sign with the Developer ID from a
throwaway keychain (deleted on exit; the login keychain is never used, so nothing prompts), check every nested
Mach-O (hardened runtime, team, secure timestamp, no unsigned code inside zips or jars, the expected entitlements),
notarize the apps with `notarytool` and staple them, put each stapled app into its dmg
(`scripts/mac-dmg-swap-app.sh`, which keeps the dmg layout), notarize and staple the dmgs, re-zip the stapled apps for
the updater, then run Gatekeeper the way a downloaded copy meets it (`spctl` on the app and the dmg, `stapler
validate`, the same again with the quarantine flag set, and `syspolicy_check distribution`). On success it sets
`"macNotarized": true` in `apps/site/releases.json`; commit that with the release.

```sh
scripts/release-mac-local.sh --check         # what is present, what is missing, and where to get it
scripts/release-mac-local.sh --dry-run       # ad-hoc signed, every check that needs no Apple credentials
scripts/release-mac-local.sh --no-notarize   # Developer ID signed, not notarized (no API key needed)
scripts/release-mac-local.sh                 # signed, notarized, stapled: release/MadaniBot-<v>-{arm64,x64}.{dmg,zip}
```

Output lands in `release/` (plus `release/notary/*.json`, Apple's notarization logs, and `release/SHA256SUMS-mac`).
Nothing is uploaded; attach the dmgs, zips and the stable `MadaniBot.dmg` / `MadaniBot-intel.dmg` copies to the release.

### Entitlements

`build/entitlements.mac.plist` covers the app and, through `entitlementsInherit`, every nested executable
(Electron helpers, the speech helper, cua-driver, cloudflared, adb, the headless browser, native modules):

| Entitlement | Why |
|---|---|
| `cs.allow-jit` | V8 in the app, its helpers and the headless browser |
| `cs.disable-library-validation` | the server (the app run as Node) loads native modules; bots may load ones they install |
| `device.audio-input` | dictation (the speech helper and the composer) |
| `automation.apple-events` | `osascript`: opening Terminal, reading the screen size, bots driving apps the person allows |

`cs.allow-unsigned-executable-memory` is deliberately absent: the app run as Node with only these entitlements and the
hardened runtime ran optimized JIT code, WebAssembly and DuckDB on arm64 and x64 (2026-11-14). Add it back only with a
crash that proves the need. No camera, location, contacts or calendar access is used on the Mac (`electron/app-permissions.mjs` keeps camera off).
The matching purpose strings are in `mac.extendInfo` in `build/electron-builder.yml`.
