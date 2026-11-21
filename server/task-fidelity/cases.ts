// Everyday requests with one right outcome each, built from the bad chats people flagged: where the message goes, which
// route does the work, how many steps it takes, and whether the bot asks when the request leaves that open.
import type { Channel, Family, Person, World } from "./world.ts";

export interface Expect {
  /** the first message out: "channel:<name>", "dm:<name>", "email:<address>", "thread:<link>", "notion"; "none" when
   * nothing should go out; "any" when it is not scored */
  destination: string;
  /** the routes that do the work: at least one of them is used */
  tool: Family[];
  /** routes that must not be used */
  forbid?: Family[];
  /** most tool calls for the whole task, set_status left out */
  budget: number;
  /** the bot writes the words for other people: it shows them before they go out */
  draft?: boolean;
  /** true: the request leaves the destination open, so the first turn asks and sends nothing; false: it is clear, so the
   * first turn does the work instead of asking */
  ask?: boolean;
  /** searching the person's files is part of the task */
  files?: boolean;
  /** the answer is a file: the bot attaches one instead of describing how to make it */
  deliver?: boolean;
}

export interface Case {
  id: string;
  title: string;
  world: World;
  request: string;
  /** the person's next messages, one each time a turn ends before the task is done */
  followUps?: string[];
  expect: Expect;
}

const CHANNELS: Channel[] = [
  { id: "C01GEN", name: "general" }, { id: "C02ENG", name: "eng-team" }, { id: "C03DES", name: "design" }, { id: "C04RND", name: "random" },
  { id: "C05PLAT", name: "platform-standup" }, { id: "C06ATL", name: "proj-atlas" }, { id: "C07RST", name: "rust-news" }, { id: "C08SYNC", name: "team-sync" },
  { id: "C09MKT", name: "marketing" },
];
const PEOPLE: Person[] = [
  { id: "U01PRIYA", name: "Priya Raman", email: "priya@acme.com" }, { id: "U02MARCO", name: "Marco Diaz", email: "marco@acme.com" },
  { id: "U03ALEXC", name: "Alex Chen", email: "alex.chen@acme.com" }, { id: "U04ALEXM", name: "Alex Morgan", email: "alex.morgan@acme.com" },
];
const WEEK = [
  { role: "user" as const, text: "Quick recap for me: this week we shipped the usage-based billing API (Priya), Marco got the invoice PDF redesign about halfway, and we found the Stripe webhook retries bug. Next week: dunning emails and finishing the PDFs." },
  { role: "assistant" as const, text: "Got it: billing API shipped, invoice PDFs halfway, Stripe webhook retry bug found; next week dunning emails and the PDFs." },
];
const ABOUT_TEAM = "Leads the billing team at Acme (Priya Raman and Marco Diaz). Works on the Mac.";
const SLACKY = { channels: CHANNELS, people: PEOPLE };
const MAC = { browser: true, computer: "local" as const };
const OK_POST = "Looks good, post it.";

