<div align="center">

<h1>madani bot</h1>

<p><b>The free Grok bot alternative that runs on your own models.</b><br><br>
Use the ChatGPT, Claude or Grok subscription you already pay for,<br>
and get a team of bots, each with its own memory and computer.</p>

<p>
<a href="https://madani.bot/download"><b>Download for Mac, Windows and Linux</b></a> &nbsp;·&nbsp;
<a href="https://madani.bot">madani.bot</a> &nbsp;·&nbsp;
<a href="https://madani.bot/docs">Docs</a>
</p>

<sub>v0.2.13 · free forever for personal use · source available</sub>

</div>

<br>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/readme/app-dark.webp"><img src="docs/readme/app-light.webp" alt="The madani bot app: Madani, Nova, Echo and Quill in the sidebar, and Nova's chat with a three-day Lisbon plan in a table" width="100%"></picture>

## What it is

madani bot is a desktop app where your AI helpers live as contacts. Make a bot, give it a job in plain words, and text it like you would a friend. It does the work on a computer of its own, keeps notes on how you like things done, and stops to ask when something needs a person.

It runs on the AI you already pay for, with your own sign-in. Bots, chats and files stay on your machine, or on a server you choose.

<p align="center"><img src="docs/readme/shots/work.gif" alt="Nova gets a question about mug prices; its computer, open on the right, searches Bing, reads East Fork and Mud Australia, then Nova saves a CSV and answers" width="100%"><br><sub>A bot at work: it searches and reads real shop pages on its own computer (right), then answers.</sub></p>

## Contents

