import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type VpsLinkView } from "./vps-link";
import { pairingBlock } from "../../server/cli-pairing";
import { installChecklist, installPhase, pairingLink, pastedPairingLink } from "./place-setup";

const at = (view: Partial<VpsLinkView>): VpsLinkView => ({ ...EMPTY_VIEW, ...view });
const states = (view: VpsLinkView, now = 0) => installChecklist(view, now).map((step) => `${step.key}:${step.state}`);
const SERVER = { id: "s", name: "my-vps", origin: "https://s.example.com" };

describe("adding a server by one line", () => {
  it("goes waiting, found, setting it up, then done as main's view moves", () => {
    expect(installPhase(at({}), 0)).toBe("starting");
    const waiting = at({ stage: "command", command: "curl x | sh", expiresAt: 10_000 });
    expect(installPhase(waiting, 0)).toBe("waiting");
    expect(states(waiting)).toEqual(["waiting:now", "found:next", "connecting:next", "done:next"]);
    const found = at({ stage: "installing", steps: EMPTY_VIEW.steps.map((step, index) => (index === 0 ? { ...step, status: "running" } : step)) });
    expect(installPhase(found, 0)).toBe("found");
    expect(states(found)).toEqual(["waiting:done", "found:now", "connecting:next", "done:next"]);
    const setting = at({ stage: "installing", steps: EMPTY_VIEW.steps.map((step, index) => ({ ...step, status: index < 3 ? "done" : index === 3 ? "running" : "waiting" })) });
    expect(installPhase(setting, 0)).toBe("connecting");
    expect(states(setting)).toEqual(["waiting:done", "found:done", "connecting:now", "done:next"]);
    const linked = at({ stage: "linked", server: SERVER });
    expect(installPhase(linked, 0)).toBe("done");
    expect(states(linked)).toEqual(["waiting:done", "found:done", "connecting:done", "done:done"]);
  });

  it("a line out of time, an error or a failed step stops on the step it reached, for a retry", () => {
    expect(installPhase(at({ stage: "command", command: "x", expiresAt: 5 }), 10)).toBe("expired");
    expect(states(at({ stage: "command", command: "x", expiresAt: 5 }), 10)[0]).toBe("waiting:now");
    const failed = at({ stage: "installing", steps: EMPTY_VIEW.steps.map((step, index) => ({ ...step, status: index === 0 ? "done" : index === 1 ? "failed" : "waiting" })) });
    expect(installPhase(failed, 0)).toBe("failed");
    expect(states(failed)).toEqual(["waiting:done", "found:done", "connecting:now", "done:next"]);
    expect(installPhase(at({ error: "relay down" }), 0)).toBe("failed");
  });
});

describe("connecting by address", () => {
  it("makes main's pairing link from an address and a code", () => {
    expect(pairingLink("bots.example.com", "abcd 2345 efgh")).toEqual({ link: "https://bots.example.com/pair#code=ABCD-2345-EFGH" });
    expect(pairingLink("https://box.tail1234.ts.net/", "")).toEqual({ link: "https://box.tail1234.ts.net" });
    expect(pairingLink("http://127.0.0.1:8790", "ABCD-2345-EFGH")).toEqual({ link: "http://127.0.0.1:8790/pair#code=ABCD-2345-EFGH" });
    // an SSH tunnel typed without its scheme is plain http, not https
    expect(pairingLink("127.0.0.1:8790", "ABCD-2345-EFGH")).toEqual({ link: "http://127.0.0.1:8790/pair#code=ABCD-2345-EFGH" });
    expect(pairingLink("localhost:8790", "")).toEqual({ link: "http://localhost:8790" });
    expect(pairingLink("box.tail1234.ts.net", "")).toEqual({ link: "https://box.tail1234.ts.net" });
    expect(pairingLink("abcd.trycloudflare.com", "")).toEqual({ link: "https://abcd.trycloudflare.com" });
    expect(pairingLink("https://c-12.example.net/pair#code=ABCD-2345-EFGH", "")).toEqual({ link: "https://c-12.example.net/pair#code=ABCD-2345-EFGH" });
  });

  it("refuses what main could not open, naming the field", () => {
    expect(pairingLink("", "")).toEqual({ error: "address" });
    expect(pairingLink("http://10.0.0.5:8799", "")).toEqual({ error: "address" });
    expect(pairingLink("https://intranet", "")).toEqual({ error: "address" });
    expect(pairingLink("https://a.example.com?x=1", "")).toEqual({ error: "address" });
    expect(pairingLink("https://a.example.com", "nope")).toEqual({ error: "code" });
    expect(pairingLink("http://10.0.0.5/pair#code=ABCD-2345-EFGH", "")).toEqual({ error: "address" });
    expect(pairingLink("https://a.example.com/pair#code=nope", "")).toEqual({ error: "address" });
  });

  it("takes the public link out of everything `madanibot pair` printed, pasted as it is", () => {
    const printed = pairingBlock({
      code: "ABCD-2345-EFGH", url: "https://bots.example.com/pair#code=ABCD-2345-EFGH", inviteUrl: "madanibot://pair?address=bots.example.com&token=x",
      localUrl: "http://127.0.0.1:8799/pair#code=ABCD-2345-EFGH", expiresAt: Date.now() + 60_000,
    });
    expect(pairingLink(printed, "")).toEqual({ link: "https://bots.example.com/pair#code=ABCD-2345-EFGH" });
    // a one-line field drops the line breaks of a paste
    expect(pairingLink(printed.replace(/\n/g, ""), "")).toEqual({ link: "https://bots.example.com/pair#code=ABCD-2345-EFGH" });
    expect(pastedPairingLink("open or scan:  https://bots.example.com/pair#code=abcd2345efgh")).toBe("https://bots.example.com/pair#code=ABCD-2345-EFGH");
  });

  it("falls back to a loopback link only when nothing else was pasted", () => {
    expect(pastedPairingLink("http://127.0.0.1:8790/pair#code=ABCD-2345-EFGH")).toBe("http://127.0.0.1:8790/pair#code=ABCD-2345-EFGH");
    expect(pastedPairingLink("https://bots.example.com")).toBeNull();
    expect(pastedPairingLink("pairing code:  ABCD-2345-EFGH")).toBeNull();
  });
});
