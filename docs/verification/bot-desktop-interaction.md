# Bot desktop interaction

Build the bot desktop under an isolated fixture tag, then select that tag explicitly:

```sh
MADANI_VERIFY_DESKTOP_IMAGE=omb-bot-desktop:lean-fixture node --experimental-strip-types scripts/verify-bot-desktop-interaction.mjs
```

The verifier resolves the image to an immutable ID and creates two uniquely named,
read-only, network-none desktops as uid 1000. It publishes no ports, mounts no host
paths or Docker socket, uses temporary homes, and removes only its own containers.
The page and HTTP form server live inside each container. No provider or model is used.

For both Chromium's defaults and an explicit `--force-renderer-accessibility`
launch, it reads the actual AT-SPI tree, clicks the named input, types through CUA,
and clicks Submit. The HTTP server must receive the exact typed value and the
Linux desktop screenshot must show the resulting page.

It also runs `createBrowserHost` with the production `boxChromeRelay` and the
installed browser engine. The app's structured tools open, fill, click and read
the same container browser. A second HTTP receipt proves the target is the Linux
fixture, and the tool filter must hide CUA's browser tools while retaining native
desktop input and capture. Only a loopback CDP transport is exposed on the test
machine; it is closed during cleanup.

The printed evidence directory retains `receipt.json`, native trees, driver logs,
HTTP/browser receipts and screenshots. Timings include the local Docker transport
and are observations, not VPS capacity or internet latency benchmarks. No Mac
computer control, production network fence, gVisor or real sign-in is qualified.

The direct vendor browser path has a separate opt-in qualification:

```sh
MADANI_VERIFY_DESKTOP_IMAGE=omb-bot-desktop:lean-fixture node --experimental-strip-types scripts/verify-bot-desktop-interaction.mjs --native-browser
```

This keeps failures strict. The fixture HTTP server handles concurrent connections
because Chromium can open a speculative connection before sending a request.
The native browser click explicitly permits foreground delivery inside its isolated Linux
desktop, as the driver's schema requires for trusted input there. The verifier
requires the exact HTTP form receipt and fails on refused actions.

CUA Driver 0.37.0 with Chromium 156 passed native desktop, native browser and app
browser form submission. The default and forced-accessibility launches both
exposed 38 AT-SPI elements, including the named input and button, so the fixture
did not establish a benefit from forcing renderer accessibility.

The independent-screen qualification uses the same isolated image:

```sh
MADANI_VERIFY_DESKTOP_IMAGE=omb-bot-desktop:twenty-screens-fixture-20261107 node --experimental-strip-types scripts/verify-bot-desktop-screens.mjs
```

It acquires two screens through the real broker and guest runtime, submits a
different form from each using both the app browser bridge and native CUA input,
checks distinct profiles and cookies, and reads the same shared-home file.
It also requires generation-safe restart and reset to retain persistent cookies
while preserving the primary desktop. Screenshots, app call timings and the
strict result are retained in the printed evidence directory.

The primary desktop has a separate Docker lifecycle qualification:

```sh
MADANI_VERIFY_DESKTOP_IMAGE=<imageID> node --experimental-strip-types scripts/verify-bot-desktop-primary.mjs
```

It checks persistent HTTP cookies across Docker stop/start, including a browser
reopened through the app relay, and shutdown before a browser is running.

The resource benchmark requires an image with 20 lazy independent screens:

```sh
MADANI_VERIFY_DESKTOP_IMAGE=<imageID> node --experimental-strip-types scripts/benchmark-bot-desktop-screens.mjs --counts=1,4,20
MADANI_VERIFY_DESKTOP_IMAGE=<imageID> node --experimental-strip-types scripts/benchmark-bot-desktop-screens.mjs --counts=20 --forms --browser-limit=4 --admission-stress
```

It uses 2 CPUs, 4 GiB memory without swap, 4,096 processes, 64 MiB runtime storage
and an owned disk-backed home volume. Idle samples include one primary blank
browser. Active samples run app browser and native CUA forms in bounded batches,
close browsers while retaining profiles, then recheck independent cookies.
The admission probe opens managed blank browsers sequentially until the guest
declines or every provisioned screen has one. It never bypasses admission.

Evidence includes cgroup memory, cache, CPU and OOM counters, summed RSS and PSS,
startup and workflow timings, generation checks and cleanup. RSS counts shared
pages repeatedly; cgroup cache charges also vary between cold and warm starts.
Compare anonymous/shared memory and PSS alongside total memory. These are guest
container measurements with lightweight local HTML; the host server, tool-host
processes, Docker and real websites require additional resources.

The Chromium policy and extension fixture uses an explicitly selected image:

```sh
MADANI_VERIFY_DESKTOP_IMAGE=<imageID> node scripts/verify-bot-desktop-browser-policy.mjs
MADANI_VERIFY_DESKTOP_IMAGE=<imageID> node scripts/verify-bot-desktop-browser-policy.mjs --installed-defaults
```

The comparison mounts owned empty/trial recommended-policy directories; the
installed-defaults mode reads the baked image without mounting policies. Both
use a locally authored Manifest V3 extension and an isolated HTTP page to check
content scripts, a service worker, persistent storage across browser restart,
native Unicode input and screenshots. Only the owned test extension is mounted
read-only. No browser sign-in or Web Store account is used.

Short idle samples do not establish Memory Saver's automatic-discard savings.
Report anonymous/shared memory and PSS separately from reclaimable file cache,
and do not treat one startup/navigation observation as a latency benchmark.
