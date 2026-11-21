---
title: files and apps
description: give a bot files to work with, find what it made, and plug it into gmail, slack, notion and 60+ other apps.
section: using
order: 6
art: s-plug
---

a bot works best with the real thing in front of it: the actual pdf, the actual inbox, the actual repo.

## send it files

drop a file onto the chat, or use **Attach files**. documents, spreadsheets, pictures and screenshots all work.

## what it makes

reports, spreadsheets and code show up in the chat, and you open them from there. on your computer they live in the bot's own folder (you can also give it a project folder). on [madani cloud](/docs/madani-cloud#files) a copy comes down to `Documents/Madani Bot`.

## connected apps

connect an app once and a bot can work inside it.

1. open **Connected apps** in the sidebar.
2. pick the app and sign in on its own page, so your password goes to them, never to a bot.
3. choose which bots may use it, and whether each may only read or may also change things. your bookkeeper doesn't need your slack.

<p class="chips">{{chips gmail calendar drive docs sheets slack notion github linear figma stripe discord hubspot airtable asana trello dropbox outlook shopify sentry vercel supabase posthog zapier}}</p>

then just ask:

- "what's on my calendar tomorrow, and is there time for lunch?"
- "find the latest invoice from acme in my email and file it in drive."
- "open an issue in linear for the checkout bug and assign it to me."

each app has its own page in [integrations](/integrations): what a bot can do there, what it asks first, and routines to copy.

reading and drafting happen freely. sending (emails, messages, posts, payments) asks you first, unless you set a daily amount it may send on its own.

## something not on the list?

if a tool offers an mcp server, add it under **plugins**, **MCP servers**: paste whatever the tool gave you and the app works out the rest. only add servers you trust.
