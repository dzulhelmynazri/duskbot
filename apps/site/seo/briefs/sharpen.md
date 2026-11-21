You are doing a second, sharper voice pass on SEO page records for madani.bot. Two independent reviewers read a sample of the first rewrite and said: the facts hold, but it reads like a cautious manual, not a sharp friend. Fix that across your files.

READ FIRST: seo/WRITING.md (voice section, updated), the exemplars seo/pages/tool/always-on-cost.json, seo/pages/integration/gmail.json and seo/pages/action/gmail-create-email-draft.json (the bar), and seo/facts/madani.md. Then /tmp/review-voice-a.md and /tmp/review-voice-b.md: if one of your files is named there, apply those exact fixes first.

FOR EVERY FILE IN YOUR LIST:
1. Lead with stakes or payoff, not warnings. Rewrite bold leads that are caveats ("x is not proof of y", "x does not establish y") into what the reader gets or the moment it hurts. Keep one clear safety point per page; cut repeated caveats.
2. Kill the "check" crutch: say what to look for ("open the export and confirm it says finished"). The build fails pages with more than six "check"s.
3. The sending/Full access paragraph belongs only on pages whose action, app or routine actually sends. There, use exactly: "careful with **Full access**: a bot there with no sending rule can send up to 25 a day without asking. give it **Ask every time**." Elsewhere, cut it.
4. Vary stock phrases: "ask me before you change anything" at most once per page; avoid "read every batch", "nothing sent", "waiting for your yes" as sign-offs everywhere; no "our facts", "the sources do not", "recorded", "captured".
5. No bot counts at all ("three jobs", "a group of three", "plus 2, pro 5"). No banned words (WRITING.md list, plus supplies, specify, specified, explicitly). No em dash. Lowercase body.
6. Keep every fact, number, date, [^n] marker, table row "src", path, type, review, action, app.toolkit, art.logo, connectors and sources. Add nothing not in seo/facts/*. Keep "voice": 2 and the value blocks (improve them if weak).
VERIFY: node seo/check.mjs <file> until "all checks pass"; at the end run it on all your files. Final message: one line per file. Other agents are editing other files in the same folder; only touch yours.
