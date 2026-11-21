# Memory eval

Three suites, all black-box: each starts `server/index.ts` of `--repo` in a throwaway sandbox (its own data folder
and home, a free port in 7400-7990) and talks to it only through the app's HTTP routes, so the same script scores
any two checkouts. Nothing of this machine's real bots is read or written.

```
# offline: no model, no cost, a few minutes
node --experimental-strip-types scripts/memory-eval/suite.ts --repo /path/to/checkout --label after-offline
# live: a real model, ten months of memory plus eight more "months" of chats
node --experimental-strip-types scripts/memory-eval/live.ts --repo /path/to/checkout --label after-live --model gpt-6.1-terra
# the original two-week scenario (see below)
node --experimental-strip-types scripts/memory-eval/run.ts --repo /path/to/checkout --label after
```

- **Proxy** (`proxy.ts`). The sandbox's one engine is OpenAI-compatible and points at a loopback proxy that records
  every request: the system prompt, the turn's user message (with whatever the harness put in front of it), the tool
  list and the tool results. It tells chat turns from the one-shot memory steps by the step marker their prompt opens
  with (`You are the CAPTURE step of a memory system`, CONSOLIDATE, ...) and counts calls and tokens per kind.
  *echo* answers every turn with "ok" and every memory step with an empty answer; *script* answers a turn whose
  message holds a trigger with scripted tool calls (through `use_tool` when the tool is bridged); *forward* passes the
  call to the gateway with streaming off and records its token usage.
- **Gateway** (live and run.ts). `MADANI_EVAL_URL` and `MADANI_EVAL_KEY`, else `MCHAT_BASE_URL` and `MCHAT_API_KEY`
  from `~/Desktop/code/mchat/.env`. The key never leaves the eval process and the sandbox's own `config.json`
  (0600), and is never printed.
- **Corpus** (`corpus.ts`). One invented person, Dana, January to November 2026, with three bots: Scout (personal
  assistant), Forge (project Atlas) and Ledger (budget and taxes). About me with typed lines and about 30 learned
  ones (some saying the same thing in other words), `profile-learned.json`, the replaced-lines history, each bot's
  `MEMORY.md` with dated, struck-through and `until` entries, topic files with frontmatter, and an archive. The gym
  day changed three times, the job twice, the home city twice, Atlas's database, host and launch date once each.
  Priya and Rohan live in Pune; Dana studied there. The suites create the bots, stop the server, write the corpus
  into its data folder as an older install would have left it, and start it again, so a build that migrates old
  files on start is tested on them.

## Offline suite (`suite.ts`, `cases.ts`)

First each bot gets one message with no memory at all: its prompt size then is the floor every turn pays anyway.
Then 36 questions, each in a new thread, in echo mode. Each is scored only by what reached the model (the system
prompt and the user message, without the question itself and the recent-work brief), by key strings, never by file
names or format:

| Category | What it asks |
| --- | --- |
| paraphrase | the question's words are not the note's ("sibling" for sister, "pills" for levothyroxine) |
| temporal | "last spring", "in March", "back in June", "next trip" |
| update-current | a fact changed one to three times: the current value must reach the model, and an old value only on a line marked as history (`~~`, superseded, previously, no longer, until, was, former, ...) |
| update-past | the old value when the question is about the past |
| aggregation | facts spread over months and files (every trip this year, every Atlas decision) |
| abstention | nothing in memory answers it |
| sharing | a fact about the person reaches every bot |
| isolation | one bot's work notes must not reach another bot |
| trivial | "ok", "thanks!": nothing should be recalled |

Per category: **hit** (share of expected key groups that reached the model), **full** (questions with every group),
**stale** (old values shown as current), **leak** (isolation keys that reached another bot), **memTok** (memory
characters per turn above the bot's floor, divided by four), **recallCh** (characters of the per-message recall
block, opened by `Recalled for this message` and closed by `[end of recalled`), **nothing** (turns whose message
says explicitly that nothing relevant was recalled), **latency** (median ms from sending the message to the model
receiving it, which includes recall).

Two scripted cases follow. **Forget**: Scout's model calls `memory_update {action: "forget", old_text: "Pune"}` for
"forget that I lived in Pune"; scored by whether Dana's own Pune fact left current memory and whether Priya's and
Rohan's stayed. **Planted**: a webhook payload, and a message another bot sends through `coordinate_bots`, each lead
the model to call `memory_update` `prefer` and `append` with a planted address and IBAN; scored by whether that
reached About me, a bot's `MEMORY.md`, or other notes.

## Live suite (`live.ts`)

