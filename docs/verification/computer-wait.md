# Waiting for a shared computer

Run the current VPS and resource-lock checks in disposable homes:

```sh
pnpm exec vitest run server/vps-routing.test.ts -t 'shares one VPS desktop and lock'
pnpm exec vitest run server/team-computer-vps.test.ts scripts/testing/team-computers-fixture.test.ts
pnpm exec vitest run server/turn-resources.test.ts
pnpm exec vitest run server/index.test.ts -t "shares one team computer|queues computer waiters|parks the turn|routes a goal run"
```

The real-server VPS case uses fake Docker/SSH and fake ACP engines. It proves:

- Auto teammates in one section receive the same workspace-owned container,
  while an outsider receives a different target and no shared-computer record.
- Each turn receives its own capability; once one reaches for the desktop,
  another turn is told the computer is held.
- Reassigning the computer or changing the workspace VPS alias is refused
  while the turns are active.
- A person's control lease is shared across the members but never exposed in
  responses. Another viewer cannot release it with a different lease id.
- A screenshot while the computer is in use sends no stop, remove, kill or
  pause command.

The target unit tests additionally check that explicit Off, Local, VM and Cloud
choices do not inherit the Auto team's computer, and that a configuration
reload cannot redirect an operation already using its snapshotted VPS alias.
The API fixture checks the same shared-container mapping with an owned Docker
stand-in and no paid desktop configuration.

The resource-lock unit tests cover:

- Independent resources can run together, while one desktop stays with its
  owner across a screenshot/click sequence.
- Releasing a holder grants the seat to the first arrival; a lazy claimant
  cannot jump the queue.
- Releasing an old turn generation cannot release its replacement.
- A wait estimate appears only after a completed wait, then smooths recent
  history; invalid samples are ignored.

Waiting remains bounded by the computer wait ceiling
(`MADANI_COMPUTER_WAIT_MAX_MS`, 30 minutes by default). At the ceiling, the runtime
parks the root for later continuation. The migrated real-server index cases
prove direct-thread and room waits, arrival-position transcript chips, Stop
during a wait, park/resume and goal fairness on shared VPS resources. Their
container and engine transports are disposable stand-ins; resource claims,
queueing, transcript events and continuation run in the real server.

No fixture contacts a paid desktop provider or operates the user's computer.
These checks prove routing, shared ownership and privacy boundaries, not a
real VPS network or desktop input. Use [the desktop viewer fixture](desktop-viewer.md)
for synthetic RFB/input verification and [VPS recovery](vps-recovery.md) for
startup and preview contention.
