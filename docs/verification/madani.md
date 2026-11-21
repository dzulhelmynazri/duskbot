# Madani, everyone's helper

Madani is the bot every place and every Team Cloud member gets once: a new
install's first bot and its Chief of Staff, or, for an install that already has
bots, a helper beside them. It is never deleted or archived; the person takes it
off the sidebar with "Show Madani in the sidebar" in Settings → General, which
its menu's **Hide from sidebar** also turns off.

## Automated checks

```sh
pnpm exec vitest run server/default-bot.test.ts server/default-bot.e2e.test.ts \
  server/team-setup-requests.test.ts src/lib/default-bot.test.ts \
  src/lib/madani-landing.test.ts
```

- `server/default-bot.test.ts`: a fresh install gets one Madani once; an
  existing install gets one once on update and its Chief is untouched; a new
  install's renamed Madani is adopted, not duplicated; the intro shows once,
  not after it was answered or dismissed; delete and archive are refused; a
  move to My Cloud and coming home leave exactly one; each Team Cloud member
  gets their own; a Team User's Madani holds no Chief tools.
- `server/default-bot.e2e.test.ts`: on a real fixture server, `DELETE
  /api/bots/:id` answers 409, the switch hides and shows it, and a Madani that
  is not the Chief creates a bot with `create_bot`.
- `server/madani-notifications.test.ts`, `server/drivers/agents-madani-tools.test.ts`
  and the second case of `server/default-bot.e2e.test.ts`: Madani alone gets
  `list_unread_notifications` and `mark_notifications_read`, listed last.
  The list returns the unread feed (bounded, trimmed) with a lean per item;
  marking read takes only finished work (`done`, `delegation-settled`), leaves
  questions, approvals, failures, deferred runs (`routine-deferred`, which the
  app routes as an ask), sign-ins, money, mentions and unrecognised kinds
  unread, has no mark-all, and says what it marked and what it left. A `done`
  item is the bot's final reply and may end in a question: the list's text says
  such an item is the person's, to be marked read only if they said so.
  Personal installs only (refused on any team server); no other bot may call
  them. The list is annotated read-only like the other reviewed reads.
  `server/drivers/agents-catalog-wire.test.ts` budgets the `+madani` profiles,
  each within 2% of the same Chief's list without them.
- `server/team-setup-requests.test.ts` ("Madani's Chief-level team setup"):
  it adds specialists like a Chief but never changes who the Chief is.
- `src/lib/default-bot.test.ts`: a renamed Madani is found by its mark,
  visibility follows the saved switch, and the viewer gets their own helper.
  Current first-run UI is covered by `src/components/onboarding/WelcomeFlow.test.ts`,
  not the removed Meet Madani popup.
- `src/lib/madani-landing.test.ts`: the rows already in the sidebar glide down
  by the new row's height, the avatar lands in the new slot and leaves nothing
  behind, reduced motion only fades the row in, and a hidden sidebar just adds it.
- `server/default-bot.test.ts` also: a place with no Chief gets Madani as its
  Chief; a place with a Chief keeps it. Either way the daily brief comes from
  Madani, hidden from the sidebar or not, and its intro says so. How the watch
  moves to Madani is in [Proactive routines and the brief](proactive-routines.md).

## By hand

Launch the app against an isolated fixture (`docs/verification/README.md`),
finish the first-run welcome, then:

1. Follow the current [welcome flow](onboarding.md) in a fresh fixture.
   It should finish in Madani's chat; the retired Meet Madani popup is absent.
2. Madani's first message says what it does in the app's language, with
   example asks and, on a new install, only the setup steps still to do. Each
   step opens the app's own flow.
3. Its sidebar menu offers **Hide from sidebar**, not Archive or Delete; the
   switch in Settings → General brings it back.

