// the store screenshot set, in the order the stores show it. `screen` names a capture from capture.ts; `bg` is "white",
// "meadow" or "madani"; `art` stands on the phone's top edge: bots as [body, colour, across, scale], a prop as [file in art/, across].

export const SHOTS = [
  {
    id: "01-team", screen: "home", bg: "meadow", dark: false,
    headline: "your ai team,\nin your pocket.",
    line: "a crew of bots that work for you. text them from anywhere.",
    art: { bots: [["loaf", "tangerine", 0.24], ["kit", "violet", 0.5, 1.25], ["mochi", "pinkBot", 0.76]] },
  },
  {
    id: "02-text", screen: "chat-nova", bg: "white", dark: false,
    headline: "text them\nlike friends.",
    line: "no prompts to learn. say what you need, the way you'd say it.",
    art: { prop: ["s-phone", 0.72], bots: [["kit", "violet", 0.3]] },
  },
  {
    id: "03-work", screen: "chat-pip", bg: "white", dark: false,
    headline: "they do the\nactual work.",
    line: "your bots open the browser, click around and get it booked.",
    art: { prop: ["s-computer", 0.7], bots: [["pip", "blue", 0.32]] },
  },
  {
    id: "04-approve", screen: "chat-echo", bg: "white", dark: false,
    headline: "say yes from\nanywhere.",
    line: "anything that matters waits for your ok. one tap and it's done.",
    art: { prop: ["s-button", 0.3], bots: [["mochi", "pinkBot", 0.68]] },
  },
  {
    id: "05-sleep", screen: "routines-dark", bg: "madani", dark: true,
    headline: "they work\nwhile you sleep.",
    line: "set a routine once. wake up to a clear inbox and your brief ready.",
    art: { prop: ["p-laptop", 0.7], bots: [["cheep", "sun", 0.26], ["bruin", "mint", 0.42]] },
  },
  {
    id: "06-rooms", screen: "room", bg: "white", dark: false,
    headline: "group chats,\nwith bots in them.",
    line: "put a few bots in one room and they split the work.",
    art: { prop: ["p-bubbles", 0.72], bots: [["kit", "violet", 0.24], ["pip", "blue", 0.38], ["cheep", "sun", 0.52]] },
  },
  {
    id: "07-apps", screen: "apps", bg: "white", dark: false,
    headline: "plugged into\nyour apps.",
    line: "gmail, calendar, notion, github and lots more. they use them like you do.",
    art: { prop: ["s-plug", 0.3], bots: [["goo", "mint", 0.7]] },
  },
  {
    id: "08-cloud", screen: "home-dark", bg: "white", dark: true,
    headline: "on 24/7 with\nmadani cloud.",
    line: "close your laptop. your bots keep going on a computer of their own.",
    art: { prop: ["s-clock", 0.68], bots: [["boo", "cyan", 0.3]] },
  },
  {
    id: "09-private", screen: "pair", bg: "white", dark: true,
    headline: "private,\nand yours.",
    line: "your bots live on your own computer or your madani cloud. no ads, no tracking.",
    art: { prop: ["p-shield", 0.3], bots: [["bruin", "tangerine", 0.7]] },
  },
  {
    id: "10-models", screen: "profile", bg: "meadow", dark: false,
    headline: "works with the ai\nyou already use.",
    line: "bring the model you like and pick one for each bot.",
    art: { bots: [["hop", "coral", 0.24], ["kit", "violet", 0.4], ["goo", "mint", 0.6], ["pip", "blue", 0.76, 1.1]] },
  },
];

/** the App Store set leaves out what iOS v1 does not offer or must not advertise: madani cloud (sold on the web, 3.1.1),
 * other companies' apps and AI models (5.2.1, 2.3.7), and the pairing screen, which names madani cloud */
export const IOS_SHOTS = ["01-team", "02-text", "03-work", "04-approve", "05-sleep", "06-rooms"];

/** Google Play takes eight phone screenshots at most */
export const PLAY_SHOTS = ["01-team", "02-text", "03-work", "04-approve", "05-sleep", "07-apps", "08-cloud", "09-private"];

export const SIZES = [
  { store: "ios", name: "6.9", width: 1320, height: 2868 },
  { store: "ios", name: "6.5", width: 1284, height: 2778 },
  { store: "play", name: "phone", width: 1080, height: 1920 },
];

export const FEATURE = {
  headline: "your ai team,\nin your pocket.",
  line: "text your bots from anywhere.",
};
