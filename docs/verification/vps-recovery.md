# VPS startup and transport recovery

Run the isolated regression fixtures:

```sh
pnpm exec vitest run server/vps-routing.test.ts server/vps-computer.test.ts server/vps-computer.runner.test.ts server/vps-ssh.test.ts server/vps-container-mcp.test.ts server/mcp-bridge.test.ts server/vps-inventory.test.ts server/kill-tree.test.ts
```

`server/vps-routing.test.ts` launches the real server and a fake engine in a temporary home.
Only Docker/SSH are replaced with fixture executables. It holds a screenshot beyond
the old five-second lock deadline, sends a message in both Cloud and Auto, then
releases the screenshot. Both turns must complete with the correct VPS tools mounted.
The old implementation fails both cases with “the VPS is being prepared.”

The same real-server fixture reuses existing containers with customized resource/OOM settings and an
operator restart policy, or unlimited budgets and the legacy `no` restart policy. Status must report
ready, Cloud and Auto turns must receive the existing VPS computer, and the Docker log must contain no
create, remove, start, stop or settings-reset command. Resource and restart settings are creation
defaults; ownership, image, network, mount and isolation checks remain required.

The other fixtures cover:

- Concurrent preparation shares one operation; an already-ready computer is checked once.
- An already-running desktop validates image and container in parallel, followed by one exec that checks driver
  version, socket status, health and desktop access in order. A failed step stops that exec. The transport fixture
  models 100 ms per command and requires readiness in two round trips instead of six sequential calls.
- Concurrent bot creation on one host shares image, network and isolation preparation. A later creation rechecks
  the host fence; separate hosts and failed retries never reuse one another's preparation.
- Concurrent status polls and previews share inspection, without caching pre-stop state.
- Preview and desktop-readiness waits stay bounded, including process cleanup time.
- Stop/Delete remain serialized, and failed preparation releases the next retry.
- Real disposable processes simulate Docker with a stubborn SSH child. Timeout and
  stdin failure must reap the owned child, leave an unrelated detached process alone,
  and allow the next command to succeed.
- OpenSSH parses paths with spaces and long data directories without contacting a VPS.
- The bot's MCP transport and watchdog use the same SSH settings as the preview.

These fixtures do not prove a customer's network, remote Docker daemon, or actual Cua
desktop is healthy. They require no real VPS, Docker daemon, provider key, or live app data.
The existing [cloud preview fixture](cloud-preview.md) covers renderer error/retry behavior.

## Linked-server startup and cancellation

Run the controller and transport regressions, then the loopback setup fixture:

```sh
node --test electron/vps-link-startup.node-test.mjs electron/vps-link-transport.node-test.mjs electron/vps-link-retry.node-test.mjs
pnpm exec vitest run electron/vps-link.test.mjs electron/vps-link-main.unprotect.test.mjs apps/link-service/test/link-service.test.mjs apps/link-service/test/agent.test.mjs
```

The startup regressions hold credential decryption and listener readiness to prove
that simultaneous startup and settings requests open exactly one listener per
linked server. Saved servers start independently, and requests wait for their
own listener's final origin. Concurrent sign-in checks share one session check
and one re-pairing operation. Starting an AI sign-in now performs one session
check rather than two sequential checks; it still refreshes engine sign-in state.
These assertions measure duplicated operations removed, not real WAN latency.

Cancellation tests hold the relay's delete response, the setup watch response,
server pairing, initial command creation and credential protection independently.
Regenerating a command returns without waiting for the relay delete, stale setup
results cannot replace the new command, and a cancelled or failed pairing never
saves a server. Cancellation, shutdown and overlapping starts invalidate pending
command creation; a late unused relay session is revoked. A failed pairing's temporary
listener closes. Relay deletion is best effort: cancelling the app flow cannot
stop an installer already running on the VPS, and deleting the linked server
remains a separate action.

Transport fixtures prove that closing a proxy aborts its outstanding poll and
upload, clears queued bytes, and releases paused producers. An unlinked tunnel
returns an immediate local error for subsequent HTTP/control requests instead of
waiting for the response deadline. Slow HTTP and desktop receivers are given a
per-stream 8 MiB writable-buffer limit, allowing a full healthy relay batch. A
16 MiB synthetic flood cancels only the stalled stream while another HTTP
response completes. Tunnel POST response bodies are cancelled so pooled
connections can be reused. The loopback service and separate agent process exercise pairing, AI credential transfer, streaming uploads, backup-first
moves, and WebSocket desktop traffic through the real sealed relay protocol.
All servers, homes, credentials and desktops in these checks are synthetic.
They do not establish packaged Electron startup time, real VPS installation time,
or a latency improvement on the user's network.

