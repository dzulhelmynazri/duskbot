# Phone push

A paired phone gets a push for a notification (a reply, a question, an approval) the person has not already seen. A
message they are looking at, or already read on any device, never pushes.

## How the workspace decides

The workspace (your computer or server) decides, per phone:

- The app tells the workspace when it opens, which conversation is on screen (none on the chat list), and when it goes
  to the background (`PUT /api/mobile/presence` with `away` and `threadId`). It keeps saying it is open every 25 seconds;
  an app that stops for 60 seconds (killed, suspended, out of signal) counts as away. A phone that never reported counts
  as away.
- A notification for the conversation the open app shows is never pushed to that phone.
- Every other push waits 4 seconds first. It is dropped if, by then, the notification was read anywhere (the desktop
  window open on that chat, the phone, "mark all read") or the phone opened that conversation. Several in one
  conversation within those seconds send once, the newest.
- A push the service could not take is tried again after 10 seconds and after 60 seconds, while it is still unread and
  not on screen. A token APNs or FCM calls dead is dropped; the app registers again next time it opens.

On the iPhone, a push that lands while the app is open shows as the system's own banner, unless it is about the
conversation on screen, which shows nothing. Pushes already in Notification Center are removed once read: when that
conversation opens, when a read arrives from another device while the app is open, and each time the app comes back.
A phone that stays locked keeps a push read elsewhere until the app next opens.

The desktop app on a Mac never posts system notifications; its dock, island and unread dots carry them.

The code is in `server/mobile/presence.ts` (where each phone is), `server/mobile/link.ts` (the grace and wiring) and
`server/mobile/push.ts` (sending).

## Where pushes leave from

APNs and FCM accept pushes only from whoever holds the app's keys. A workspace sends a push:

1. with its own keys, when `MADANI_APNS_*` or `MADANI_FCM_SERVICE_ACCOUNT_FILE` are set on it (below), else
2. through a push relay: `MADANI_PUSH_RELAY` if set (`off` turns this off), else the link service its VPS link agent uses,
   else `MADANI_MOBILE_RELAY`, else `https://link.madani.bot`.

The relay is `POST /v1/push` on the link service (`apps/link-service/src/push-relay.mjs`). It sees the device token, APNs or
FCM, the bot's name and the ids a tap opens (notification, bot, conversation, room). It never gets a notification's
title or any message text, keeps nothing, and logs no token. Apple and Google see the same: the lock screen shows the
bot's name and "New message". It allows 20 pushes a minute per device token and 240 per address.

## Setup you have to do

None of this is in the repo: keys and Firebase files are secrets or tied to your developer accounts.

### iOS (APNs)

1. In the Apple Developer account that signs the app (bundle id `bot.madani.mobile`), open Certificates, IDs &
   Profiles, Keys, and create a key with **Apple Push Notifications service (APNs)** enabled. Download the `.p8` file
   (only once) and note its Key ID and your Team ID.
2. The `aps-environment` entitlement is already in the project (`apps/mobile/ios/App/App/App.entitlements`). In the
   developer account, turn on **Push Notifications** for the app id, and select your team for the App target in
   `apps/mobile/ios/App/App.xcodeproj` so Xcode makes a profile that carries it.
3. Put the key where the pushes leave from (the link service host for the relay, or the workspace itself) and set:
   - `MADANI_APNS_KEY_FILE`: path to the `.p8` file (readable only by the service user, `chmod 600`)
   - `MADANI_APNS_KEY_ID`: the key's ID
   - `MADANI_APNS_TEAM_ID`: your Team ID
   - `MADANI_APNS_TOPIC`: `bot.madani.mobile`
4. Restart the link service (or the workspace). `GET /v1/push` on the link service should answer
   `{"services":["apns",...]}`.

A build run from Xcode gets sandbox tokens; TestFlight and App Store builds get production tokens. The app marks its
token sandbox only when its web part was built in development mode, so for a push test from Xcode build with
`MADANI_MOBILE_DEV_URL` (live reload) or use TestFlight; a production-marked sandbox token is refused by APNs and dropped.

### Android (FCM)

1. In the Firebase console, create a project (or use one), add an Android app with package `bot.madani.mobile`,
   and download `google-services.json` into `apps/mobile/android/app/` (it is already git-ignored there; the build
   applies the Google services plugin only when the file exists). Rebuild the app.
2. In Project settings, Service accounts, generate a new private key. That JSON file is a secret.
3. Where the pushes leave from, set `MADANI_FCM_SERVICE_ACCOUNT_FILE` to that file's path (`chmod 600`) and restart.

### Check it

1. Pair the phone, allow notifications when asked, and open Settings, Notifications in the app once.
2. Put the app in the background, then make a bot answer you (or ask you something) from the desktop.
3. The phone should get "{bot name}: New message" within a few seconds; tapping it opens that conversation.

If nothing arrives, the workspace log says `mobile push: no APNs or FCM credentials and no push relay on this server`
when it has neither, and `GET /v1/push` on the relay lists what the relay can send.