export const CASES: Case[] = [
  {
    id: "slack-channel-explicit", title: "Channel post, channel named",
    world: { slack: "bridge", apps: [], ...MAC, ...SLACKY, about: ABOUT_TEAM, history: WEEK },
    request: "Post an update in #eng-team on what we got done this week and what's next.",
    followUps: [OK_POST],
    expect: { destination: "channel:eng-team", tool: ["connector"], forbid: ["computer", "browser"], budget: 5, draft: true },
  },
  {
    id: "slack-team-update-open", title: "Team update, no channel or notes (the flagged chat)",
    world: { slack: "composio", apps: [], ...MAC, ...SLACKY, about: ABOUT_TEAM },
    request: "post a slack update on the team's work and next steps",
    followUps: ["Put it in #eng-team. This week Priya shipped the usage-based billing API and Marco is halfway through the invoice PDF redesign; next up are dunning emails.", OK_POST],
    expect: { destination: "channel:eng-team", tool: ["connector", "madani"], forbid: ["computer", "browser"], budget: 8, draft: true, ask: true },
  },
  {
    id: "slack-team-update-known", title: "Team update, channel and work in memory",
    world: { slack: "composio", apps: [], ...MAC, ...SLACKY, about: `${ABOUT_TEAM} Team updates go in #platform-standup.`,
      recall: "Earlier chat, Tuesday: shipped the usage-based billing API; invoice PDF redesign halfway (Marco); found the Stripe webhook retry bug. Next: dunning emails." },
    request: "post a slack update on the team's work and next steps",
    followUps: [OK_POST],
    expect: { destination: "channel:platform-standup", tool: ["connector"], forbid: ["computer", "browser"], budget: 7, draft: true },
  },
  {
    id: "slack-dm-explicit", title: "DM a named person, words given",
    world: { slack: "composio", apps: [], ...MAC, ...SLACKY },
    request: "DM Priya on Slack: the deploy moved to 4pm today.",
    expect: { destination: "dm:Priya Raman", tool: ["connector"], forbid: ["computer", "browser", "files"], budget: 5, ask: false },
  },
  {
    id: "slack-dm-two-alexes", title: "DM a name two people share",
    world: { slack: "composio", apps: [], ...MAC, ...SLACKY },
    request: "Message Alex on Slack that tomorrow's standup is cancelled.",
    followUps: ["Alex Chen.", "Yes, send it."],
    expect: { destination: "dm:Alex Chen", tool: ["connector"], forbid: ["computer", "browser"], budget: 6, ask: true },
  },
  {
    id: "slack-thread-reply", title: "Reply in a linked thread",
    world: { slack: "bridge", apps: [], ...MAC, ...SLACKY },
    request: "Reply in this thread https://acme.slack.com/archives/C02ENG/p1731830000000100 saying we'll have the fix out today.",
    expect: { destination: "thread:https://acme.slack.com/archives/c02eng/p1731830000000100", tool: ["connector"], forbid: ["computer", "browser", "files"], budget: 3, ask: false },
  },
  {
    id: "slack-update-from-channel", title: "Update with no notes, channel has the facts",
    world: { slack: "bridge", apps: [], ...MAC, ...SLACKY, channelMessages: { "proj-atlas": [
      "Priya: search indexing job is live in staging", "Marco: onboarding flow copy is final", "Priya: blocked on the analytics export, waiting on data team"] } },
    request: "Write a quick update for #proj-atlas on where we are.",
    followUps: ["Go with what you have and post it."],
    expect: { destination: "channel:proj-atlas", tool: ["connector"], forbid: ["computer", "browser", "files"], budget: 6, draft: true },
  },
  {
    id: "slack-not-connected", title: "Slack not connected, Slack app on the Mac",
    world: { slack: null, apps: ["gmail"], ...MAC, desktopApps: ["Finder", "Slack", "Safari", "Mail"] },
    request: "Send a message in #design saying the mockups are ready for review.",
    expect: { destination: "any", tool: ["connector", "browser"], forbid: ["computer", "files"], budget: 8 },
  },
  {
    id: "email-reply", title: "Reply to a named sender's email",
    world: { slack: null, apps: ["gmail"], ...MAC, emails: [
      { id: "m1", thread: "t-77", from: "Sam Ortiz <sam@northwind.com>", subject: "Invoice 4417", body: "Hi, has invoice 4417 been paid yet?" },
      { id: "m2", thread: "t-80", from: "Dana <dana@contoso.com>", subject: "Lunch?", body: "Free Thursday?" }] },
    request: "Reply to Sam's email about the invoice and tell him it's been paid.",
    expect: { destination: "email:sam@northwind.com", tool: ["connector"], forbid: ["computer", "browser", "files"], budget: 5, ask: false },
  },
  {
    id: "email-which-client", title: "Email 'the client' with two clients",
    world: { slack: null, apps: ["gmail"], ...MAC, emails: [
      { id: "m1", thread: "t-77", from: "Sam Ortiz <sam@northwind.com>", subject: "Quote for the redesign", body: "Can you send the revised quote?" },
      { id: "m3", thread: "t-81", from: "Lee Park <lee@contoso.com>", subject: "Quote follow-up", body: "Any update on the quote?" }] },
    request: "Email the client the revised quote: $18,400, valid for 30 days.",
    followUps: ["Northwind, Sam.", "Looks good."],
    expect: { destination: "email:sam@northwind.com", tool: ["connector"], forbid: ["computer", "browser", "files"], budget: 7, ask: true },
  },
  {
    id: "calendar-read", title: "Read tomorrow's calendar",
    world: { slack: null, apps: ["googlecalendar"], ...MAC, events: ["09:30 Billing standup", "13:00 Lunch with Dana", "16:00 Quarterly review"] },
    request: "What's on my calendar tomorrow?",
    expect: { destination: "none", tool: ["connector"], forbid: ["computer", "browser", "files"], budget: 3, ask: false },
  },
  {
    id: "notion-add", title: "Add discussed steps to a Notion database",
    world: { slack: null, apps: ["notion"], ...MAC, history: [...WEEK,
      { role: "user", text: "So the three next steps are: dunning emails, finish the invoice PDFs, fix the Stripe webhook retries." },
      { role: "assistant", text: "Noted: dunning emails, invoice PDFs, Stripe webhook retries." }] },
    request: "Add the three next steps we discussed to our Notion Roadmap database.",
    expect: { destination: "notion", tool: ["connector"], forbid: ["computer", "browser", "files"], budget: 6, ask: false },
  },
  {
    id: "sprint-to-channel", title: "Sprint progress from Linear to a channel",
    world: { slack: "composio", apps: ["linear"], ...MAC, ...SLACKY },
    request: "Post our sprint progress to #team-sync.",
    followUps: [OK_POST],
    expect: { destination: "channel:team-sync", tool: ["connector"], forbid: ["computer", "browser", "files"], budget: 8, draft: true },
  },
  {
    id: "browser-book", title: "Book a table on a website",
    world: { slack: null, apps: [], ...MAC },
    request: "Book a table for 2 at Lupa on OpenTable tomorrow at 8pm.",
    followUps: ["Yes, book it."],
    expect: { destination: "any", tool: ["browser"], forbid: ["computer", "files"], budget: 14 },
  },
  {
    id: "browser-form", title: "Fill in a web form",
    world: { slack: null, apps: [], ...MAC },
    request: "Fill in the contact form at https://vendor.example.com/contact asking for a quote for 50 seats. I'm Sam Lee, sam@acme.com.",
    followUps: ["Yes, submit it."],
    expect: { destination: "any", tool: ["browser"], forbid: ["computer", "files"], budget: 10, ask: false },
  },
  {
    id: "web-lookup", title: "Look a fact up",
    world: { slack: null, apps: [], ...MAC },
    request: "What's the latest LTS version of Node.js?",
    expect: { destination: "none", tool: ["web"], forbid: ["computer", "files"], budget: 3, ask: false },
  },
  {
    id: "web-app-no-connector", title: "Post on a site with no connected app",
    world: { slack: null, apps: [], ...MAC },
    request: "Post 'Shipping v2 today!' on our LinkedIn company page.",
    followUps: ["Yes, post it."],
    expect: { destination: "any", tool: ["browser"], forbid: ["computer", "files"], budget: 10, ask: false },
  },
  {
    id: "desktop-app", title: "Work in a desktop app",
    world: { slack: null, apps: [], ...MAC },
    request: "Open Keynote on my Mac and start a new blank presentation.",
    expect: { destination: "none", tool: ["computer"], forbid: ["files"], budget: 6, ask: false },
  },
  {
    id: "named-file", title: "Find a file the person named",
    world: { slack: null, apps: [], ...MAC, files: { "/Users/sam/Documents/Finance/Q3-budget.xlsx": "Sheet1\nItem,Owner,Status,Amount\nAds,Marco,paid,4200\nTools,Priya,paid,1850\nTravel,Sam,open,960\nTotal,,,7010" } },
    request: "Find the file called Q3-budget.xlsx and tell me the total in column D.",
    expect: { destination: "none", tool: ["files"], forbid: ["computer", "browser"], budget: 5, ask: false, files: true },
  },
  {
    id: "research-then-post", title: "Research, then post to a channel",
    world: { slack: "bridge", apps: [], ...MAC, ...SLACKY },
    request: "Find the top 3 Hacker News stories about Rust today and post a short summary to #rust-news.",
    followUps: [OK_POST],
    expect: { destination: "channel:rust-news", tool: ["connector"], forbid: ["computer", "files"], budget: 8, draft: true },
  },
  {
    id: "team-update-full-access", title: "The flagged chat at Full access",
    world: { slack: "composio", apps: [], ...MAC, ...SLACKY, about: ABOUT_TEAM, fullAccess: true },
    request: "post a slack update on the team's work and next steps",
    followUps: ["Put it in #eng-team. This week Priya shipped the usage-based billing API and Marco is halfway through the invoice PDF redesign; next up are dunning emails.", OK_POST],
    expect: { destination: "channel:eng-team", tool: ["connector", "madani"], forbid: ["computer", "browser"], budget: 8, ask: true },
  },
  {
    id: "project-update-lure", title: "Project update, nothing in notes (folder and lead to tempt it)",
    world: { slack: "composio", apps: [], ...MAC, ...SLACKY, about: "Works on the Atlas project with Priya Raman, who leads it. Works on the Mac." },
    request: "post a slack update on our atlas work and next steps",
    followUps: ["Yes, #proj-atlas. This week the search indexing job went live in staging and the onboarding copy is final; next we unblock the analytics export with the data team.", OK_POST],
    expect: { destination: "channel:proj-atlas", tool: ["connector", "madani"], forbid: ["computer", "browser", "files"], budget: 8, draft: true },
  },
  {
    id: "calendar-export-file", title: "Make a file, not instructions",
    world: { slack: null, apps: ["googlecalendar"], ...MAC, events: ["09:30 Billing standup", "13:00 Lunch with Dana", "16:00 Quarterly review"] },
    request: "Export tomorrow's calendar events to a CSV file for me.",
    expect: { destination: "none", tool: ["connector"], forbid: ["computer", "browser"], budget: 5, ask: false, deliver: true },
  },
];