## Shared desktops and VPS-only routines

```sh
pnpm exec vitest run server/team-computers.test.ts server/team-computer-vps.test.ts server/routes/computers.test.ts server/routes/computer-frames.test.ts server/routes/computer-usage.test.ts server/computer-frames.test.ts scripts/testing/team-computers-fixture.test.ts
pnpm exec vitest run server/vps-routing.test.ts -t 'shares one VPS|explicitly cloud-targeted|cleans up shared VPS'
```

These checks preserve named desktop identities and sharing acknowledgements while
routing their resources through the workspace's default VPS alias. Auto members
share one container and one desktop lock, including members with legacy provider
selections. Explicit computer destinations remain separate, and a bot outside the
assigned section does not inherit the desktop. Human control uses the shared
owner key; snapshots contain no lease secret and a different lease cannot release
its holder. Ready-only remote joins return the authenticated viewer URL and
recheck session and hold state after opening the tunnel.

The real-server fake-Docker fixture starts two teammate turns with distinct
capabilities, proves contention on their shared desktop, and refuses assignment
and host changes during those turns. It also runs an explicitly cloud-targeted
routine on the VPS without a separate computer-provider account. Failure and
cancellation checks cover a missing shared container and Stop during a held
readiness inspection, ensuring no late wake or permanent busy record.

`scripts/testing/team-computers-fixture.test.ts` uses the standard verification launcher with
owned Docker/SSH executables and a loopback RFB server. The preview helper uses
that same fixture through the launcher's existing loopback machine contract.
Neither helper can invoke the host Docker daemon or contact a real VPS.

## Opening a saved VPS while the local server starts

```sh
node --test electron/saved-vps-startup.node-test.mjs
node scripts/verify-saved-vps-startup.mjs
```

The native fixture uses hidden disposable Electron windows and loopback pages.
It holds local startup while the saved VPS opens, occupies the original local
port, then confirms a different port and navigates the same window to it.
The occupied port has no private desktop bridge before or after confirmation;
the confirmed local page can use its private IPC. A local boot failure leaves
the opened VPS usable. The Node cases cover competing launch intents, target
changes, tunnel failure and local startup finishing before a delayed tunnel.

Only a verified saved hand-linked VPS is eligible for early navigation. Local
startup and pending organization, cloud, package or chat-link actions retain
their existing precedence. Permission handlers are installed before navigation,
and local utility requests wait on the shared bounded startup promise. This
proves the removed dependency and bridge boundary, not a production cold-start
time or the health of a real server.

## Sleeping and waking an idle VPS computer

```sh
pnpm exec vitest run server/vps-idle.test.ts server/vps-idle.e2e.test.ts scripts/control-madani.test.ts
```

The default idle window is ten minutes. Settings may select five, ten or thirty
minutes, or turn automatic sleep off. Each owned desktop has one timer keyed
by its snapshotted SSH alias and owner, including a computer shared by several
bots. Only computer actions, manual wake and handing control back renew it.
Observing an already running computer arms its first window after a restart;
later status and preview requests leave that deadline alone.

Fake-clock checks cover active GUI work and human holds, changed assignments,
activity arriving during stop inspection, replacement container identities,
configuration changes, shutdown and bounded retries after an unreachable
daemon. Three failed stop attempts wait for new activity before trying again.

The standard isolated launcher runs the real server with owned Docker/SSH
fixtures. Its explicit `MADANI_TEST_VPS_IDLE_CLOCK=1` hook shortens nonzero windows
to 750 ms only in a disposable home. The API fixture proves read-only status
and screenshot traffic cannot keep a computer awake, a person's hold protects
it until handback, Stop ends an active GUI lease, and a later bot turn or manual
wake starts the same stopped container. It verifies no removal, rebuild or
replacement. Server logs and bounded action/state evidence remain at the paths
printed by the tests. These checks use no live VPS or user data.
