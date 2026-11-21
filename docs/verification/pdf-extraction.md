# PDF extraction and library files

Run against disposable homes and loopback providers:

```sh
pnpm exec vitest run server/pdf-text.test.ts server/pdf-extract.e2e.test.ts server/routes/helper-tools.test.ts server/library-turn-paths.e2e.test.ts server/skills-library-api.test.ts server/skills-library.test.ts server/bot-box/box.test.ts
pnpm exec vitest run server/drivers/claude.test.ts -t 'assigned read-only skill mounts'
pnpm exec vitest run server/drivers/acp/shared-process.test.ts
node scripts/bundle-server.mjs
node scripts/smoke-packaged-server.mjs
```

The supported agents `extract` tool reads an uploaded PDF referenced by the
current conversation or a PDF in the bot's working folder. It converts the
text layer locally with bundled PDF.js, then sends that text to the configured
extraction model. No Poppler, external command, native canvas package or extra
installation is required. Typed extraction still needs the existing Decision
and extraction setup; fixtures use a synthetic loopback model and never call
a real provider.

The HTTP fixture uploads a genuine two-page PDF, invokes that supported tool
with a real turn capability, and checks both pages and Unicode in the model's
input. It also rejects an unreferenced upload, a file outside the bot's folders
and an expired capability. Parser checks cover a password-protected file,
corrupt input, a document without readable text, Chinese character maps,
oversized input/output, page limits, cancellation and the worker deadline.
Scanned documents need page images; this does not provide OCR.

The parser starts only when called, in a dedicated worker: at most two jobs,
25 MiB input, 500 pages, 256 KiB decoded text, a ten-second deadline and V8 heap
limits of 128 MiB old generation plus 16 MiB young generation. The helper's
normal text/schema/body limits still apply: text past 200,000 characters or the
256 KB request body is cut, and the tool's answer tells the model only the
start was read. A PDF whose decoded text passes 256 KiB is refused, since its
parser stops there. Cancellation terminates the worker before its slot is
released.

The packaged smoke copies the built server outside the repository, with no
`node_modules` reachable. Its real worker reads both PDF pages and a separate
Chinese-font document using shipped character maps and fonts. PDF.js and its
license ship in the server resources; its parser is absent from the main
server startup bundle.

On macOS, repeat the packaged smoke with `MADANI_SMOKE_PDF_RUNTIME` set to the
installed Electron executable. Only its PDF probes use that executable, with
`ELECTRON_RUN_AS_NODE=1`; no desktop window or user profile opens. This passed
with Electron 43.7.9 as well as Node 26, using the copied server resources with
no reachable `node_modules`. The desktop packaging policy puts the entire
`dist-server` tree in `extraResources/server`, outside the app's asar.

The library fixture creates a learned shared skill through bot tools, reads
the exact path delivered to a teammate, updates it, rejects an old revision,
and checks the next turn reads the updated file. Existing organization tests
cover installing and updating packages. Exact per-conversation read-only mount
tests exclude unassigned siblings and server settings, respect disabled or
tampered skills and private shadows, and remove revoked assignments. A real
fake-engine process restarts when its mount set changes, keeping the warm
process when it does not. ACP process sharing also separates different
read-only grants and restarts a persistent thread when they change.

Native Linux bubblewrap execution remains unverified on this macOS host:
the disposable Docker probe refused an unprivileged nested user namespace
(`unshare: Operation not permitted`). No privileged container, host home,
live VPS, real account or user document was used.
