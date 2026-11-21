import { defaultRunner, vpsDockerArgs, type VpsCommandRunner } from "./vps-computer.ts";
import { independentScreenExecArgs } from "./shared-desktop-screens.ts";
import { validateVpsLifecycleTarget, type VpsLifecycleTarget } from "./vps-lifecycle.ts";

const PRIMARY_BROWSER_CLOSE = `import base64, hashlib, json, os, re, shlex, socket, time, urllib.request
from pathlib import Path
PORT = 9222
PROFILE = "/home/cua/.config/chromium"
def identity(pid):
    try:
        path = Path("/proc") / str(pid)
        if path.stat().st_uid != 1000: return None
        fields = (path / "stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "start": fields[19], "group": int(fields[2]), "session": int(fields[3])}
    except (OSError, ValueError, IndexError): return None
def primary_owners():
    parents = []
    for value in Path("/proc/1/task/1/children").read_text().split():
        pid = int(value)
        current = identity(pid)
        if not current or current["pid"] != current["group"]: continue
        try:
            base = Path("/proc") / value
            command = (base / "cmdline").read_bytes().split(b"\\0")
            env = dict(item.split(b"=", 1) for item in (base / "environ").read_bytes().split(b"\\0") if b"=" in item)
            if b"/usr/local/bin/omb-session" in command and env.get(b"DISPLAY") == b":1" and env.get(b"MADANI_SCREEN_MANAGED") != b"1": parents.append(current)
        except OSError: pass
    if len(parents) != 1: raise RuntimeError("Cannot prove primary desktop session ownership")
    owners = parents[:]
    state = Path("/run/user/1000/omb-primary/browser.json")
    try:
        fd = os.open(state, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            detail = os.fstat(fd)
            if detail.st_uid != 1000 or detail.st_size > 4096: raise RuntimeError("Invalid managed primary browser state")
            saved = json.loads(os.read(fd, 4097))
        finally: os.close(fd)
        browser = saved.get("browser", {})
        if saved.get("parent") == parents[0] and identity(browser.get("pid", -1)) == browser and browser["pid"] == browser["group"] == browser["session"]: owners.append(browser)
    except FileNotFoundError: pass
    return owners
def owned_descendant(pid, owners):
    for _ in range(64):
        current = identity(pid)
        if not current: return False
        if any(current == owner for owner in owners): return True
        try: pid = int((Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError): return False
    return False
def listeners():
    inodes = set()
    for name in ("tcp", "tcp6"):
        for line in Path("/proc/net", name).read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] == "0A" and int(fields[1].rsplit(":", 1)[1], 16) == PORT:
                inodes.add("socket:[" + fields[9] + "]")
    if not inodes: return []
    owners = primary_owners()
    found = []
    for path in Path("/proc").iterdir():
        if not path.name.isdigit(): continue
        pid = int(path.name)
        current = identity(pid)
        if not current: continue
        try:
            if not any(os.readlink(fd) in inodes for fd in (path / "fd").iterdir()): continue
            command = (path / "cmdline").read_bytes().split(b"\\0")
            args = [value.decode("utf8", "strict") for value in command if value]
            if len(args) == 1: args = shlex.split(args[0])
            executable = Path(os.readlink(path / "exe")).name
            if executable not in ("chromium", "chromium-browser", "chrome") or any(arg.startswith("--type=") for arg in args): raise RuntimeError("The primary CDP listener is not Chromium")
            if "--remote-debugging-port=9222" not in args or not owned_descendant(pid, owners): raise RuntimeError("The primary browser identity changed")
            profiles = [arg.split("=", 1)[1] for arg in args if arg.startswith("--user-data-dir=")]
            if profiles != [PROFILE]: raise RuntimeError("The primary browser profile changed")
            found.append(current)
        except (FileNotFoundError, ProcessLookupError): continue
    if len(found) != 1: raise RuntimeError("Cannot prove ownership of the primary browser listener")
    return found
owners = listeners()
if not owners:
    print(json.dumps({"closed": False, "alreadyClosed": True}))
    raise SystemExit(0)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open("http://127.0.0.1:9222/json/version", timeout=2) as response:
    version = json.loads(response.read(65536))
from urllib.parse import urlparse
endpoint = urlparse(version.get("webSocketDebuggerUrl", ""))
if endpoint.scheme != "ws" or endpoint.hostname not in ("localhost", "127.0.0.1") or endpoint.port != PORT or not re.fullmatch(r"/devtools/browser/[A-Za-z0-9-]+", endpoint.path) or endpoint.query or endpoint.fragment or endpoint.username or not version.get("Browser"):
    raise RuntimeError("Invalid primary browser debugging endpoint")
with socket.create_connection(("127.0.0.1", PORT), timeout=2) as peer:
    nonce = base64.b64encode(os.urandom(16)).decode("ascii")
    request = ("GET " + endpoint.path + " HTTP/1.1\\r\\nHost: 127.0.0.1:9222\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: " + nonce + "\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n").encode("ascii")
    peer.sendall(request)
    headers = b""
    while b"\\r\\n\\r\\n" not in headers:
        part = peer.recv(4096)
        if not part or len(headers) + len(part) > 16384: raise RuntimeError("Invalid browser WebSocket handshake")
        headers += part
    lines = headers.split(b"\\r\\n")
    expected = base64.b64encode(hashlib.sha1((nonce + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest())
    accept = [line.split(b":", 1)[1].strip() for line in lines[1:] if line.lower().startswith(b"sec-websocket-accept:")]
    if not lines[0].startswith(b"HTTP/1.1 101 ") or accept != [expected]: raise RuntimeError("Invalid browser WebSocket handshake")
    if listeners() != owners or any(identity(owner["pid"]) != owner for owner in owners): raise RuntimeError("The primary browser changed before close")
    payload = b'{"id":1,"method":"Browser.close"}'
    mask = os.urandom(4)
    peer.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))
deadline = time.monotonic() + 4
while time.monotonic() < deadline:
    if not listeners():
        print(json.dumps({"closed": True}))
        break
    time.sleep(0.05)
else: raise RuntimeError("The primary browser did not close")
`;

export async function closeVpsBrowser(target: VpsLifecycleTarget, stillAllowed: () => boolean, signal?: AbortSignal, runner: VpsCommandRunner = defaultRunner): Promise<void> {
  const pinned = validateVpsLifecycleTarget(target);
  if (!stillAllowed() || signal?.aborted) throw Object.assign(new Error("VPS browser close cancelled"), { code: "vps_action_cancelled" });
  const args = pinned.screen ? independentScreenExecArgs(pinned.containerId, "browser-close", pinned.screen)
    : ["exec", "-u", "1000:1000", pinned.containerId, "python3", "-I", "-c", PRIMARY_BROWSER_CLOSE];
  await runner(vpsDockerArgs(pinned.sshAlias, args), { timeoutMs: 12_000, ...(signal ? { signal } : {}) });
}
