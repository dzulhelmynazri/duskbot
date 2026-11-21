# Connectors that follow the person

What it covers: MCP servers reached by address (Composio Connect among them)
and their sign-ins, kept level between this computer, My Cloud and servers of
the person's own (`server/connector-sync.ts`, `electron/connector-sync.mjs`).

```sh
pnpm exec vitest run server/connector-sync.e2e.test.ts server/cloud-connections.e2e.test.ts server/cloud-connections-host.test.ts server/cloud-send-move.e2e.test.ts
node --test electron/connector-sync.node-test.mjs
```

`server/connector-sync.e2e.test.ts` runs this computer's server (its private
port over Node's IPC) and a Cloud home from `scripts/testing/cloud-send-fixture.ts`,
with a fake connector service on loopback (`MADANI_TEST_CONNECTOR_HOSTS` makes
fixture places treat it as a public address). The service rotates its refresh
token on every use and ends the whole sign-in when a spent one comes back, as
Composio's sign-in server does. It checks, with a real connection test on each
side: a server signed in on this computer arrives on My Cloud, which then holds
the sign-in while this computer borrows its access token; an app connected
through it shows on both; top-ups refresh only on My Cloud and never reuse a
refresh token; a sign-out on My Cloud signs this computer out; the move to My
Cloud keeps this computer's access token, lent; the way home brings the sign-in
back; a removal here removes it there; the secrets routes answer only over the
private port here; no token reaches a log.

`electron/connector-sync.node-test.mjs` covers the merge rules with in-memory
places: add and remove by time, sign-outs, a name another server holds, places
with sign-ins of their own, a Cloud whose plan sleeps borrowing rather than
holding, top-up timing and the way home.

Not covered here: the two-minute timer in a packaged app, and servers of the
person's own (the same routes, reached over the window's sign-in there).
