# Bot desktop

The bot's own computer: a small dark Linux desktop in a hardened container, one per bot, on the person's VPS (or
locally in Docker). Bots drive it through Cua Driver exactly as they drive the Cua XFCE image (screenshots, clicks,
typing, AT-SPI, Chromium over CDP); people see it through noVNC when they take control.

Image: `ghcr.io/madanibotai/madani-desktop:v6` (`BOT_DESKTOP_IMAGE` in `shared/bot-desktop.ts`). linux/arm64 and
linux/amd64, published from main by `.github/workflows/bot-desktop-image.yml` and pulled anonymously, so the package is
public. Earlier builds were tagged `ghcr.io/sidddevz/omb-bot-desktop` (up to v5) and `ghcr.io/madanibotai/bot-desktop` (v5); desktops made from those keep running.

## What is inside

| Part | Choice | Why |
| --- | --- | --- |
| Base | Debian 13 trixie slim | current, multi-arch, security updates for Chromium |
| Display | TigerVNC `Xvnc` :1, 1280x800 | X server and VNC in one process, no polling, low CPU |
| Viewer | noVNC 1.6.0 web client + websockify on :6901 | the harness's existing path (`vnc.html`, `/websockify`, `VNC_PW`) |
| Windows | Openbox, theme `OMB` | flat square 1px frames, Inter titles, no menus |
| Compositor | none | no rounded corners, shadows or fades: less CPU, still frames for VNC |
| Dock | tint2, launchers only | three color app icons (`icons/*.svg` from Papirus, see `icons/README.md`), no shelf, no taskbar |
| Browser | Chromium (both arches) | Google Chrome has no Linux arm64 build; one browser everywhere |
| Terminal | xfce4-terminal | software-rendered VTE (kitty/alacritty need GL), no menubar, `#111111`, block cursor |
| Files | Thunar | behind the middle dock icon; Papirus-Dark icons here and in every GTK file dialog |
| Control | Cua Driver 0.47.24 (pinned wheel from its GitHub release, SHA-256 checked) | the harness speaks it already, nothing changes for bots |
| Pointer | none drawn on the desktop: cursor theme `omb-hidden` (`blank-cursors.py`), Cua Driver `--no-overlay` | no frozen system pointer or Cua's agent cursor in the picture, screenshots or recordings; the app draws the bot's pointer over its live view from where Cua Driver says each action landed (`server/bot-pointer.ts`) |

The image keeps Papirus icons for installed applications, their symlink targets, and every file, folder and action
icon. Unused application icons are removed at build time by `trim-icons.py`; newly installed applications can supply
their own icons through the normal hicolor fallback. A disposable arm64 image check reduced the two Papirus themes
from 104,082,850 to 21,207,756 bytes without leaving broken icon links. This is an icon payload measurement, not a
compressed image size or a VPS transfer benchmark.

Wayland (labwc, sway) was ruled out: Cua Driver's capture and input paths here are X11 (XTest, AT-SPI over X), and
VNC over X is the most mature thing to stream from.

## Wallpaper: one file

`wallpaper/wallpaper.png` is cover-scaled onto black at the screen size when the image is built. Swap that one
file (any `wallpaper.*` ImageMagick reads) and rebuild. A person can also drop `~/.config/omb/wallpaper.png` into a
running box. The current file (two reaching hands as a white-dot halftone) came from the user; its source and license
are not recorded here, so confirm the right to ship it before publishing the image.

## Temporary files and passwords

- `/home/cua/scratch` is the bot's throwaway folder (its screenshots, screen recordings, temporary downloads and tool
  output; the bot's prompt says so). The server empties it when a turn on this desktop ends and no other turn is using
  the desktop, deletes anything there a day old every 15 minutes, and does the same for Chromium's `Crash Reports`
  (`server/box-scratch.ts`). When `/home/cua` is over 80% full it clears that scratch oldest first, and if the disk is
  still over 80% the bot's next turn gets a calm note to pass on. Nothing else is ever deleted: not `workspace`,
  `Downloads`, the browser profile, or anything the person put on the desktop. A file shown in chat was copied into the
  app's own attachment store by `attach_file`, so clearing scratch never breaks a chat image.
- Chromium never saves or offers to save passwords (`PasswordManagerEnabled` and `PasswordLeakDetectionEnabled` off
  in `rootfs/etc/chromium/policies/managed/omb.json`); sign-ins come from the Vault through `fill_login`. Its disk
  cache is capped at 256 MB (`DiskCacheSize`).

## Two modes

The harness picks one at creation and labels the container with the mode label (`DOCKER_NAMES.label("bot-desktop-mode")` in `electron/legacy-names.mjs`).

**free** (the goal): the bot may do anything inside its box. `sudo` without a password, a writable root filesystem
that keeps what is installed across restarts (recreating the box from the image is the reset), any program or server
(ports under 1024 too). It never gets out:

- the host fences the box's network (below): public internet only. No host address or port, no other box or
  container, no LAN or VPC, no `169.254.169.254` or other link-local, no IPv6 at all.
