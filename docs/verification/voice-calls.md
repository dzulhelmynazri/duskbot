# Voice calls with the built-in voice

A call from a chat's composer with no key or account: the page's microphone
(echo-cancelled by Chromium, so the person can talk over the bot), a turn
detector in the page, Moonshine base hearing on the harness, the bot's normal
turn (marked `via: "call"` with the call's id, and told its reply is spoken),
and Kokoro-82M saying the reply once it is in the chat. The models (about 160 MB)
are fetched by the desktop app's harness (and a Cloud's) while it is quiet: 90 s
after start, making way for turns and batteries, resuming, retrying 10 minutes
after a failure (`server/local-voice/prefetch.ts`). They come from
`https://madani.bot/voice/<sha256>/<name>` first and the pinned upstream after,
hash-checked (`scripts/mirror-voice-models.sh` puts them on madani.bot).

## Sub-features

- `GET /api/voice/local` says whether the runtime loads here, the download's
  progress, and the voices; `POST /api/voice/local/prepare` downloads and warms;
  `POST /api/voice/local/speak` answers a WAV; `POST /api/voice/local/transcribe`
  takes a WAV of one spoken turn.
- A line said on a call carries `voiceCall: { callId }`; the route turns it into
  `via: "call"` and puts the spoken-reply note before the prompt.
- The call bar: the bot, a waveform (bars for whoever talks, dots in silence),
  voice and speed, transcript, mute, hang up. Without the transcript the chat
  steps back behind the bot.
- Talking over the bot dips it at once and stops it after a further 160 ms of
  voice; a short noise only dips it. A turn that ends on "and", "um" and the
  like waits 900 ms for the rest.
- A call starts as soon as the microphone opens. Until a half of the models has
  arrived, the computer's own voice speaks (the best Premium or Enhanced system
  voice) and its own recognizer hears (the dictation helper; none on Linux
  without a key, where the turn waits for the models); the call takes turns
  while they stand in, and takes each half as it lands, sentence by sentence.
  No download text is ever shown.
- Voices come out near -16 LUFS: the built-in voice is normalised on the
  harness, and every played clip (read-aloud too) goes through a soft
  compressor and a -1.5 dBFS limiter. A quiet microphone turn is raised before
  it is heard.
- Soft connect and hang-up chimes (`src/lib/voice-call/chime.ts`), where the
  app's sounds are on; the first words wait for the connect chime.

## Recipe

```sh
MADANI_VITEST_WORKERS=2 pnpm exec vitest run server/local-voice server/routes/local-voice.test.ts server/routes/bot-messages.test.ts src/lib/voice-call
# the real models, once downloaded (any MADANI_VOICE_MODELS_DIR that holds them):
MADANI_VOICE_MODELS_DIR=~/Library/Caches/bot.madani.app/voice pnpm exec vitest run server/local-voice/engine.e2e.test.ts
```

By hand, a whole call in headless Chromium with a WAV as the microphone:

```sh
# terminal 1 (MADANI_VOICE_MODELS_DIR crosses into the fixture)
MADANI_VOICE_MODELS_DIR=~/Library/Caches/bot.madani.app/voice FAKE_CLAUDE_STREAM_CADENCE=10:30 \
  FAKE_CLAUDE_REPLIES='["You have two meetings tomorrow."]' \
  node --experimental-strip-types scripts/control-madani.ts ui launch --tool-calls '[]'
# terminal 2: Chromium with --use-fake-ui-for-media-stream --use-fake-device-for-media-stream
# --use-file-for-fake-audio-capture=<16-bit WAV: silence, a question, long silence>, microphone permission granted;
# open previewUrl, click [data-call-button="composer"], read [data-voice-call] for the phase and
# [data-turn-ms] for endpoint,transcribed,sent,firstAudio in ms after the person stopped.
```

Expected: the phase goes connecting, listening, hearing, thinking, speaking,
listening; the chat shows the question "Via call" and the reply.

## Gotchas

- The UI preview does not reload code from a worktree under `.claude/`
  (vite.config.ts ignores it): restart `ui launch` after a change.
- `echoCancellation: "all"` gave pure silence in headless Chromium 151; the
  call asks plain `true`.
- Playwright's video has no sound; listen to the voice through the samples.

## Last exercised

2026-11-19, macOS on an M5 Pro, headless Chromium 151, fake engine, models
already on the computer. From the person stopping to the bot's first sound:
1,625 ms for a 130-character reply and 1,281 ms for a short one on the desktop
size, 1,628 and 1,481 ms on the phone size (580 ms of it is the end-of-turn
pause, about 100 ms hearing). Saying a reply only once it is in the chat costs
the reply's whole generation time; with a real model that is the model's time
to finish a short spoken answer. Kokoro speaks a short sentence in about 150 ms
and six seconds of speech in about 500 ms; Moonshine hears 3.7 s in about 70 ms.
The samples measure -16.3 to -16.8 LUFS, peaks -0.8 to -1.3 dBTP.