- [What bots can do](#what-bots-can-do)
- **Tour:** [Chat and rooms](#chat-and-rooms) · [The bot panel](#the-bot-panel) · [A computer of its own](#a-computer-of-its-own) · [Routines](#routines) · [Apps and AI](#apps-and-ai) · [Vault and moving in](#vault-and-moving-in) · [First run and your account](#first-run-and-your-account)
- [Where bots live](#where-bots-live) · [Install](#install) · [How it fits together](#how-it-fits-together)
- **Reference:** [Your data](#where-your-data-lives) · [Security](#security) · [Self-hosting](#self-hosting) · [Configuration](#configuration) · [Run from source](#run-from-source) · [FAQ](#faq)

## What bots can do

| | |
| --- | --- |
| **Work on their own computer** | A browser and a desktop per bot. Watch it live, take the mouse for a sign-in or a captcha, hand it back. |
| **Run on a schedule** | Ask once and it becomes a routine: every weekday at 8, every two hours, or the moment an app event or webhook arrives. |
| **Ask before the risky stuff** | Real questions and risky steps come to you as a card you answer in one tap. You pick how much each bot may do alone. |
| **Remember you** | Every bot keeps notes on how you like things and who's who. Every note is yours to read and edit. |
| **Work together** | Put bots in a room and they hand work to each other. You step in when one needs a yes. |
| **Use your apps** | GitHub, Notion, Linear, Stripe and more in one click on your own account, hundreds more through Composio, and any MCP server. |
| **Keep secrets** | Save a login once. A bot signs in with it but never sees it. 1Password works too. |
| **Move in** | Bring bots from OpenClaw, Hermes Agent and Grok bot, or from ChatGPT and Claude with one prompt. |
| **Live in your notch** | On a Mac, your bots sit in the notch: who is working, and what needs you. |

## Chat and rooms

Every bot is a chat. Bots answer with tables, code and files, ask with cards you answer in a tap, and several bots can share a room.

<table>
<tr>
<td width="50%"><img src="docs/readme/shots/chat-quill.webp" alt="Quill drafts the newsletter and asks which subject line to use, with three choices"></td>
<td width="50%"><img src="docs/readme/shots/chat-echo.webp" alt="Echo sorts the inbox into a table by priority"></td>
</tr>
<tr>
<td><sub><b>Questions as cards.</b> Quill asks which subject line to send.</sub></td>
<td><sub><b>Real answers.</b> Echo sorts the inbox into a table.</sub></td>
</tr>
<tr>
<td><img src="docs/readme/shots/chat-room.webp" alt="The Shop standup room: Nova, Quill, Rivet and Echo each report in"></td>
<td><img src="docs/readme/shots/panel-overview.webp" alt="Nova's chat with the bot panel open on the right: routines, model and usage"></td>
</tr>
<tr>
<td><sub><b>Rooms.</b> Four bots report in one thread.</sub></td>
<td><sub><b>The bot panel.</b> Routines, model and usage.</sub></td>
</tr>
</table>

## The bot panel

Each bot has its own settings: what it remembers, how much it may do alone, its instructions, skills, voice and model.

<table>
<tr>
<td width="50%"><img src="docs/readme/shots/panel-memory.webp" alt="What Nova remembers: memory on, three notes"></td>
<td width="50%"><img src="docs/readme/shots/panel-permissions.webp" alt="Nova's permissions: approval level and sending on your behalf"></td>
</tr>
<tr>
<td><sub><b>Memory.</b> Notes you can read and edit.</sub></td>
<td><sub><b>Permissions.</b> From ask first to full access.</sub></td>
</tr>
</table>

## A computer of its own

Every bot has a browser it can read and drive. For anything without an API it gets a full desktop: a cloud desktop on madani cloud, a private container per bot on your server, a Linux VM in Docker on this computer, or your own screen on macOS and Ubuntu (Xorg) when you turn that on.

Open the bot's **Computer** tab to watch it live. **Take control** pauses its hands so you can do a sign-in, a captcha or a two-step code, then hand it back. Only a person can take or release control, and the bot never sees the password.

<table>
<tr>
<td width="50%"><img src="docs/readme/shots/bot-screen.webp" alt="Nova's computer: Chromium on the bot desktop, open on a real shop page"></td>
<td width="50%"><img src="docs/readme/shots/set-computer.webp" alt="Settings, Computer: this computer is current, and an option to add a cloud or your own server"></td>
</tr>
<tr>
<td><sub><b>Nova's screen.</b> A real browser on its own desktop.</sub></td>
<td><sub><b>Where bots run.</b> Here, madani cloud or your server.</sub></td>
</tr>
</table>

## Routines

Ask once and it becomes a routine. Schedules can be `once`, `daily` on chosen weekdays, `interval` every few minutes inside a window, or `cron`. App events (a new email, a GitHub issue) and webhooks start them too.

<p align="center"><img src="docs/readme/shots/routine.gif" alt="Nova's Monday price check routine runs: the run opens with its name and time, Nova reads the shops and reports no price changes" width="100%"><br><sub>A routine firing: the Monday price check runs and reports back.</sub></p>

<table>
<tr>
<td width="100%"><img src="docs/readme/shots/panel-routines.webp" alt="Echo's routines in the side panel: an inbox sweep every two hours and a trigger on new support email"></td>
</tr>
<tr>
<td><sub><b>Routines.</b> An inbox sweep every two hours and a trigger on new email.</sub></td>
</tr>
</table>

Routines run inside the madani bot server, next to the bot. A sleeping computer runs nothing, so while it's plugged in the desktop app keeps it awake for the hour before a due routine, and a missed run can still start up to 12 hours late. On madani cloud or your own server they run around the clock. See [routine schedules](docs/routine-schedules.md).

## Apps and AI

Sign in once with the AI you already pay for and every bot can use it. Give each bot a different model and switch any time; it keeps its chats, files and memory. Connect your apps once and choose which bots may use each one.

<table>
<tr>
<td width="50%"><img src="docs/readme/shots/connect-ai.webp" alt="Connect an AI: ChatGPT, Claude, Grok, Gemini, Cursor, GitHub Copilot, OpenRouter and a local model"></td>
<td width="50%"><img src="docs/readme/shots/model-directory.webp" alt="All models: search every model and provider"></td>
</tr>
<tr>
<td><sub><b>Connect an AI.</b> Sign in to the one you use.</sub></td>
<td><sub><b>Model directory.</b> Every model and provider.</sub></td>
</tr>
<tr>
<td><img src="docs/readme/shots/dlg-apps.webp" alt="Connect apps: Gmail, Google Calendar, Slack, GitHub, Notion, Linear, Figma and more"></td>
<td><img src="docs/readme/shots/dlg-mcp.webp" alt="MCP servers: add a server, or reuse your Claude Code MCP servers and skills"></td>
</tr>
<tr>
<td><sub><b>Connect apps.</b> One click, or Composio.</sub></td>
<td><sub><b>MCP servers.</b> By URL or command.</sub></td>
</tr>
</table>

| Kind | Providers |
| --- | --- |
| Sign in with your plan | Claude Code, Codex (ChatGPT), Gemini, Grok, GitHub Copilot, Cursor, Kimi, Qwen, OpenCode, Hermes, Cline, DeepSeek, Droid, Antigravity |
| API key | Anthropic, xAI, Mistral, Groq, Cerebras, MiniMax, or any OpenAI-compatible endpoint like OpenRouter |
| On your machine | Ollama and LM Studio |
| Anything else | A custom ACP agent or provider |

Sign-in engines run their own tool loop and get madani bot's tools (browser, computer, files, apps, memory, other bots) through an MCP server mounted for each turn. API keys and local models run in madani bot's own loop. One-click apps cover GitHub, Notion, Linear, Airtable, Todoist, Trello, ClickUp, HubSpot, Jira, Shopify, Stripe and Cloudflare, plus Gmail with an app password. madani bot is an MCP server too: `madanibot mcp`. See [Composio](docs/composio.md), [custom MCP servers](docs/custom-mcp-servers.md) and [madani bot as an MCP server](docs/mcp-server.md).

## Vault and moving in

Save a login once and bots sign in with it without ever seeing it: madani bot types it in or hands it to a tool, so the value never reaches the AI. Coming from another assistant? Bring your bots, skills and memories along.

<table>
<tr>
<td width="50%"><img src="docs/readme/shots/set-logins.webp" alt="The vault with three saved logins"></td>
<td width="50%"><img src="docs/readme/shots/set-import.webp" alt="Bring in from other apps in three steps"></td>
</tr>
<tr>
<td><sub><b>Vault.</b> Logins bots use but never see.</sub></td>
<td><sub><b>Move in.</b> From Grok bot, ChatGPT, Claude and more.</sub></td>
</tr>
</table>

## First run and your account

<table>
<tr>
<td width="33%"><img src="docs/readme/shots/onb-welcome.webp" alt="Meet madani bot: the first screen"></td>
<td width="33%"><img src="docs/readme/shots/onb-ai.webp" alt="Connect an AI during the first run"></td>
<td width="34%"><img src="docs/readme/shots/account.webp" alt="Your account: name, address, madani cloud plan, Sign out and Manage account"></td>
</tr>
<tr>
<td><sub><b>Welcome.</b> No account needed.</sub></td>
<td><sub><b>Pick your AI.</b> Sign in to the one you use.</sub></td>
<td><sub><b>Your account.</b> Only for madani cloud.</sub></td>
</tr>
</table>

Backups are one encrypted file you can move anywhere:

<img src="docs/readme/shots/set-backups.webp" alt="Settings, Backups: export a full backup or import one" width="100%">

## Where bots live

| This computer | madani cloud | Your own server |
| --- | --- | --- |
| Free, no account. Bots work while it's awake. | We host it. Bots keep working with your laptop shut. | Free. One line on Ubuntu or Debian, and bots stay on as long as it does. |

A phone app to text your bots from anywhere is coming soon.

## Install

**Mac.** One line in Terminal. It downloads this Mac's build of the latest release, checks it against `SHA256SUMS`, puts madani bot in Applications and opens it.

```sh
curl -fsSL https://madani.bot/install-mac | sh
```

Prefer the DMG? Get it from [the latest release](https://github.com/dzulhelmynazri/madani-bot/releases/latest) (`arm64` for Apple silicon, `x64` for Intel). It isn't notarized by Apple yet, so the first time:

1. Open madani bot, and click **Done** when macOS says it can't check it.
2. Open **System Settings**, then **Privacy & Security**.
3. Scroll down, click **Open Anyway**, and confirm.

**Windows.** Run `MadaniBot-0.2.0-setup.exe` from [the latest release](https://github.com/dzulhelmynazri/madani-bot/releases/latest). Windows 10 or 11, 64-bit, no admin rights. If Windows says it protected your PC, click **More info**, then **Run anyway**.

**Linux.** Ubuntu 24.04, 64-bit, in beta. Get the `.deb` or the `.AppImage` from [the latest release](https://github.com/dzulhelmynazri/madani-bot/releases/latest). See the [Linux guide](docs/linux-desktop.md).

```sh
sudo apt install ./MadaniBot-*.deb
```

Then open the app, sign in to your AI, make a bot and hand it something real. About two minutes.

## How it fits together

```text
you          desktop app · phone (soon) · a browser
               │
the link     1. direct: same machine, ssh, https, tailscale
             2. a Cloudflare tunnel on your server
             3. the madani bot relay
             end to end encrypted
               │
bot computer madani bot server on 127.0.0.1:8799
             engines: Claude Code, Codex, Gemini, Grok, ...
             tools:   browser, desktop, files, shell, apps
             data:    ~/.madanibot
               │
             your AI provider and your apps
```

- **The desktop app** (Electron and React) is where you talk. It also owns the local browser views and the desktop driver.
- **The madani bot server** (Node) runs on the bot computer: this computer, madani cloud or your own server. It owns chats, routines, approvals, the vault and the engine processes. Webhooks get their own listener on the next port.
- **The link** to a remote server tries direct ways first, then the Cloudflare tunnel on your server, then the madani bot relay. Frames are sealed with AES-256-GCM using a key only your app and your server hold, so the relay passes blobs it can't read. See [the link service](apps/link-service/README.md).

## Where your data lives

| What | Where |
| --- | --- |
| Bots, chats, routines, memory, files | `~/.madanibot` on the bot computer (`MADANI_DATA_DIR`), chats in SQLite |
| AI sign-ins and API keys | Encrypted with the OS keychain on the desktop, or a `0600` key file where there is none |
| Vault logins and app tokens | Encrypted files in the data folder, keys beside them as `0600` |
| Backups | One file, AES-256-GCM, from a password of at least 12 characters |
| What you say to a bot | Straight from the bot computer to your AI provider, not through us |
| Usage information | Anonymous usage counts and crash reports, never your messages or files, on until you turn off "help improve madani bot" (first screen or Settings). The phone app sends none. [What it sends](docs/analytics.md) |

## Security

- **Loopback trust.** On your own computer the server trusts loopback as its owner. Browsers never get that trust: a browser signs in once, and tunneled or relayed requests need a paired session.
- **Pairing.** `madanibot pair` prints a single-use code that lasts 5 minutes. Sessions last 30 days and renew on use. Five wrong codes lock an address out for 10 minutes.
- **Approvals.** Each bot has a level, from Ask to Full access. Real questions and missing sign-ins always reach you, and sending in your name has its own setting. See [approval levels](docs/approval-levels.md).
- **Secrets stay out of the model.** madani bot types a saved login in, or hands a secret to a tool, itself. Values are redacted from chats and logs.
- **Sandboxes.** On your server and on madani cloud, bots run in a bubblewrap sandbox and bot desktops are separate containers. See [bot box](docs/bot-box.md).
- **What our servers see.** The link service keeps hashed verifiers, public keys and sealed blobs. Phone notifications carry a bot's name, never the message.

Found a problem? See [SECURITY.md](SECURITY.md).

## Self-hosting

Run your bots on a server you look after, so they keep working with the laptop shut. It's free. In the app, choose **Add a cloud or your own server** and paste the line it gives you on Ubuntu 20.04+ or Debian 11+:

```sh
curl -fsSL https://madani.bot/s/<code>/cloudflare | sh   # a Cloudflare tunnel (recommended)
curl -fsSL https://madani.bot/s/<code> | sh              # the madani bot relay
curl -fsSL https://madani.bot/s/<code>/tailscale | sh    # your tailnet
curl -fsSL https://madani.bot/s/<code>/ssh | sh          # over your SSH port
```

It installs madani bot as `madanibot.service`, links it to your app and sets up the way you picked. The line works once and expires after 30 minutes, and puts `madanibot` on the server's PATH for every login: `madanibot pair --label desktop` there links another computer. By hand: `npx madanibot serve` on any machine with Node 24+, then `npx madanibot pair`. Docker Compose lives in [deploy/](deploy/). Never expose port 8799 directly; read [self-hosting](docs/self-hosting.md) first.

## Configuration

Most settings live in the app. These matter when you run the server yourself:

| Variable | What it does |
| --- | --- |
| `MADANI_DATA_DIR` | The data folder. Default `~/.madanibot` |
| `MADANI_PORT` | The server port. Default `8799` |
| `MADANI_WEBHOOK_PORT` | The webhook listener. Default the server port plus one |
| `MADANI_PUBLIC_URL` | The public address in pairing links |
| `MADANI_WEBHOOK_PUBLIC_URL` | The public address in webhook URLs |
| `MADANI_LOOPBACK_TRUST` | `owner` (default), or `service` for shared servers |
| `MADANI_SIGNIN_EMAILS` | Who may sign in by email on a hosted server |
| `MADANI_URL`, `MADANI_TOKEN` | Where the `madanibot` CLI connects, and its session |
| `MADANI_BOT_BOX` | Turns the bubblewrap sandbox on or off |
| `COMPOSIO_API_KEY` | Your own Composio key |

## Run from source

You need Node 24+, pnpm 10, and one AI tool signed in, like [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex).

```sh
git clone https://github.com/dzulhelmynazri/madani-bot.git
cd madanibot
pnpm install
pnpm dev:app          # the desktop app, with the server as its child
```

```sh
pnpm dev:server       # just the server, on 127.0.0.1:8799
pnpm dev              # the app in a browser, on 127.0.0.1:5199
pnpm dev:desktop      # the Electron shell against a running server and Vite
pnpm demo             # a separate demo workspace with sample bots, on 127.0.0.1:5299
pnpm typecheck        # types for the app and the server
pnpm lint             # oxlint
pnpm test             # the test suites
pnpm package:mac      # a DMG; also package:win and package:linux
```

More in [development](docs/development.md).

```text
src/              the app UI (React), for the desktop window and the browser
electron/         the desktop shell: windows, the notch island, updates, the desktop driver
server/           the madani bot server: bots, engines, routines, computers, the vault
shared/           code the app and the server both use
apps/
  mobile/         the phone app (Capacitor)
  companion/      the sidecar a phone talks to
  link-service/   pairing and the link for your own server
  cloudflare/     the relay and the Composio broker
  dashboard/      the madani bot account and madani cloud dashboard
  cloud-service/  madani cloud desktops
  site/           madani.bot
skills/           skills that ship with the app
deploy/           Docker Compose and server deploy files
scripts/          build, test and demo scripts
docs/             guides and references
```

## FAQ

<details>
<summary><b>Is it really free?</b></summary>
<br>
Yes, for personal use, with every feature. You only pay for madani cloud or a work license if you want one. You pay your AI provider on the plan or key you already have; madani bot never bills you for AI.
</details>

<details>
<summary><b>How is it different from Grok bot?</b></summary>
<br>
Same idea, a team of bots you text, but it runs on any AI you already use, on your own computer or server, and your data stays there. It's free for personal use.
</details>

<details>
<summary><b>Is it safe to let bots click around?</b></summary>
<br>
You set how much each bot may do alone, you can watch or take over at any time, and <code>⌘.</code> stops a bot at once. Read the card before you tap allow, especially when it sends, buys or deletes.
</details>

<details>
<summary><b>Do my bots work when my laptop is off?</b></summary>
<br>
On this computer, they work while it's awake. Put them on madani cloud or your own server and they keep going, routines included.
</details>

<details>
<summary><b>Can I read and change the code?</b></summary>
<br>
Yes. madani bot is source available under the <a href="LICENSE">PolyForm Noncommercial License</a>: read it, run it, change it and share it (with the license and its required notice) for personal and other noncommercial use. Commercial use needs a <a href="https://madani.bot/license">separate license</a>. Details in <a href="docs/LICENSING.md">LICENSING</a>.
</details>

<details>
<summary><b>Is there a madani bot token or coin?</b></summary>
<br>
No. madani bot has no token, and any coin using the name has nothing to do with this project.
</details>

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md).

## License

Source available under [PolyForm Noncommercial 1.0.0](LICENSE). Free for personal use; commercial use needs a [separate license](https://madani.bot/license).

<br>

<p align="center"><img src="apps/site/public/landing/art/cat.webp" alt="" width="120"><br><sub>Made at madani. The bots did most of it. <a href="https://madani.bot">madani.bot</a><br>Started as a fork of <a href="https://github.com/milind-soni/OpenMausBot">OpenMausBot</a> (Apache 2.0).</sub></p>
