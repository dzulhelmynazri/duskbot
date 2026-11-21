# Accounts across the website, desktop and phone

Run `pnpm test:accounts` (or `pnpm exec vitest run electron/accounts-e2e.test.mjs`).
With a read-only `node_modules` link, append `--configLoader native --no-cache`
to the direct Vitest command.
The eight cases use isolated temporary data folders, ephemeral loopback ports,
a memory mailer and fake Google and Apple providers. They cover website
email and provider sign-in, browser-bound pending identities, CSRF, the desktop
sign-in sheet IPC and browser approval, bearer revocation, signed automatic
workspace enrollment and ownership transfer, mobile PKCE deep links, account
gating and its escape hatches, sign-out everywhere, account deletion, and
plaintext credential exclusion from the service's saved JSON. The service clock
advances across email resend limits; desktop polling is driven explicitly.

For a manual fixture, run `node apps/dashboard/scripts/fixture.ts --port 7480`, then
`MADANI_CLOUD_ORIGIN=http://127.0.0.1:7480 pnpm dev:app` in another terminal. The
fixture prints email codes and uses fake providers. Add `MADANI_ALLOW_SIGNED_OUT=1`
to the desktop command to skip the account gate. Open the phone web preview
with `?account=1&accountOrigin=http://127.0.0.1:7480`. Stop the fixture with
Ctrl-C to remove its temporary service data. These tests exercise HTTP and
client/IPC logic; native windows, renderer interactions and live providers
remain manual checks.
