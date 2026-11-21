# Changelog

Notable changes to madani bot, newest first. Installers and checksums for each version are on the
[releases page](https://github.com/dzulhelmynazri/madani-bot/releases) and at [madani.bot/download](https://madani.bot/download).

## 0.2.15

- The free model stays first in the model picker, with OpenCode's free models listed by name, and a bot's model badge names the model that is really answering.
- Link your iPhone from Settings > Phone: one QR code and a short letters-only code, and every linked phone shows where it is connected.
- When a reply fails, it says why in plain words: a missing model, a refused request, a chat that got too long, an outage or a stopped AI.
- madani cloud starts with 3 days free, and the first chat is ready to type in with jobs to tap.
- The account menu leads with your name, then your address and plan; give feedback and updates share one slim line in the sidebar.
- Codex signs in through your browser on this computer instead of a device code.
- Fixed: local memory search on Windows, Grok sign-in errors and rate limits, the Computer tab showing the right screen, and many smaller fixes.

## 0.2.14

- A fresh install starts clean: nothing from other apps is copied in, and no keychain prompt asks for another app's key.
- An AI is never signed in to without you pressing its button: an old Grok login no longer opens the browser on first launch.
- madani cloud says what moves before you pay, a cloud bot's screen is labelled its cloud computer, and smaller fixes.

## 0.2.13

- Chat is just chat: no tool steps or run receipts under replies.
- Routines answer in the bot's own chat, like any message.
- Give feedback from the sidebar, with pictures; the same spot turns into the update button when a new version is ready.
- A short, skippable step asks for the Mac permissions bots need, and nothing is asked at launch any more.
- Voice typing shows your words as you speak.
- A clearer madani cloud plans sheet, more AI providers, and a simpler way to bring what your AI knows about you.
- Opening madani bot outside Applications offers to move it there.
- Warmer replies, and many fixes.

## 0.2.12

- Bots remember better: facts keep their dates, the right ones come back when they matter, and duplicates merge without losing anything.
- Setup brings in what you already use, starting with the app that already knows you, memory included.
- Connecting an AI shows real install progress, and signing in to one says what to do in the browser.
- Local bots browse in their own browser, where you can watch and use it with them.
- Moving to madani cloud takes your whole Vault, sealed, and backs it up as soon as the move checks out.
- Smoother motion across dialogs, menus, tooltips, the sidebar and the dock.
- Mac updates install cleanly for every user; sign in with X is gone.

## 0.2.11

- First run starts with a welcome, offers every sign-in from the first frame, and leads with what this Mac already holds.
- Signing in from the app lands on onboarding or home, never on the app link.
- New bots greet with a fixed line, so nothing is spent before your first message.
- Every bot knows the basics about itself: its name, home, memory, computer, browser, routines and apps.
- Voice settings test the mic once it is ready; Windows shows the default microphone.

## 0.2.10

- When the backup AI takes over, the model chip and panel show the AI that is answering now.
- Voice: a problem shows as a card above the message box, and the home page listens through this computer.
- Gemini sign-in on a remote workspace comes back through the desktop.
- Connect an AI opens and closes smoothly, and Send stays until the server has your message.
- Ready-made bots have new names and sharper instructions.

## 0.2.9

- Sign up in the browser and come straight back to the app, signed in.
- Signing in to an AI no longer asks you to paste a code.
- Connected apps stay in sync.
- Moving to madani cloud or your own server works again where it stalled.
- The dashboard opens faster.
- First run offers a madani bot account, with a quiet Skip for now.

## 0.2.8

- The app updates itself on the Mac: the sidebar says Update to, then Downloading with progress, then Restart to update.
- Stop ends the turn at the press, and nothing of it lands after.
- A model picked mid-reply applies from the next message.
- First run: a found AI has Continue, Skip works while it checks, and picking This Mac just goes on.
- Start fresh in the bot panel, with its confirm, progress and retry.
- After a move to a server of your own, this computer opens a clean workspace.
- Menus, switches and dialogs fit their windows and edges better.

## 0.2.7

madani bot for Windows and Linux, beside the Mac.

- Windows x64: a one-click installer (MadaniBot-setup.exe) and a portable zip. Not code-signed yet, so SmartScreen asks
  before it runs (More info, then Run anyway).
- Linux x64: an AppImage and a .deb for Ubuntu and Debian.
- First run asks less: an AI that already answers is used without asking, and Connect an AI shows clear stages.
- Copilot and Cursor sign in from the app, in the background, with no terminal.
- Notes from another AI can be pasted or dropped into any bot's chat.

## 0.2.6

Both packages (your own server and madani cloud) built from one commit again.

- A server's bots move to a new madani cloud by themselves once it is ready (the cloud now says it takes moves).
- The install line retries its own download five times, every other try over IPv4, and stops with a plain message if
  none arrives.
- Menus, dialogs and status lines read in sentence case on the desktop and the phone.

## 0.2.5

- An AI you connect always comes first: new bots start on it, and bots and conversations on the free backup model move
  to it as soon as it is ready.
- With no AI connected, a reply the free backup model couldn't give is a "Connect your AI to start" card with one button
  to connect one, instead of an error.
- A new bot's first message on madani cloud no longer fails at once with "Invalid path" when another bot's turn is running.

## 0.2.4

- When the free backup model has used up its free replies, the chat says so within seconds and suggests connecting your
  own AI, instead of trying other free models that share the same limit.
- A free backup model that answers with nothing counts as no answer: the next free model gets the message, and if none
  answers, the chat says so plainly.

## 0.2.3

0.2.1 and 0.2.2 were own-server packages only; this is the first version on every line since 0.2.0.

- A new person's first message always gets an answer: a free backup model that sends nothing in 25 seconds hands the same
  message to the next free model, and if none answers, the chat says so plainly and what to do.
- Every account step goes to your browser for its context: sign in or make your account there, then land on your plan's
  checkout, billing or home, and the app signs itself in and goes on by itself (coming back to the app is optional).
- Moving a server's bots to madani cloud while signed out no longer stops at "sign in on this Mac's own page first".
- Linking your own server while signed out signs you in in the browser, then shows the install line by itself.
- The install line stops with a plain message when a download fails, and every download retries, falling back to IPv4.
- A sleeping cloud says it is asleep instead of "waking up".

## 0.2.0, first light

The first public release. madani bot is your own crew of AI helpers: each bot gets a job, a chat and a computer of its own,
and works on the Claude, ChatGPT, Gemini or Grok you already use. Free for personal use, with no account and no card.

### Bots

- Give each bot one job in plain words, and run as many as you like at once, each with its own chat, files and memory.
- Memory you can read and edit: a bot keeps notes on how you like things done, and every note says where it came from.
- Routines: ask once, and it runs on a schedule or the moment something happens.
- Rooms: put several bots in one thread to hand work to each other; they ask you before anything big.
- Bring the AI you already pay for (Claude, ChatGPT, Gemini, Grok, Cursor, Copilot, DeepSeek and more), an API key, or a
  model you run yourself. Use a different model for each bot and swap any time.

### Computer

- Every bot gets a browser and a desktop of its own to sign in to and click through.
- Watch it work live and take the mouse back whenever you like.
- The live screen connects straight to your bot when it can, with a relay through Cloudflare as a backup.

### Phone

- Text your bots from your iPhone or Android: scan a code on your computer to pair.
- Answer questions, approve things and hear when a bot is done.
- The phone app runs in your phone's browser for now; App Store and Google Play listings come later.

### Connectors

- Plug bots into 60+ apps, including GitHub, Google Drive, Notion, Linear, Airtable, Todoist, ClickUp, Trello and Dropbox.
- One-click sign-in for the apps that support it.

### madani cloud

- Free keeps your bots on your own computer. madani cloud (Plus and Pro) runs them on a machine we host, so they keep
  working with your laptop shut.
- Or run the server on your own VPS with one line.

### Privacy

- Your bots, chats and memory live on your computer, or your own cloud machine.
- Logins you save are filled in for your bot and never shown to it.
- Bots ask before the risky stuff: sending, paying, deleting.

### Platforms

- macOS 12 or later (Apple silicon and Intel), Windows 10 or 11 (64-bit), Ubuntu 24.04 (64-bit, beta).
- The macOS build is not notarized yet and the Windows build is unsigned, so each shows a one-time security prompt.
