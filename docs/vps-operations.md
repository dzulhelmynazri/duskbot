# VPS operations

The private server build includes a small operations CLI. Run it over SSH on
the Linux VPS from the account that installed or operates the server:

```sh
madanibot vps status
madanibot vps doctor
madanibot vps logs
madanibot vps logs --service link --lines 200
madanibot vps logs --service fence --lines 50
madanibot vps doctor --json
```

If the installer used its default `madani` account, its executable is
`/home/madani/.local/bin/madanibot`. Use that path when it is absent from your
SSH account's PATH.

`status` checks the local HTTP endpoint, server/link/network-fence systemd
services, managed Docker computer states, host memory/load/uptime, and available
space on the data filesystem. `doctor` adds suggested commands for failed
checks. Both accept `--port N` and `--data-dir DIR` for a nondefault install.
HTTP and subprocess checks run concurrently with four-second deadlines. A
failing check does not prevent the remaining diagnostics from being printed.

`logs` reads a journal tail for `server`, `link`, or `fence`. It defaults to 100
lines and accepts 1 to 500. Output is capped at 256 KiB, and credentials,
environment assignments, pairing links, terminal controls and private keys are
scrubbed before output. It does not follow the journal indefinitely. `--json`
returns the redacted tail as a JSON document. Journal access uses the account's
existing permissions; the CLI neither invokes sudo nor grants access.

All three commands are read-only. They work when the bot server is stopped,
do not start services or computers, and do not open the app's configuration,
database, message history, or saved credentials. Docker is inspected through
the local `/var/run/docker.sock` only. The status describes local service
health; an active link process does not prove that the remote relay or a
particular desktop client's network is reachable.

For bot and conversation operations against a running workspace, use the
existing `madanibot doctor`, `bots`, `messages`, `run`, `wait`, and `events`
commands documented in [the headless CLI](headless-cli.md).

App and server upgrades are operator-managed for this private fork. The
desktop does not initialize an update provider, query release feeds, or install
downloaded updates on quit or while idle. The server's update check returns no
release offer or public npm install command. Packaging has no publish target;
project and release links point to `dzulhelmynazri/madani-bot`.

Install a reviewed private build before restarting the services you intend to
update.

Verification uses temporary homes and a disposable fake-engine server:

```sh
pnpm exec vitest run server/vps-ops.test.ts server/vps-ops.e2e.test.ts
node --experimental-strip-types server/madanibot.ts vps --help
pnpm exec vitest run server/update-check.test.ts server/update-check.e2e.test.ts
```

The fixtures prove argument bounds, read-only command selection, concurrent
checks, unavailable services, log redaction, process deadlines/output limits,
and real fixture HTTP health before and after shutdown. They do not access a
real VPS, its journal, Docker daemon, relay, or production bot data.