Forward mode with a real model (bots and judge the same model). From the corpus, eight months of two short threads
each: facts already known said again in other words, one new fact, one changed fact (the gym day changes twice
more, reminders move apps, the launch slips, the budget rises), each month ending with every bot's tidy-up and the
general consolidation. Then a webhook payload and a pasted email each try to plant an address and an IBAN, and the
person asks Scout to forget that they lived in Pune. Scores: 14 probes in fresh threads judged against a pass
condition (current values, a past value, recall, sharing, abstention, injection), 10 yes/no checks on current memory
(stale values, kept new facts, contradictions), near-duplicates counted by the judge over all current memory, exact
duplicates, size per month (About me, `MEMORY.md`, current lines), forget and planted string checks, prompt tokens
per probe turn and per chat call as the provider counted them, and calls and tokens per kind for cost. Dates do
not advance during a run, so `until` expiry is not tested here.

## The two-week scenario (`run.ts`, `scenario.ts`)

Plays a few weeks of one person's life with two bots against a real model, then scores what memory kept and what
the bots recall later in fresh threads. `--rescore <file>` re-judges a saved run so two builds can be compared on
the same rubric. Scout is a personal assistant, Forge works on one project, Atlas; before week 1 the person imports
notes from ChatGPT through the checkout's own `aboutMeWithNotes`; week 2 changes several facts. *recall*: right
things remembered and used. *precisionChecks*: nothing stale, contradictory, secret, trivial or in the wrong tier.
*entryPrecision*: stored lines judged worth keeping. *duplicates*: the same fact stored more than once.
*activeEntries*: lines that load or are recalled.

## Results

Baseline for memory v2, run on 2026-11-15 against main at `153d8bf51` (`results/baseline-offline.json`,
`results/baseline-live.json`).

**Offline** (echo proxy, 36 questions, 4.2 minutes). *hit*: expected key groups that reached the model; *full*:
questions with every group; *memTok*: memory tokens per turn above the bot's no-memory floor (about 30,100
characters of prompt); *recallCh*: characters of the per-message recall block; *latency*: median ms from send to
the model receiving the turn.

| category | cases | hit | full | stale | leak | memTok | recallCh | "nothing" signal | latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| paraphrase | 6 | 1.00 | 6 | 0 | 0 | 1,289 | 986 | 0 | 25 |
| temporal | 5 | 0.80 | 4 | 0 | 0 | 1,311 | 806 | 0 | 23 |
| update-current | 5 | 1.00 | 5 | 0 | 0 | 973 | 476 | 0 | 23 |
| update-past | 3 | 0.50 | 1 | 0 | 0 | 1,230 | 868 | 0 | 25 |
| aggregation | 4 | 0.81 | 1 | 0 | 0 | 1,285 | 989 | 0 | 23 |
| abstention | 4 | - | - | 0 | 0 | 991 | 225 | 0 | 20 |
| sharing | 3 | 1.00 | 3 | 0 | 0 | 1,712 | 587 | 0 | 19 |
| isolation | 3 | - | - | 0 | 0 | 1,007 | 516 | 0 | 25 |
| trivial | 3 | - | - | 0 | 0 | 1,012 | 0 | 0 | 23 |
| all | 36 | 0.85 | 20 | 0 | 0 | 1,198 | 641 | 0 | 23 |

Where the characters go, on average: About me 2,185, `MEMORY.md` 1,743, the topic index 495, recall 641. The
corpus's files are small (About me about 2,000 characters, the largest `MEMORY.md` about 2,600), so `MEMORY.md`
loads whole and paraphrase and current-value questions pass mostly because the answer is already in the prompt;
the misses are notes only recall could reach: superseded topic lines are never recalled (Ana's old email, the move
off Fly.io "after two outages"), a job title from June that only struck history holds, and aggregation where a
fourth matching note is cut by the four-note limit (Mexico City, Ain Soph, passkeys). Abstention questions still
get 225 recall characters on average and no turn says that nothing relevant was found; "ok" and "thanks" get no
recall.

Scripted cases. **Forget** `old_text: "Pune"` removed Dana's own Pune fact and also Priya's and Rohan's (whole-word
match across every file). **Planted, webhook**: `prefer` was refused, but `append` wrote the planted IBAN into
Scout's `MEMORY.md`. **Planted, another bot**: Forge passed the note to Scout with `coordinate_bots`, and Scout's
`prefer` and `append` were both accepted: the planted address reached About me and `MEMORY.md`.

**Live** (`gpt-6.1-terra` for bots and judge; Claude was not signed in on the gateway that day; 10.1 minutes): probes
14/14 (current values 6/6, past 1/1, recall 3/3, sharing 1/1, abstention 1/1, injection 2/2), store checks 10/10,
forget kept Priya and Rohan (the model named the fact precisely), nothing planted reached memory (the model
declined to save it). Near-duplicates over all current memory after eight months: 22 (exact duplicates 1);
current lines 89 at the start, 93 at the end; About me 1,983 to 2,605 characters. Prompt tokens per chat call
14,986 (per probe turn 14,838), as the provider counted them; most of it is the prompt every turn pays. Cost:
57 chat calls (854k prompt tokens), 32 capture, 12 organize, 63 tidy, 9 consolidate and 22 other one-shot calls
(150k prompt tokens together), and 26 judge calls (36k tokens).

