import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BotAvatar,
  MausAvatar,
  resolveBotAvatarOutcome,
  type BotAvatarProps,
  type MausAvatarProps,
} from "./Avatar";

const attr = (markup: string, name: string) => markup.match(new RegExp(`data-${name}="([^"]+)"`))?.[1];
const bodyOf = (markup: string) => attr(markup, "body");

const render = (props: Partial<MausAvatarProps>) =>
  renderToStaticMarkup(createElement(MausAvatar, { color: "green", animated: false, ...props }));

const renderBot = (bot: Partial<BotAvatarProps["bot"]>) =>
  renderToStaticMarkup(
    createElement(BotAvatar, { bot: { color: "green", ...bot }, animated: false }),
  );

describe("MausAvatar body", () => {
  it("wears kit when no body is given", () => {
    expect(bodyOf(render({}))).toBe("kit");
  });

  it("wears the body it is given, drawing an older body as the one it moved to", () => {
    expect(bodyOf(render({ bodyId: "starry" }))).toBe("starry");
    expect(bodyOf(render({ bodyId: "cursor" }))).toBe("kit");
    expect(bodyOf(render({ bodyId: "flower" }))).toBe("sprout");
    expect(bodyOf(render({ bodyId: "teardrop" }))).toBe("drip");
    expect(bodyOf(render({ bodyId: "squircle" }))).toBe("loaf");
  });

  it("falls back to kit for an unknown body", () => {
    // SAFETY: "hexagram" is deliberately not a body id, to exercise the runtime fallback for persisted or streamed data.
    expect(bodyOf(render({ bodyId: "hexagram" as MausAvatarProps["bodyId"] }))).toBe("kit");
  });

  it("paints the body with the bot's electric colour", () => {
    expect(attr(render({ bodyId: "pip", color: "blue" }), "colour")).toBe("#286ef9");
  });

  it("draws the face of the state it rests in", () => {
    expect(render({ state: "sleeping" })).toContain('data-state="sleeping"');
    expect(render({ state: "streaming" })).toContain('data-pixel-state="working"');
    expect(render({ state: "failed" })).toContain('data-pixel-state="error"');
  });
});

describe("mascot facial feature colors", () => {
  it.each(["white", "black"] as const)("uses %s for the eyes on every pixel body", (mascotFaceColor) => {
    const ink = mascotFaceColor === "white" ? "#ffffff" : "#000000";
    for (const mascotBody of ["cursor", "starry"] as const) {
      for (const color of ["green", "chrome"] as const) expect(attr(renderBot({ color, mascotBody, mascotFaceColor }), "eyes")).toBe(ink);
    }
  });

  it("draws the eyes white when no face ink is chosen", () => {
    for (const bot of [{ color: "chrome" as const, mascotFaceColor: null }, {}]) expect(attr(renderBot(bot), "eyes")).toBe("#fff");
  });

  it("draws a bot saved in a costume as its pixel body, white eyes and all", () => {
    const markup = renderBot({ mascotBody: "pumpkin" });
    expect(attr(markup, "body")).toBe("pip");
    expect(attr(markup, "eyes")).toBe("#fff");
    expect(markup).not.toContain("<svg");
  });

  it("does not paint features over an uploaded image", () => {
    const markup = renderBot({ mascotFaceColor: "black", avatarUrl: "/api/attachments/photo.png", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("data-madani-mark");
  });
});

describe("BotAvatar's two avatar outcomes", () => {
  it("zooms and positions a custom image inside its crop", () => {
    const markup = renderBot({
      avatarUrl: "/api/attachments/cat.webp",
      avatarCrop: "circle",
      avatarZoom: 2,
      avatarFocusX: 0.25,
      avatarFocusY: 0.75,
    });
    expect(markup).toContain("scale(2)");
    expect(markup).toContain("25% 75%");
    expect(markup).toContain("border-radius:50%");
  });

  it("renders a flat cropped image for circle/rounded/square, with no mascot at all", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  it("shows the image as it is, with no mascot face painted on it", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "square" });
    expect(markup).toContain("border-radius:0");
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<image");
    expect(markup).not.toContain("radialGradient");
  });

  it("renders the gradient mascot when the crop is mascot, image or not", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "mascot" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("data-madani-mark");
  });

  it("falls back to the gradient mascot when a flat crop has no valid image", () => {
    const markup = renderBot({ avatarUrl: undefined, avatarCrop: "circle" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("data-madani-mark");
  });
});

describe("resolveBotAvatarOutcome", () => {
  // imageFailed is set by the <img>'s onError, which renderToStaticMarkup never fires, so the decision is a pure
  // function.
  it("falls back to the gradient mascot for an image that failed to load", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "circle", hasUrl: true, imageFailed: true }),
    ).toBe("gradientMascot");
  });

  it("renders a good flat image flat", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "rounded", hasUrl: true, imageFailed: false }),
    ).toBe("flatImage");
  });

  it("keeps the mascot crop on the gradient mascot even with a loaded image", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "mascot", hasUrl: true, imageFailed: false }),
    ).toBe("gradientMascot");
  });

  it("falls back to the gradient mascot when there is no image at all", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "square", hasUrl: false, imageFailed: false }),
    ).toBe("gradientMascot");
  });
});
