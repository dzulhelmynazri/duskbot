# Admin API (v2)

The data contract for the admin panel at `/admin`, served by the account service
(`apps/dashboard/server/admin/v2.ts`). The v1 routes under `/v1/admin/*` keep
working unchanged until the panel moves to these.

## Common rules

- **Auth.** Every route needs a signed-in web session (`401 signed_out`) whose email
  is in `MADANI_ADMIN_EMAILS` (`403 not_admin`). Same cookie and CSRF rules as v1.
  All v2 routes are `GET`.
- **Errors.** Always JSON `{ "error": "<sentence for a person>", "code": "<code>" }`.

  | status | code | meaning |
  | --- | --- | --- |
  | 400 | `invalid_request` | a bad query value; `error` says which |
  | 401 | `signed_out` | no session |
  | 403 | `not_admin` | signed in, not an admin |
  | 404 | `not_found` | unknown route or person |
  | 503 | `admin_slow` | the read passed its 25 s deadline and keeps running; asking again joins it and gets its answer, so retry quietly |
  | 503 | `admin_data_unavailable` | MongoDB could not be read; the panel may retry |

  Nothing hangs: every read has a 25 s deadline, every database query a 20 s
  `maxTimeMS`. `/web` for the panel's own ranges (today, 7, 30, 90 days up to now, no
  filters, any surface) is computed ahead every 10 minutes for each reader the panel has
  seen (`admin_web_warm`), so it answers at once even after a restart; its `online`
  count is always read at the moment of the request.
