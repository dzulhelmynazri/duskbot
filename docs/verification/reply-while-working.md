# Reply while working

## Sub-features

- The person's own message, sent in their one-to-one chat while the bot works,
  gets a quick reply from a small fast model in a separate call, usually within
  a few seconds, as an ordinary bot message (`sideReply: true`, no `turnId`,
  so no tool chips, receipts or "Worked for" fold). The working line stays
  below it.
- The same call decides what happens to the running task:
  - **answer** (a question or small talk): only the reply; the turn runs on
    untouched and never sees the question.
  - **steer** (extra information or a correction): an acknowledgement, and the
    person's words go into the running turn with a note not to answer them on
    their own. An engine that cannot take input mid-turn, or a turn that is
    ending, gets them first in the queue, so its continuation runs them.
  - **stop**: the reply, then the person's own Stop.
  - **redirect**: the reply, the new ask queued first, then Stop, so it runs next.
- No quick reply (no writer, an error, a timeout after 12 s, an unreadable
  answer): the message takes its old path, steered or queued, with person-first.
- Never in rooms: room messages keep queueing for the room's next turn and room
  routing picks who answers. Never for apps, teammates, routines, relayed
  lines, calls, images, an explicit queue or restart choice, a turn waiting on
  the person, or with `features.quickUpdates` off.

## Who writes the quick reply

The `side-reply` side job (`server/side-jobs.ts`), on the engine running the
thread, in a call of its own beside the turn:

| Engine | Quick reply |
|---|---|
| API bots (OpenAI-compatible, OpenRouter, Groq, Cerebras, Mistral, ...) | the bot's own provider in a separate request, on the engine's fastest model (`fastModelFor`) |
| Claude | a separate one-shot `claude -p` process on the person's Claude sign-in, on Claude Haiku (`claude-haiku-5-5`) without tools |
| Codex | a separate one-shot `codex exec` in an empty folder, on the small model Codex's background route picks |
| ACP engines (OpenCode, Gemini, Kimi, Qwen, Copilot, ...) | a separate one-shot ACP session in its own process, on the engine's default model |
| Pi, Muse Code, Antigravity (no one-off call) | the helper model when one is set, else OpenCode's free backup when installed and the bot's helper switch is not off |

Concurrency: every row is a separate request or process, so it runs while the
turn holds its own session. One-shot CLI processes take longer to start than an
API request.

## Driving it

The responder is scripted with `FAKE_CLAUDE_TEXT_ROUTES` (a file of
`{"marker": "reply"}`; the first marker the one-shot prompt contains wins, so
list the newest message's marker first), and the long task with `--script`,
whose `{"ifSteered": "..."}` step says its text only once a steer arrived.

```sh
FAKE_CLAUDE_TEXT_ROUTES=$PWD/routes.json \
  node --experimental-strip-types scripts/control-madani.ts ui launch --script "$(cat script.json)"
```

`routes.json`:

```json
{
  "<<<\nok please stop now": "{\"kind\":\"stop\",\"reply\":\"Okay, I've stopped.\"}",
  "<<<\nonly direct flights please": "{\"kind\":\"steer\",\"reply\":\"Got it, direct flights only.\"}",
  "<<<\nare you doing this yourself?": "{\"kind\":\"answer\",\"reply\":\"Yes, I'm doing this myself.\"}"
}
```

`script.json`: an ack, `mcp__agents__set_status`, a search, waits of 12 s
between fetches, `{"ifSteered": "Switching to direct flights only."}` after a
wait, and a 60 s wait before the result.

The preview's composer reaches the fixture over plain loopback, which is not a
person's own send (only a session or the desktop app's is), so send as a paired
person: `POST /api/auth/pairing`, `POST /api/auth/pair` with the code, then
`POST /api/bots/BOT_ID/messages` with `authorization: Bearer TOKEN`. The
renderer shows the result over SSE.

Expected, in `GET /api/bots`: the question's row is `steered: true`, a
`sideReply` bot row follows it within a second and the turn stays busy with its
next tool call after it; the steer gets its `sideReply` acknowledgement and the
turn then says the `ifSteered` text; the stop gets its reply, a
`stopped: You stopped this.` row and `busy: false`. The server log has one
`side reply: answer|steer|stop in THREAD after N ms` line per message.

The permanent form is the `replies while working` case in
`server/steer-e2e.test.ts`; routing, timeouts, ordering and who gets a quick
reply are in `server/host/side-replies.test.ts`, and the writer choice in
`server/side-jobs.test.ts`.

### Last exercised

2026-11-17 against the fake engine: answer, steer and stop each 104 to 119 ms
after the message (the fake responder answers at once); light and dark
screenshots in the desktop chat. Not exercised against real engines.
