# Taking control of a bot's computer

Run the focused checks in disposable homes:

```sh
pnpm exec vitest run src/components/ComputerPanel.takeover.test.ts src/components/computer-takeover.dom.test.ts src/components/ComputerPanel.simple.test.ts src/components/LiveDesktop.test.ts src/lib/desktop-connection.test.ts src/components/ComputerPanel.lazy.test.ts src/hooks/use-computer-panel-activity.test.ts
pnpm exec vitest run server/computer-take-control.e2e.test.ts server/container-computer.test.ts server/vps-computer.test.ts server/routes/desktop-viewer.test.ts
pnpm exec vitest run server/computer-control.test.ts server/host-lazy-claim.e2e.test.ts -t "silent"
```

The panel checks mount the real `ComputerPanel` with its real control requests;
only the live desktop itself is a stand-in. They prove:

- A ready Local VM or VPS is watched through one live, view-only noVNC connection.
  Watching sends no control request and does not poll screenshots. Pointer,
  keyboard and clipboard input remain disabled in the viewer.
- Opening a stopped desktop waits for an explicit wake click inside its frame.
  The original grey mascot remains visible until its live preview arrives.
  Wake stays inline without taking control. Clicking the awake preview opens
  the original fullscreen viewer read-only; only its Take control button enables input.
- **Take control** stays disabled until the first decoded frame, then acquires this view's control lease and enables input on the
  existing connection. **Full screen** expands that same desktop without
  reconnecting or acquiring control. Nothing opens in another window or tab.
- **Stop** in the original viewer, or **Hand control back** in the advanced view, releases the computer at once and disables input on
  the same connection, so watching resumes without another handshake.
- Closing the panel, leaving its Computer view, opening another conversation or
  closing the page gives back the hold this view took, with a keepalive request,
  and never a hold another device has.
- While this view holds the computer it sends a heartbeat (`check` with its
  lease) every 20 seconds. A hold not heard from for 65 seconds (a force-quit or
  crashed app, a lost phone) is handed back within the next 5 seconds, and the
  bot's waiting computer call returns as it does after Hand back.
- A hand-back from elsewhere returns the viewer to view-only mode once it has
  lasted a second and a half; an out-of-order event does not end control.
- A desktop that never comes up gives the computer back and says so. Watching
  falls back to bounded screenshot polling when the live viewer cannot connect.
- Handing back a VPS keeps the watched tunnel alive. Closing the viewer releases
  its connection; remote tunnels expire through the existing reconnect grace.
- Selected computer activity opens the right panel without taking control, including
  an already-awake desktop found by one status read after reload or selection.
  Closing it manually suppresses reopening during the same wake cycle.
- Cancelled or replaced connections cannot publish late state or leave a
  WebSocket running. A new target gets its own first-connection failure check.


The server checks use isolated desktop transports and temporary homes. They
cover control leases, authenticated viewer access, target changes and bounded
connection setup. Local VM and VPS desktops retain their process caps and
existing operator resource settings.

## By hand, against a real Local VM

Use Docker on macOS or Linux and a server from source in a temporary home:
`HOME` and `MADANI_DATA_DIR` in a new temporary folder, the fake engine in its
`config.json` with `localVm: { mode: "per-bot" }`, `MADANI_STATIC_DIR` set to a
`pnpm exec vite build` output and `MADANI_DEV_TRUST_LOCAL_BROWSER=1`. Give a bot
the Local VM, create its VM from the panel and send it a message so it works.

1. Press **Take control**. Within a fraction of a second the panel's picture
   becomes the live desktop and the label reads “You're in control”. Click into
   a window and type: the desktop answers, and the bot's computer calls wait.
2. Press **Full screen**: the same desktop fills the window. Type a line with the
   field at the top, then **Exit fullscreen**.
3. Press **Hand control back**: the bot's waiting call returns “The person has
   handed this computer back” and its next call goes through.
4. Take control again and close the panel, then again and close the page: the
   bot's next call goes through within a second each time.

Remove the bot's VM container afterwards. This does not drive the packaged
Electron window or a real remote network.
