# Sidebar sections and legacy team data

Named sidebar sections organize bots and group chats. The department editor,
Team map and canvas were removed. Older shared-instruction and memory fields
are retained on disk by `server/section-context.ts`; that preservation is not
a current shared-instructions editing feature.

Run the remaining isolated lifecycle checks:

```sh
pnpm exec vitest run server/team-lifecycle.e2e.test.ts server/store.test.ts --maxWorkers=2
```

The server test uses `launchVerificationServer`, sends a sample conversation,
creates an empty team, moves two existing bots, plants legacy shared instructions,
renames the populated team, adds and removes members, then empties and renames
it again. It imports a legacy template with a colliding name and restarts the
exact disposable server. It checks retained instructions and conversation
messages, archived bots moving to General when their team is deleted, and
explicit empty-team deletion. API requests and `control-madani` wait/messages
results are kept beside the fixture log in `*.team-lifecycle.json`.

A second real process restart uses legacy bot and group records needing
migration beside a deliberately malformed team registry. Startup keeps both
conversations readable and persists their task migrations, logs a diagnostic,
and leaves the malformed file byte-for-byte unchanged. Later team and shared
instruction writes still fail closed until that file is repaired.

The retired Team map, canvas and team-computer browser fixtures are not
available. The server lifecycle fixture does not prove current sidebar gestures
or a working remote desktop. Use [the sidebar fixture](sidebar.md) for its
supported interactions and [the desktop viewer fixture](desktop-viewer.md) for
remote desktop behavior.

The owner API keeps the existing `/api/sidebar-sections` name for older clients:

- `GET` returns `{ sections: string[] }`.
- `POST { name, botIds?: string[] }` creates a named team or moves the supplied
  bots into it. Omitted/empty `botIds` creates an empty team. An empty name with
  selected bots moves them into General. Chief conflicts change no memberships.
- `PUT ?section=NAME { addBotIds: string[], removeBotIds: string[] }` updates
  membership in an existing team. Removed bots move to General. Invalid or
  stale membership changes are rejected without partially applying the move.
- `PATCH ?section=NAME { name }` renames a team, including its bots, archived
  bots, group chats, shared instructions, management grants and assigned team
  computer. It cannot merge into an existing team or rename during active work.
- `DELETE ?section=NAME` removes the team and its shared instructions while
  retaining bots, archived bots, group chats and their conversations in General.
  Finish active work and unassign any team computer first. Chief conflicts
  reject the deletion rather than changing leadership.

The registry shares the atomic section-context file so rename/delete cannot
split a team's name from its instructions. Team labels are remembered before a
bot write; a storage failure may leave an empty team, but cannot partially move
the selected bots. This does not change bot communication permissions.

Both fixtures own their fake engine, temporary home and data directory. Cleanup
stops only their own child processes. Never run these requests against the live
app or copy live data into a fixture.

## Shared VPS computer and retired provider settings

```sh
pnpm exec vitest run server/team-computer-vps.test.ts scripts/testing/team-computers-fixture.test.ts server/legacy-cloud-migration.e2e.test.ts
pnpm exec vitest run server/vps-routing.test.ts -t 'shares one VPS desktop and lock'
```

The shared VPS fixtures use temporary registry files and an isolated server
with owned Docker/SSH executables. They check one workspace-owned target for
Auto members, explicit destination overrides, no outsider access, distinct
turn capabilities, one screen lock, safe alias snapshots and private human
control leases. See [the shared-computer recipe](computer-wait.md) for limits.

The migration fixture plants a synthetic old provider token in its temporary
config. The token stays private and is retained on disk during unrelated
settings writes; new paid-provider settings are refused. Legacy client
backend values are normalized to VPS through create and patch requests.
This checks compatibility without reading or operating any old provider
account. It does not qualify a real remote server or browser UI.
