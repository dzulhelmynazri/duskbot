# The power policy: when a home stops and starts

The code is `src/power/`. Nothing in it names a provider: a provider describes itself as a `ProviderCostProfile`
(`cost.ts`), built by its adapter (`instaboxCostProfile` in `src/instabox.ts`). On InstaBox starts cost nothing and are
limited per minute, and a resume keeps memory, so the price terms below that concern paid starts are zero there; the
synthetic `pooledCostProfile` (`src/power/pooled-profile.ts`), whose starts come from a scarce priced pool, keeps those
paths exercised in the tests and the simulator.

## The cost model (`cost.ts`)

- **Compute:** cents per hour of a machine of a given size, billed per second while it runs.
- **Starts:** the account's start pool in rolling minute, hour and day windows (no reset at midnight), the price of one
  more start given how full each window is (the highest tier of the three), and the hard cap past which the provider
  refuses one.
- **The kept machine:** a resume within its window after a stop usually gets the same machine back and is no start.
- **Wake time:** how long a person waits for a cold wake and for a held one.
- **Shadow prices** for what cash does not show: an included start still spends the shared pool (its value rises to
  the first paid price as the day and hour windows fill past half), every start can fail or hydrate slowly (a risk
  premium), and a person or a connector event waiting through a cold wake is a cost.

## The decision (`policy.ts`, `decide(snapshot)`)

