import { describe, expect, it } from "vitest";
import { parseSlackOAuthLink, slackAppTokenUrl, SLACK_OAUTH_DEEP_LINK } from "./slack.ts";

const state = "ab".repeat(32);
const link = (query: string) => `${SLACK_OAUTH_DEEP_LINK}?${query}`;

describe("Slack OAuth deep links", () => {
  it("accepts a code and lowercase hex state in either order", () => {
    expect(parseSlackOAuthLink(link(`code=abcD1234._-&state=${state}`))).toEqual({ code: "abcD1234._-", state });
    expect(parseSlackOAuthLink(link(`state=${state}&code=abcdefgh`))).toEqual({ code: "abcdefgh", state });
  });

  it("accepts an error and state", () => {
    expect(parseSlackOAuthLink(link(`error=access_denied&state=${state}`))).toEqual({ error: "access_denied", state });
  });

  it.each([
    undefined, null, {}, 1, "", `https://slack/oauth?code=abcdefgh&state=${state}`,
    `MADANI://slack/oauth?code=abcdefgh&state=${state}`,
    `madanibot://SLACK/oauth?code=abcdefgh&state=${state}`,
    `madanibot://slack/OAuth?code=abcdefgh&state=${state}`,
    `madanibot://slack/oauth/?code=abcdefgh&state=${state}`,
    `madanibot://slack/oauth?code=abcdefgh&state=${state}#fragment`,
    link(`code=abcdefgh&state=${state}#`),
    link(`code=abcdefgh&state=${state}&extra=1`),
    link(`code=abcdefgh&state=${state}&code=ijklmnop`),
    link(`code=abcdefgh&state=${state}&state=${state}`),
    link(`error=denied&error=denied&state=${state}`),
    link(`code=abcdefgh&error=denied&state=${state}`),
    link(`code=abcdefgh&state=${"a".repeat(63)}`),
    link(`code=abcdefgh&state=${"a".repeat(65)}`),
    link(`code=abcdefgh&state=${"A".repeat(64)}`),
    link(`code=abcdefgh&state=${"g".repeat(64)}`),
    link(`code=abc+defgh&state=${state}`),
    link(`code=abc%20defgh&state=${state}`),
    link(`code=abc%0Adefgh&state=${state}`),
    link(`code=abcdefgh%0A&state=${state}`),
    link(`error=denied%0A&state=${state}`),
    link(`code=abcdefgh&state=${state}%0A`),
    link(`code=abc\ndefgh&state=${state}`),
    link(`code=abcdefgh&state=${state}\n`),
    link(`code=short&state=${state}`),
    link(`code=${"a".repeat(257)}&state=${state}`),
    link(`code=${"a".repeat(2048)}&state=${state}`),
    link(`error=Access_denied&state=${state}`),
    link(`error=&state=${state}`),
    link(`error=${"a".repeat(65)}&state=${state}`),
    link(`code=abcdefgh`), link(`state=${state}`),
  ])("refuses malformed callback %#", (value) => {
    expect(parseSlackOAuthLink(value)).toBeNull();
  });

  it("accepts the code and error length boundaries", () => {
    expect(parseSlackOAuthLink(link(`code=${"a".repeat(256)}&state=${state}`))).not.toBeNull();
    expect(parseSlackOAuthLink(link(`error=${"a".repeat(64)}&state=${state}`))).not.toBeNull();
    expect(parseSlackOAuthLink(link(`error=a&state=${state}`))).not.toBeNull();
  });
});

describe("Slack app token settings", () => {
  it("encodes the app id as one path component", () => {
    expect(slackAppTokenUrl("A123")).toBe("https://api.slack.com/apps/A123/general");
    expect(slackAppTokenUrl("A/ ?#")).toBe("https://api.slack.com/apps/A%2F%20%3F%23/general");
  });
});