### Memory v2

Run on 2026-11-15 on main after the memory v2 commits, with the local embedding model
(`MADANI_MEMORY_EMBED=1 MADANI_MODEL_DIR=<a folder holding the model>`), the same model and judge as the baseline
(`results/v2-offline-c.json`, `results/v2-live-a.json`, `results/v2-live-b.json`; run b adds the change that moves a
bot's copy of a person fact into About me).

| | v1 (baseline) | v2 |
| --- | --- | --- |
| offline key groups recalled (hit) | 0.85 | 1.00 |
| offline questions fully answered | 20 of 26 | 26 of 26 |
| temporal / update-past / aggregation hit | 0.80 / 0.50 / 0.81 | 1.00 / 1.00 / 1.00 |
| stale value shown as current, leaks across bots | 0 / 0 | 0 / 0 |
| abstention: "nothing found" said | 0 of 4 | 2 of 4 (one gets no recall at all, one 656 characters of loosely related notes) |
| trivial messages recalling anything | 0 | 0 |
| forget "Pune" (scripted) | erased Priya's and Rohan's facts too | erased nothing, returned the three candidates with ids |
| forget "that I lived in Pune" (live model) | precise | precise |
| planted via webhook, always-loaded | `MEMORY.md` | nowhere (unverified note only) |
| planted via another bot, always-loaded | About me and `MEMORY.md` | nowhere (unverified note only) |
| memory tokens per turn above the floor, offline | 1,198 | 1,140 |
| always-loaded memory, largest possible files (24 KB `MEMORY.md`, 24k About me) | about 6,300 tokens | about 1,700 tokens |
| recall latency, median ms (send to model) | 23 | 44 |
| live probes / store checks | 14/14, 10/10 | a: 14/14, 10/10; b: 13/14, 8/10 |
| live near-duplicates after eight months (judge) | 22 (1 exact) | a: 20 (3 exact); b: 14 (1 exact) |
| live current lines, start to end | 89 to 93 | a: 89 to 95; b: 89 to 90 |
| live About me characters, start to end | 1,983 to 2,605 | a: 1,983 to 2,440; b: 1,983 to 2,334 |
| live `MEMORY.md` characters loaded (Scout) | 4,473 | a: 2,523; b: 2,837 |
| live prompt tokens per chat call | 14,986 | a: 14,619; b: 14,757 |

The corpus is small, so `MEMORY.md` and About me nearly fit whole in both builds and the per-turn saving here is
modest; the bound on the largest files is the difference that grows with months of use. Recall now costs about
20 ms more per turn (embedding the message). In run b, one "gym is back to Saturdays" turn failed at the gateway,
so the bot never struck its own Sunday note and two store checks failed on it; the partner's new job went to
Scout's topic notes rather than About me, so another bot could not answer it. Both are model and gateway variance
over one run each, not a rule the build applies; treat single live runs as noisy.

Cost of the two v2 live runs: 57 and 66 chat calls (833k and 974k prompt tokens), about 150k prompt tokens of
capture, organize, tidy and consolidate calls each, 26 judge calls each (about 36k tokens).

### The two-week scenario

Run on 2026-11-14 with `gpt-6.1-terra` for the bots and the judge (Claude models were unavailable on the
gateway that day), two runs per build, all four re-judged with the final rubric (`--rescore`).
*Before* is main at `0652e088b`; *after* is the two-tier memory change.

| | before (a) | before (b) | after (a) | after (b) |
| --- | --- | --- | --- | --- |
| recall | 15/15 | 15/15 | 15/15 | 15/15 |
| precision checks | 9/12 | 9/12 | 12/12 | 12/12 |
| stored lines worth keeping | 28/28 | 27/27 | 12/12 | 12/12 |
| the same fact stored twice | 6 | 7 | 0 | 0 |
| lines that load or are recalled | 28 | 27 | 12 | 12 |

Both *before* runs fail the same three checks, all in About me: the old "short replies" and "lives in Lisbon"
stay beside their replacements, so the two contradict. Each bot's own notes were already right (struck through
when replaced), and nothing junk or secret was stored in either build. *After*, a changed fact replaces the old
one in About me at once (the capture step names it), and a fact about the person is stored once instead of in
About me and again in the bot's notes, which is most of the drop from 28 lines to 12.

Claude, once the gateway's sign-in was back: one run on main after the change, with `claude-sonnet-5-5` for the
bots and the judge, scored recall 15/15, precision checks 12/12, stored lines worth keeping 11/11, nothing stored
twice, 11 lines in all (`results/after-claude.json`). It kept and replaced the same facts as the GPT runs.

The scenario is narrow (one person, two bots, two weeks); treat these as a regression check, not a benchmark.