- **Request headers (the panel's switches), same as v1:**
  - `x-madani-admin-data: own`: on preview, read preview's own data. Without it,
    preview's admin reads madani.bot's (`madani_prod`, read only) and every answer says
    `"data": "madani.bot"`. On madani.bot itself `data` is always `"own"`.
  - `x-madani-admin-tests: show`: include test accounts (harness `@qa.madani.test`,
    `qa*@madani.bot`, reserved `.test`/`example.*` domains, App Review's account) and
    harness installs. Hidden by default; nothing is deleted.
  - `x-madani-admin-money: test | all`: which money mode people rows count
    (default `live`). `/v2/payments` takes `?mode=` instead.
- **Caching.** Answers are kept 30 s per (path, query, switches) and identical
  reads in flight are joined, so timers and several open tabs cost one read. A
  `to` within 2 minutes of now is bucketed to 30 s for this. Any admin change
  (POST/PATCH/PUT/DELETE) clears the cache. `/v2/people/:id` is never cached
  (each view is audited).
- **Money** is integer cents, currency `USD` today (the field is always present).
  Times are ms since epoch, UTC.

## The person object

Every row that names someone carries one `person`:

```ts
interface Person {
  id: string;                 // "acct_…" | a site visitor id | "install:<id>"
  kind: "account" | "visitor" | "install";
  name: string;               // never empty, see below
  nameFrom: "account" | "provider" | "email" | "anonymous";
  email: string | null;       // accounts only
  emailKind: "email" | "apple_relay" | "none";
  providers: string[];        // accounts: ["email", "google", "apple"…]; others []
  avatarUrl: string | null;   // provider photo (Google); null => draw the pixel mascot
  avatar: string | null;      // the person's own avatar choice, if they made one
  avatarSeed: string;         // seed for the generated pixel mascot (stable per person)
  label: string;              // "account" | "deleted account" | "site visitor, not signed in"
                              // | "desktop app, not signed in" | "phone app, not signed in"
  test: boolean;              // a test account (only shown with x-madani-admin-tests: show)
}
```

Name resolution, best first: the account's own name, the sign-in provider's
display name (Google/Apple), words from the email's local part
(`pat.real-smith@…` → `Pat Real Smith`), then `Apple user (hidden email)` for an
Apple private-relay address or `Account without a name`. Anonymous people are named
for what they are: `Site visitor on mobile (ios), Pune, IN`,
`Desktop app on macOS`. Never render a bare "account" placeholder.

Every account has an email (it is the account key). People "without emails" in the
old panel were anonymous site visitors and app installs that never signed in;
they are now `kind: "visitor" | "install"` and live in their own list.

## GET /v1/admin/v2/overview

Query: `days` (1 to 400, default 30). The window is `days` whole UTC days ending today.

```ts
{
  data: "own" | "madani.bot"; now: number; days: number; from: number; range: string[]; // range: "YYYY-MM-DD" per day
  visitors: { unique: number;        // distinct site visitors in the window (database distinct count)
              perDay: number[];      // daily unique visitors (kept rollup, aligned to range)
              views: number[] };     // daily site page views
  signups: { total: number; perDay: number[] };
  accounts: { total: number; active7d: number; activated: number };  // activated: onboarding done, app paired or first bot reply in window
  anonymous: { total: number };      // visitors + installs with no account on their events in the window
  paying: { live: number; test: number };
  revenue: { live: ModeTotals; test: ModeTotals };
  waitlist: number | null;           // null when no waitlist is connected
  funnel: Array<{ id: "visited" | "signed_up" | "activated" | "paying"; label: string; count: number }>;
}
```

`anonymous.total` can include visitors who signed in later (the per-row list below
excludes them).

## GET /v1/admin/v2/people

One person = one row.

Query: `kind=accounts` (default) or `kind=anonymous`, `q` (search, up to 100
chars), `limit` (1 to 200, default 50), and the paging cursor from `next`:
`cursor` for accounts, `before` for anonymous. Anonymous also takes `days`
(1 to 400, default 30).

Accounts, newest activity first:

```ts
{
  data: string; kind: "accounts"; money: "live" | "test"; total: number; next: string | null; // pass as ?cursor=
  people: Array<{
    person: Person;
    createdAt: number; lastSeenAt: number | null;   // newest event or session
    onboarded: boolean;
    installs: number;    // app installs linked to the account
    visitors: number;    // site visitor ids linked to the account
    devices: number;     // signed-in app sessions (own data only; 0 for madani.bot read from preview)
    plan: string | null; planStatus: SubscriptionStatus | null;
    paidCents: number;   // net paid (after refunds) in the money mode
    mrrCents: number; currency: string; lastPaidAt: number | null;
  }>;
}
```

`q` matches id, name, email and provider.

Anonymous, newest first:

```ts
{
  data: string; kind: "anonymous"; total: number; next: string | null; // pass as ?before=
  people: Array<{
    person: Person; firstSeenAt: number; lastSeenAt: number; events: number;
    country: string | null; city: string | null; device: string | null; os: string | null; browser: string | null;
    platform: string | null; appVersion: string | null;   // installs
  }>;
}
```

## GET /v1/admin/v2/people/:id

`:id` is `acct_…`, a visitor id, or `install:<id>` (URL-encode the colon). Audited
as `person.view`.

```ts
{
  data: string; person: Person;
  money: { live: PersonMoneyDetail; test: PersonMoneyDetail };
  profile: unknown;   // the v1 /journeys/:id answer (timeline, sessions, first source, stats, billing card)
}
interface PersonMoneyDetail { summary: PersonMoney | null; payments: PaymentRow[]; subscriptions: SubscriptionRow[] }
```

## GET /v1/admin/v2/payments

The single source of truth for who paid what. It reads the billing records the
Dodo webhooks write, with the same totals the revenue page uses.

Query: `mode=live` (default) | `test` | `all`, `status=paid|refunded|partially_refunded|failed`,
`q` (person name, email, id, or a Dodo payment, subscription or customer id),
`limit` (1 to 200, default 50), `before` (the `next` cursor).

```ts
{
  mode: "live" | "test" | "all"; serverMode: "live" | "test"; data: string;
  totals: { live: ModeTotals; test: ModeTotals };            // always both, never mixed
  people: Array<PersonMoney & { mode: "live" | "test"; person: Person }>;      // highest net first
  subscriptions: Array<SubscriptionRow & { person: Person }>;
  payments: Array<PaymentRow & { person: Person }>;          // newest first, one page
  next: string | null;
}
interface ModeTotals {
  grossCents: number;    // before tax (the revenue page's gross)
  taxCents: number; chargedCents: number;  // charged = gross + tax
  refundsCents: number; netCents: number;  // net = after tax and refunds
  payments: number; failed: number; refunds: number; customers: number;
  activeSubscriptions: number; mrrCents: number; currency: string;
}
interface PaymentRow {
  id: string; at: number; type: "payment" | "refund";
  status: "paid" | "refunded" | "partially_refunded" | "failed";
  amountCents: number;   // charged, tax included; negative for a refund row
  taxCents: number; netCents: number; refundedCents: number; currency: string;
  plan: string | null; interval: "month" | "year" | null; mode: "live" | "test"; source: string | null;
  dodo: { paymentId: string | null; subscriptionId: string | null; customerId: string | null };
  personId: string;
}
interface SubscriptionRow {
  id: string; personId: string; plan: string; interval: "month" | "year";
  status: SubscriptionStatus; amountCents: number; mrrCents: number; currency: string;
  startedAt: number; currentPeriodEnd: number | null; mode: "live" | "test"; source: string | null;
  dodo: { paymentId: null; subscriptionId: string | null; customerId: string | null };
}
type SubscriptionStatus = "pending" | "trial" | "active" | "payment_problem" | "cancelling" | "cancelled" | "ended";
interface PersonMoney {
  personId: string; paidCents: number; refundedCents: number; netCents: number; payments: number; failed: number;
  currency: string; firstPaidAt: number | null; lastPaidAt: number | null; plan: string | null;
  status: SubscriptionStatus | null; mrrCents: number;
}
```

- **Live and test are never mixed.** A record's mode is its `mode` stamp, else the
  server's provider mode (preview: test; madani.bot read from preview: live).
- **Grants are not money.** Ops grants, admin comps and App Review's plan never
  appear in rows or totals.
- `cancelling` means active until the period ends. `trial` is reserved; no plan has
  a trial today.
- A person whose account was deleted keeps their rows, with `person.label =
  "deleted account"` and the checkout email.

## Existing endpoints the new panel keeps using

These are unchanged, now with the same cache, deadline and error codes:

- Experience, bug reports, feedback: `GET /v1/admin/experience`,
  `/experience/timeline`, `/bug-reports`, `/feedback`.
- Clouds and ops: `GET /v1/admin/clouds`, `/clouds/:id/usage`, `POST
  /clouds/:id/(pause|resume|delete|end-trial)`, `/ops`, `/ops/relays`,
  `/ops/accounts`, `/ops/sharing`, `/health`, `/incidents`, `/revenue/infra`.
- Site analytics detail: `/web`, `/web/:dimension`, `/funnel`, `/realtime` (never
  kept, only joined in flight), `/retention`, `/app`, `/product`, `/journeys`.
- Plans: `POST /v1/admin/users/:id/plan` and `/plan/preview`.

The old `/users` list reads only the service's own accounts. On preview that list
is preview's accounts while `/journeys` is madani.bot's; `/v2/people` follows the
data switch like everything else.