For an awake home the policy compares stopping now with "stay up for tau, then stop" for every tau on a grid out to a
day, and with "stay up until the next run". Each option's expected cost is the compute while awake plus, at the next
need, a start (cheaper inside the kept-machine window) and a wait (none for a run: it is pre-woken). The next need is
the earlier of the owner's next event (the predictor) and the next run (the schedule). A stop happens only when it is
the cheapest option. The answer carries both costs and the reason (`cheaper_asleep`, `likely_back_soon`,
`run_soon_cheaper_awake`, a rail's name), kept as the cloud's `stayReason` for the operator.

What this does in practice:

- A home whose routines run every 15 to 30 minutes stays up around the clock: each start would cost more than the
  compute between runs. Hourly or two-hourly routines stay up once starts are paid, and sleep between runs while the
  pool is far from full.
- A person in a session keeps the home up through the gaps their own history says they come back from; once the
  session is over (no event for 90 minutes) only their usual hours count.
- Paid starts, a filling pool and a provider near its hard cap all push toward staying up; free starts and long
  predicted gaps toward sleeping.

## The predictor (`predictor.ts`)

Per home, from its own events (sends, clicks, connector events), with counts that halve every half-life:

- **Within a session:** a histogram of the gaps between events (1 to 90 minutes) and how often a session ended.
- **New sessions:** how often one began in each UTC hour, weekdays and weekends apart (weekends lean on weekdays until
  there is evidence).
- **A new home** starts from a flat prior (three sessions a day, spread over the day).

Cheap (a few arrays on the cloud's record), deterministic, and robust to duplicates and out-of-order events.

## Routines (`schedule.ts`)

- A run keeps its exact time unless its routine allows a window (`flexMs`, reported by the home in `upcoming`); a
  flexible run can share a wake the owner already caused. Homes report the next day's runs in `upcoming`: an "around this time" routine with a 30-minute window, everything else exact, and frequent routines made since w19 only inside the person's waking hours, so the night's quiet gap shows. `nextDueAt` stays the earliest run's latest start, for an Admin that reads only that.
- A sleeping home wakes a lead before its run (the cold wake time plus a margin). An optional per-home spread exists
  (`spreadMs`); the tuned default is 0, because the planner below already spreads a crowded minute.
- **Wake batching:** one planner per service gives each pre-wake a minute, at most half the minute window's included
  starts to a minute, moving a crowded one up to 30 minutes earlier. A burst of runs at the same hour never fills the
  minute window.

## The rails (`rails.ts`): hard limits nothing bypasses

The lifecycle checks them itself before every provider start (`start()` in `lifecycle.ts`) and before acting on any
stop, whatever the policy said.

- **Never stop work:** a turn, a run, a call, a computer, maintenance (uploads, backups, installs), work that just
  ended, a wake just asked for (its delivery), a run about to start, an unknown busy code. A stop happens only after the
  home agreed in the sleep handshake.
- **Minimum uptime** after a start, and a **minimum idle** after the start or a person's last action: 15 minutes, or 30
  once they used the home in 3 separate minutes of the last hour. An open app or the dashboard on screen holds it up to 30
  minutes past the later of it opening and the last input. Work holds it (a turn, a run, a call, a computer, a sign-in, a
  transfer), and 5 more minutes once work ends. Past the rails, no hint and no cost guess keeps a home up 2 hours after
  the last input. A routine and its checks wake the home a couple of minutes before each due time, exactly on their own
  schedule. Holds that are not a bot's own work stop counting after 6 hours with no bot working, no input and no bytes
  moving; the operator gets one alert per incident.
- **Daily check:** one ops alert a day listing every cloud awake over 12 hours of a UTC day with nothing to explain it:
  work of any kind, a run or check due soon, a wake for the person's own routines and checks, or the person using it
  all count as explained.
- **No flapping:** each stop that a start followed within the flap window doubles the minimum idle for a day. The
  defaults (10 minutes, up to 2 hours, 4 starts an hour and 16 a day, 6 minutes of uptime) protect a scarce start
  pool; InstaBox homes run with `INSTABOX_RAILS` (1 minute, up to 10 minutes, 20 an hour and 96 a day, 3 minutes).
- **Per-home start budgets** per rolling hour and day. They are kept by refusing stops, never by refusing a person: a
  home that spent its budget stays up until a start ages out.
- **Restart-loop breaker:** three failed starts in 30 minutes open it; automatic starts wait (5 minutes, doubling to 2
  hours), a person may still try once per quarter of the backoff, no stop while it is open, and the operator is alerted
  (`starts_failing`).
- **The pool:** no start past the provider's hard cap in any window or before its `nextStartAt` (from a 429); no stop
  while the next start might be refused; a pre-wake that can wait is held out of a minute that would turn paid.
- **Safety net:** the provider's own auto-stop (the lease, extended only while the service runs), so a lost record
  cannot run forever.
- **Wake on intent only:** a send, a click, typing, a connector event or a routine; never opening or viewing.
- **The monthly cost ceiling:** no stop, start or other charge a home's book cannot pay for (below).

## The monthly cost ceiling (`ceiling.ts`, `src/spend.ts`, the cost rule in `rails.ts`)

No home can cost more in a calendar month (UTC) than its ceiling: the month's always-on compute times
`CEILING_FACTOR` = 1400/1314 (about 1.0654), with a month priced as at most 730 hours, prorated by the hours spent at
each size. A home is never refused because of it: when the room runs out the home simply stays awake, which can never
pass the ceiling.

| size (cents/h) | 31 days (always-on) | 30 days | 29 days | 28 days |
| --- | --- | --- | --- | --- |
| small (1.8) | **$14.00** ($13.39) | $13.81 ($12.96) | $13.35 ($12.53) | $12.89 ($12.10) |
| default (3.6) | **$28.00** ($26.78) | $27.62 ($25.92) | $26.70 ($25.06) | $25.78 ($24.19) |
| large (7.2) | **$56.00** ($53.57) | $55.23 ($51.84) | $53.39 ($50.11) | $51.55 ($48.38) |
| xlarge (20) | **$155.56** ($148.80) | $153.42 ($144.00) | $148.31 ($139.20) | $143.20 ($134.40) |

A 31-day month gets no more than 730 hours' ceiling, so the factor there is 1.0454; every other month 1.0654.

### What is counted

Everything the home costs, each priced at the worst it could have been:

- **Compute:** the home's rate for every second a machine of it may be billed: from the moment a start is asked for
  until the provider is seen to report it stopped (or, for a lost machine, confirmed gone: 404s over 30 minutes and
  absent from the list). A failed start's machine, a hung stop and a lost machine's last minutes all count.
- **Starts:** every start or create attempt is charged at the worst price (W = $0.07, the top extra tier, one short of
  the hard cap) *before* the provider is asked. Once it ran, the pool ledger (`starts.ts`) proves its price and the
  difference is given back (an included start costs 0). A held-machine resume is priced as a start: the provider does
  not confirm reuse. A start the provider refused outright (a 429, busy, a 4xx) is voided; anything else (a 5xx, a
  timeout) stays charged at W.
- **Backup storage:** the bytes kept, per GB-month (R2's $0.015), for the rest of the month as soon as they are written.
- **A second machine:** a machine a recovery replaced that is found running is charged its compute for the whole lease
  (2 h), paused and alerted.

### The book and its slack

Per home and month, with `r` its rate now, `r_min` the cheapest size's rate (1.8), `f` the month's factor and `rest` the
hours left: `ceiling_past` is the ceiling accrued so far at the real sizes, `spent` all of the above so far, `sigma` the
storage rate now.

    slack = ceiling_past - spent + rest * ((f - 1) * r_min - sigma)

This is the ceiling (the month ahead counted only at the cheapest size's margin) minus what is spent and what staying up
all month at any size and keeping today's backups would still cost. Facts:

1. **Time never lowers it.** d(slack)/dt = r*f - [up]*r - (f-1)*r_min >= (f-1)*(r - r_min) >= 0, and while stopped it
   grows by r*f - (f-1)*r_min per hour (about $0.018 an hour on small). Storage cancels: it was already committed.
2. **A resize never moves it**: the formula has no `r` in it. That is why the future is counted at `r_min`: a home that
   drops from xlarge to small mid-month cannot find its ceiling shrunk under what it already spent.
3. **Only charges lower it**: a start, more storage, a second machine. Every one is admitted by the rails only when
   `slack - charge >= 0` (below, with room to spare), and is logged before the provider is asked.
4. **At the month's end** `rest = 0`, so `spent = ceiling_past - slack <= ceiling_past`, the month's ceiling.

So spend <= ceiling on every path: whatever the policy, the provider or the clock does, the only things that spend are
charges, and no charge is made that the slack cannot pay.

### The rule (`costStopRefusal`, `costStartRefusal`, `costChargeRefusal` in `rails.ts`)

With N = 5 reserve starts (the breaker's 3 failures, a probe, one lost-machine rebuild), k = starts this month that no
stop of ours paid for, and `reserve = W * max(0, N - k)`:

- **A stop** (the policy's) needs `k < N` and `slack >= reserve + W`: the start that ends the sleep is paid for and the
  reserve is whole. Past N such starts in a month the home is not stopped again that month (`cost_reserve_used`).
  An owner's stop needs `slack >= W`. A plan's end, a suspension or a hold stop without asking: a stop never costs.
- **A start we choose** (a routine's pre-wake) needs `slack - W >= reserve`.
- **A start somebody waits for** (a wake, a create, a rebuild, a resize) needs only `slack >= W`.
- **Any other charge X** (a backup's storage, a second machine's compute) needs `slack - X >= reserve + W`; a backup that
  would not fit is skipped (`backup_skipped`, `cost_ceiling` in the audit) and the operator alerted.

A refused start is tried again when the slack will have grown enough (`recheckAt`); a refused stop leaves the home up.

**Why a person is not refused.** Let `phi = slack - reserve`. A stop leaves `phi >= W`; the start that ends that sleep
uses the prepaid W (`phi >= 0`); a start nobody paid for spends W of slack but also W of reserve (`phi` unchanged);
other charges keep `phi >= W`; time only raises it. So while `k < N`, `slack >= reserve + phi >= W` at every wake. A
person's wake is held for cost only once the provider has caused N or more unchosen starts this month, or when the
month opened with less than the reserve (backups above about 12 GB on small in a 31-day month: `60.8 cents - storage`
must cover 6 starts). Then the wake waits for the slack to grow (at most W / $0.018 an hour, about 3.9 h on small and
21 minutes on xlarge, since a stopped home gains its compute), and the operator is alerted.

**The provider-caused paths, bounded.** Lost-machine rebuilds, provider stops, failed starts and retries are all starts
nobody chose: each needs `slack >= W`, so together they can spend at most the slack. There is no separate count to trust:
past the reserve the home stays up for the month and every further rebuild waits for slack the lost machine earns while
it is gone.

Month-start room per home, before storage: 60.8 cents in a 31-day month, 79.2 to 84.8 in the others, so a stop needs 42
cents of it at first. The bigger sizes earn more as they sleep (xlarge: $0.20 an hour).

### The ledger (`src/spend.ts`)

Append-only JSON lines, `spend/<YYYY-MM>.jsonl`, provider-neutral (cents and rates only): `open` (a book's starting
state), `start`, `settle`, `up`, `down`, `stop`, `rate`, `bytes`, `extra`. Each line is synced to disk before the provider
is asked for what it records, so a crash can only over-count. On start the newest two months in the log are replayed
through the same functions the live path uses; a torn last line (a write that never finished) is skipped and reported.
A book carried into a new month writes its state as of the month's first moment, so each month replays on its own. A
home with no book yet opens one; if it already existed, what it spent before this month's book is priced as always-on.

**Clocks.** The ledger's time never goes back, and while the process runs it follows a monotonic clock whenever the wall
clock disagrees by more than 2 seconds, so a jump either way is not taken as time passing. At boot it trusts the wall
clock (never behind the last line). Assumptions: the wall clock is right at boot; the provider bills only machines it
reports running; one deployment per provider workspace (the pool ledger's price proof).

## The ledger (`src/starts.ts`)

Every start in rolling windows (`provider-starts.json`, v2), a day-by-day summary for the next-plan decision, the
operator's alerts as the rolling day passes 70%, 100%, 150%, 200% and 500% of the included starts, and the provider's
"not before" time after a refusal.

## Configuration

- `MADANI_MANAGED_PROVIDER_PLAN` (`pro`, `builder`, `team`; default `pro`): the starts a minute the policy plans for
  (30, 50, 100).
- `MADANI_MANAGED_IDLE_MINUTES` (default 15): the rails' minimum idle.
- `MADANI_MANAGED_WAKE_LEAD_MINUTES` (default 2): how long before a run its home wakes.

## The cost study

`scripts/lifecycle-sim.ts` simulates fleets on InstaBox's prices (personas, mixed fleets by size, faults; `--host pooled`
runs the same study on the synthetic pooled provider for comparison),
tunes the policy's settings by coordinate descent and writes the report. It drives this exact `decide()`/`wake()` and
rails. The fuzz tests (`src/power/fuzz.test.ts`) use the same simulator. Each simulated home keeps its monthly book (6 GB of
backups charged to it) and the report shows each policy's worst calendar month as a share of the ceiling; with the
ceiling in place every persona costs the same to the cent as before it, and the worst month any adaptive home reached is
96.3% (the monitor-heavy persona, up all month). `src/power/ceiling.fuzz.test.ts` runs 600 month-long fault streams
against the ledger and the rule, and 12 fleets through the simulator.