- gVisor (`--runtime runsc`) when installed, else Docker user-namespace remapping, so root in the box is not root on
  the host. Free mode is never used on plain runc without remapping.
- capabilities: all dropped, then only `AUDIT_WRITE CHOWN DAC_OVERRIDE FOWNER FSETID KILL NET_BIND_SERVICE SETGID
  SETUID SYS_CHROOT` (what apt, dpkg and sudo need). Never `NET_ADMIN` or `NET_RAW`, so root in the box cannot touch
  routes, addresses or firewall rules, or spoof on the bridge.
- Docker's default seccomp and AppArmor profiles, `--ipc private`, `--cgroupns private`, no host mounts, no devices,
  no Docker socket, no published ports, 4 GiB memory (no swap), 2 CPUs, 4096 pids.

**strict** (automatic fallback when the host has no fence or neither gVisor nor remapping): the box fences itself.
PID 1 applies `omb-firewall` with `NET_ADMIN`, then the session runs as uid 1000 under `no-new-privileges`, which also
makes `sudo` inert. Read-only root filesystem; same network rules plus the host's own addresses (`MADANI_BLOCK_EXTRA`).

## How the harness starts it

`server/bot-desktop.ts` (`provisionBotDesktop`), over `docker -H ssh://<alias>`:

The placeholders below use `electron/legacy-names.mjs`: `<name>` uses `DOCKER_NAMES.vpsPrefix`,
`<desktop-network>` is `DOCKER_NAMES.desktopNetwork`, and each `<...-label>` is `DOCKER_NAMES.label("...")`.

1. `docker pull ghcr.io/madanibotai/madani-desktop:v6` unless present. If the pull fails (not published, private
   package, registry down) it builds the image on the docker host from this folder as shipped with the server
   (`deploy/bot-desktop/` beside `dist-server/`, or `MADANI_BOT_DESKTOP_KIT`), only when its Dockerfile's
   `ARG BOT_DESKTOP_VERSION` equals `BOT_DESKTOP_VERSION`; the turn's chat says the build is running. When neither
   works (or the server reaches docker through the docker gate, which forwards no build), provisioning refuses with a
   short try-again message (docker's own output goes to the server log) and creates nothing; it never falls back to the Cua XFCE desktop.
   `MADANI_VPS_DESKTOP=cua` forces Cua.
2. `docker network create --driver bridge --opt com.docker.network.bridge.enable_icc=false
   --opt com.docker.network.bridge.name=omb-desk0 --label <vps-network-label>=1 <desktop-network>`
3. `docker info` for `runsc` (gVisor) and `name=userns` (remapping); `MADANI_VPS_GVISOR=off` skips gVisor.
4. Fence check: `docker run --rm --network host --userns host --cap-drop ALL --cap-add NET_ADMIN --read-only
   --security-opt no-new-privileges --entrypoint /usr/local/bin/omb-host-fence <image> --check` (reads netfilter only).
   `MADANI_VPS_BOX=strict` forces strict.
5. Free:

```sh
docker run -d --name <name> --hostname bot \
  --label <vps-label>=1 --label <container-label>=<name> --label <environment-label>=<id> \
  --label <vps-viewer-label>=1 --label <bot-desktop-label>=2 \
  --label <bot-desktop-mode-label>=free --label <cua-driver-label>=0.47.24 \
  [--runtime runsc] --network <desktop-network> --dns 1.1.1.1 --dns 9.9.9.9 \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g --tmpfs /run:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0755 \
  --mount type=volume,source=<name>-home,target=/home/cua \
  --cap-drop ALL --cap-add AUDIT_WRITE --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add FSETID \
  --cap-add KILL --cap-add NET_BIND_SERVICE --cap-add SETGID --cap-add SETUID --cap-add SYS_CHROOT \
  --ipc private --cgroupns private --memory 1536m --memory-swap 1536m --cpu-shares 256 --oom-score-adj 500 \
  --cpus 2 --pids-limit 4096 --shm-size 512m --restart no -e MADANI_MODE=free -e VNC_PW=<random> <image id>
```

   Strict instead: `--read-only`, `--cap-add NET_ADMIN --cap-add SETUID --cap-add SETGID` only,
   `--security-opt no-new-privileges`, `-e MADANI_MODE=strict`, and `-e MADANI_BLOCK_EXTRA=<host addresses>` read with a
   one-shot `ip -o addr show scope global` probe in the host's network namespace.

The status check (`server/vps-computer.ts`) refuses a container whose flags, mounts, network, labels or image differ
from these, as it does for Cua. Everything after creation is unchanged: `docker exec -u cua ... cua-driver mcp` for the
bot, `get_desktop_state` screenshots, the SSH `-L 127.0.0.1:<port>:<box ip>:6901` tunnel for Take control. The volume
`<name>-home` (saved files, browser profile, history) outlives the container; delete it with
`docker volume rm <name>-home` when the bot's files should go too.

## Host setup the box expects (for the installer)

Ubuntu 24.04 (arm64 or amd64), Docker Engine, as root. Order matters: gVisor or remapping, then the fence.

**1. gVisor (preferred).**

```sh
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  > /etc/apt/sources.list.d/gvisor.list
apt-get update && apt-get install -y runsc
```

Register it in `/etc/docker/daemon.json` (merge with what is there) and restart Docker. `--overlay2=none` makes
writes land in Docker's own container layer, so what a bot installs survives a restart (gVisor's default overlay
keeps the root filesystem in sandbox memory and drops it when the box stops):

