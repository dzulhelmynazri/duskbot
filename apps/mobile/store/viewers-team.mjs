// a made-up team whose chats hold everything the phone opens full screen: code, tables, pictures, links, files and
// cards. stage.ts reads it with MADANI_STAGE_TEAM=./viewers-team.mjs; viewers.ts uploads PICTURES before it looks.

/** stored pictures, uploaded under these ids from apps/mobile/store/art */
export const PICTURES = [
  { id: "0f6c2a3e-6b1d-4c55-9d1e-2b7a1f0c9a01", art: "p-laptop.webp" },
  { id: "0f6c2a3e-6b1d-4c55-9d1e-2b7a1f0c9a02", art: "p-bubbles.webp" },
  { id: "0f6c2a3e-6b1d-4c55-9d1e-2b7a1f0c9a03", art: "p-shield.webp" },
];
const picture = (index, name) => ({ kind: "image", path: `/api/attachments/${PICTURES[index].id}.webp`, mime: "image/webp", name });

const DEPLOY = [
  "```bash",
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "# build, upload and switch the site over in one go",
  "pnpm install --frozen-lockfile && pnpm build --filter @site/web --mode production --sourcemap=false",
  "rsync -az --delete dist/ deploy@web-1.internal:/srv/site/releases/$(date +%Y%m%d%H%M)/",
  "ssh deploy@web-1.internal 'ln -sfn /srv/site/releases/latest /srv/site/current && sudo systemctl reload nginx'",
  "echo \"done\"",
  "```",
].join("\n");

const HOOK = [
  "```tsx",
  "export function useCountdown(until: number) {",
  "  const [left, setLeft] = useState(() => Math.max(0, until - Date.now()));",
  "  useEffect(() => {",
  "    const timer = setInterval(() => setLeft(Math.max(0, until - Date.now())), 1000);",
  "    return () => clearInterval(timer);",
  "  }, [until]);",
  "  return left;",
  "}",
  "```",
].join("\n");

const PLANS = [
  "| Plan | Price | Seats | Storage | Support | Uptime | Notes |",
  "| --- | ---: | ---: | --- | --- | --- | --- |",
  "| Starter | $9 | 1 | 10 GB | Email | 99.5% | Good for trying it out |",
  "| Team | $29 | 5 | 100 GB | Chat | 99.9% | Most teams pick this one |",
  "| Business | $79 | 20 | 1 TB | Phone | 99.95% | Single sign-on and audit log |",
  "| Enterprise | Custom | Unlimited | Unlimited | Named manager | 99.99% | Contract and invoice billing |",
].join("\n");

export const TEAM = [
  {
    name: "Nova", color: "purple", body: "kit", chief: true, pinned: true,
    chat: [
      ["me", "can you send me the deploy script and the countdown hook?", 90],
      ["Nova", `here's the deploy script:\n\n${DEPLOY}\n\nand the hook:\n\n${HOOK}\n\nrun the script from the repo root.`, 89],
      ["me", "compare the plans for me", 60],
      ["Nova", `here they are side by side:\n\n${PLANS}\n\nTeam is the best fit for five people.`, 59],
      ["me", "here are the shots from the shoot", 40, { attachments: [picture(0, "laptop.webp"), picture(1, "bubbles.webp")] }],
      ["Nova", "lovely. i cleaned them up and added the third one you asked for.", 39, { attachments: [picture(0, "laptop-edit.webp"), picture(1, "bubbles-edit.webp"), picture(2, "shield.webp")] }],
      ["me", "where did you read about the pricing?", 20],
      ["Nova", "mostly from [Stripe's pricing guide](https://stripe.com/guides/pricing) and the [Linear changelog](https://linear.app/changelog). the code is at https://github.com/vercel/next.js too.", 19],
    ],
  },
  {
    name: "Pip", color: "blue", body: "pip", pinned: true,
    chat: [
      ["me", "send me the launch files", 50],
      ["Pip", "here they are: the report, the numbers and the landing page.", 49, { attachments: [
        { kind: "file", path: "launch/report.pdf", mime: "application/pdf", name: "report.pdf", bytes: 1_843_200 },
        { kind: "file", path: "launch/numbers.csv", mime: "text/csv", name: "numbers.csv", bytes: 14_336 },
        { kind: "file", path: "launch/landing.html", mime: "text/html", name: "landing.html" },
        { kind: "file", path: "launch/notes.md", mime: "text/markdown", name: "notes.md" },
      ] }],
      ["me", "post the update to the team", 30],
      ["Pip", "", 29, { kind: "connector", connector: { slug: "slack", label: "Slack", description: "post the launch update to #launch", status: "required", resumeKey: "viewers-slack" } }],
      ["Pip", "", 28, { kind: "options", card: { title: "Which channel should I post in?", subtitle: "", options: ["#launch", "#general", "#marketing"], requestType: "question", requestId: "viewers-ask" } }],
      ["Pip", "Morning brief failed.", 20, { kind: "routine.run", routineRun: { runId: "viewers-run", routineId: "viewers-routine", routineName: "Morning brief", status: "failed", error: "Gmail needs you to sign in again." } }],
      ["me", "and check the numbers again", 4],
      ["Pip", "", 3, { kind: "activity", tool: { name: "error: The reply timed out.", ok: false, reason: "timeout" } }],
    ],
  },
  {
    name: "Echo", color: "pink", body: "mochi", pinned: true,
    chat: [
      ["me", "reply to Maya and say we'll take the flat", 3],
    ],
    approval: {
      tool: "mcp__gmail__send_an_email",
      title: "Send an email",
      subtitle: "To maya@harbourlets.com\n\nHi Maya, we'd love to take the flat. Could we move in on the 1st?",
    },
  },
];

export const ROOM = {
  name: "Launch room",
  members: ["Nova", "Echo", "Pip"],
  chat: [
    ["me", "where are we on the launch?", 22],
    ["Nova", "copy is done, Echo is lining up the emails.", 21],
  ],
};

export const ROUTINES = [];
