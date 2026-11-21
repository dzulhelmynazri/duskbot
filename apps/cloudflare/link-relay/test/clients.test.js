import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import * as agent from "../../../link-service/agent.mjs";
import * as app from "../../../../electron/vps-link-direct.mjs";

describe("the two relay clients", () => {
  it("derive the same bearer from the tunnel key, one the relay's token shape accepts", () => {
    const key = randomBytes(32).toString("base64url");
    const token = agent.relayTokenOf(key, "abcdefghij");
    expect(app.relayTokenOf(key, "abcdefghij")).toBe(token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(agent.relayTokenOf(key, "abcdefghik")).not.toBe(token);
    expect(createHash("sha256").update(token).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dial the same relay, which MADANI_RELAY_URL moves or turns off", () => {
    for (const read of [agent.cloudRelayUrl, app.cloudRelayUrl]) {
      expect(read({})).toBe("https://relay.madani.bot");
      expect(read({ MADANI_RELAY_URL: "https://relay-preview.madani.bot/" })).toBe("https://relay-preview.madani.bot");
      expect(read({ MADANI_RELAY_URL: "off" })).toBeNull();
      expect(read({ MADANI_RELAY_URL: "ftp://x" })).toBeNull();
    }
    expect(agent.AGENT_CAPS).toContain("cloud-relay");
  });

  it("read the relay's text heartbeat and still refuse text where none is expected", () => {
    for (const { wsReader, wsFrame } of [agent, app]) {
      const texts = [];
      wsReader({ masked: false, onData: () => {}, onText: (text) => texts.push(text) })(wsFrame(1, Buffer.from("pong"), false));
      expect(texts).toEqual(["pong"]);
      expect(() => wsReader({ masked: false, onData: () => {} })(wsFrame(1, Buffer.from("pong"), false))).toThrow();
    }
  });
});