```json
{ "runtimes": { "runsc": { "path": "/usr/bin/runsc", "runtimeArgs": ["--overlay2=none"] } } }
```

`docker info --format '{{json .Runtimes}}'` must then list `runsc`.

**2. Or, without gVisor: user-namespace remapping.** `"userns-remap": "default"` in `/etc/docker/daemon.json`, then
restart Docker (it creates the `dockremap` user; images are pulled again into a separate store).
`docker info --format '{{json .SecurityOptions}}'` must then include `name=userns`.

**3. The network fence.** Install `host-fence.sh` and its unit so it is applied at every boot after Docker:

```sh
install -m 0755 deploy/bot-desktop/host-fence.sh /usr/local/sbin/omb-host-fence
install -m 0644 deploy/bot-desktop/omb-box-fence.service /etc/systemd/system/omb-box-fence.service
systemctl daemon-reload && systemctl enable --now omb-box-fence.service
/usr/local/sbin/omb-host-fence --check && echo fenced
```

It adds chains `OMB-BOX-IN` (from `INPUT -i omb-desk0`: only replies to connections the host opened, and TCP to the link agent's egress proxy port 3129) and `OMB-BOX-FWD`
(from `DOCKER-USER -i omb-desk0`: drop box-to-box and every private, loopback, CGNAT, link-local and reserved range,
then the internet), and drops all IPv6 from `omb-desk0`. It uses the host's `iptables` (nft on Ubuntu 24.04).
`--remove` takes it away. The fence never comes down on its own.

**4. Nothing else.** No published ports and no firewall openings: SSH stays the only way in.

## Build

```sh
deploy/bot-desktop/build.sh            # this machine's arch, tagged BOT_DESKTOP_IMAGE
deploy/bot-desktop/build.sh --push     # amd64 + arm64 to the registry (docker buildx)
```

On a VPS without the registry image: copy this folder over and run `build.sh` there (only Docker is needed); the
harness then finds the image by its tag and skips the pull.

## Rolling out a new version

A desktop whose version label differs from `BOT_DESKTOP_VERSION` updates itself on its home volume (see step 5), so roll
out in this order:

1. Bump `BOT_DESKTOP_VERSION` and `BOT_DESKTOP_IMAGE` in `shared/bot-desktop.ts` and `ARG BOT_DESKTOP_VERSION` in the
   Dockerfile together; the server builds only a kit whose Dockerfile matches.
2. Merge to main: the "Bot computer image" workflow builds amd64 and arm64 natively and pushes the tag, then checks it
   can be pulled without signing in. A published tag is never rebuilt, so kit changes need a version bump.
   `node scripts/check-bot-desktop-published.mjs` says whether it is; `scripts/build-vps-package.mjs` and the release
   workflow refuse to ship a server that points at an image nobody can pull.
3. Publish the VPS package to the link service (`apps/link-service/README.md`, "The server build"). It carries this folder
   twice: as the installer's kit and inside the server package.
4. Update the server on each linked VPS to that package. New bot computers then pull or build the new image on first
   use. To prepare it ahead of time, run `IMAGE=<BOT_DESKTOP_IMAGE> sh deploy/bot-desktop/build.sh` from the
   installed package folder.
5. Existing desktops of the old version update themselves, and never stop working for it. The server's background pass
   (a minute after it starts, then every 15 minutes) first gets the new image onto the host (pull, else build) without
   holding anything, then replaces each desktop nothing is using: the old container is stopped and set aside as
   `<name>-previous`, the new one is created on the same home volume, and the old one is removed once the new one is
   up. If the new one fails, the old one is put back as it was and the update is tried again 30 minutes later. A wake
   never downloads: it swaps in the new version only when its image is already on the host, and otherwise (or when the
   swap fails) starts the old desktop as it is, on its own image and Cua Driver. Saved files and browser sign-ins stay; anything installed outside the home is gone.
   An older Cua desktop keeps nothing inside it, so a person still updates that one with the update button.

The desktop app talking to a VPS over an SSH alias ships no kit, so it can only pull; when the registry refuses, the
problem says to build on the VPS with `build.sh`.

Measured on Apple Silicon (arm64, OrbStack, 2026-11-07): build about 90 s from a warm Debian base; image 1.8 GB
unpacked, about 500 MB compressed; Cua Driver answers 0.3 to 0.5 s after `docker run`, Chromium has google.com up
about 2 s after; idle with Chromium open about 340 MiB and under 1% of a core.
