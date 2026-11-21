# Slack bots

Each bot can join a Slack workspace as its own Slack app, with its own name, avatar, @handle and DMs. All Slack
traffic goes between the harness and Slack directly over Socket Mode; nothing hosted sees a message or a token. The
one hosted piece is the stateless `GET /slack/callback` page on the link service, which only turns Slack's OAuth
return into a `madanibot://slack/oauth` link.

## What to verify without Slack

Never use a real workspace or call slack.com from a recipe. `server/testing/fake-slack.ts` is an in-process fake of
the Web API, private file URLs, pre-signed uploads and the Socket Mode websocket.

```sh
pnpm exec vitest run server/slack-bots.e2e.test.ts
```

It starts the fake, sets `MADANI_SLACK_API_URL` to it (a fixture only ever reaches a loopback Slack: anything else
becomes a closed port, see `scripts/control-madani.ts`) and `MADANI_SAVED_SECRETS_KEY_FILE` to a key file outside the
fixture's data folder (the default key sits inside a fixture's folder, so the encrypted store would stay unavailable),
then launches the usual fake-engine fixture and drives it over HTTP:

- `PUT /api/slack/workspace` with the pasted configuration token pair: the harness rotates it at once with
  `tooling.tokens.rotate` and keeps only the new pair;
- `POST /api/slack/bots/:id/provision`: the app is created from the bot's manifest (Socket Mode on) and the answer
  carries Slack's authorize URL with a 64-hex `state`;
- `POST /api/slack/oauth` with a wrong state (400), the right one (installed), and the same state again (400: single use);
- `POST /api/slack/bots/:id/app-token` with a bad token (400) and a minted `xapp-` token: the bot comes online;
- a DM over the socket: acked well inside 3 s, `:eyes:` on the message while the turn runs, the reply converted to
  mrkdwn in the message's thread, `:eyes:` removed, a conversation titled `Slack · @Alice` holding a `relayed` line
  from Alice; the same event redelivered posts nothing and adds no line;
- an `app_mention` in `#general`: its own conversation `Slack · #general`, the mention stripped, the reply threaded;
- a PNG shared in a DM becomes an `<attached-image>` line (downloaded with the bot token from the file host only);
  a `+1` on the bot's reply becomes a 👍 on the reply in the conversation;
- a turn whose engine calls `slack_post`, `slack_read`, `slack_react`, `slack_upload` and `attach_file` through the
  agents server: the post, the reaction and both uploads (the tool's and the reply's attachment) reach the fake, and
  the agents server was launched with `MADANI_SLACK=1`;
- the socket dropped by Slack: the bot reads `offline`, reconnects and reads `online` again;
- no token, refresh token, client secret or signing secret appears in the server log, the engine's launch dump, or any
  file in the data folder other than `slack-secrets.json.enc`;
- `DELETE /api/slack/bots/:id`: the bot token is revoked and the app deleted.

Unit suites cover the rest (rotation timing and failure to `needs_reconnect`, the manifest, state expiry, socket
reconnects and acks, mrkdwn and splitting, files out, needs-input notices, tools and their refusals, routes):

```sh
pnpm exec vitest run server/slack/ server/routes/slack.test.ts server/testing/fake-slack.test.ts \
  server/drivers/agents-slack-tools.test.ts shared/slack.test.ts shared/outbound.test.ts \
  apps/link-service/test/slack-callback.test.mjs src/lib/slack-oauth-link.test.ts src/components/slack/
node --test electron/slack-link.node-test.mjs
```

## Trying it with a real workspace (by hand, on the person's own app)

1. Settings > Connections > Slack > Connect: open Your Apps on api.slack.com, Generate Token under Your App
   Configuration Tokens for the workspace, paste both tokens. It reads "Connected to <team>".
2. A bot's Advanced tab > Slack > Add to Slack: Slack's install page opens in the browser; Allow. The link page
   returns to the app by itself (or paste the link it shows into the field under "Waiting for Slack").
3. Open the app page from the next step, Generate Token and Scopes under App-Level Tokens with `connections:write`,
   paste the `xapp-` token. It reads "Online as @Name in <team>".
4. In Slack, `/invite @Name` in each channel it should read; DM it or mention it.

Free Slack workspaces allow 10 apps; each bot uses one. Configuration tokens expire every 12 hours: the harness
rotates them 30 minutes early, and asks for a new pair (Reconnect) when Slack refuses the refresh token. Bots keep
working without the workspace token; it is only needed to add, rename or remove a bot's app.
