# Purchases, email review and product cards

A purchase (an order, a booking, a subscription, a payment, money sent) waits on a
**Confirm purchase** card at every access level, Full access included. An email a
bot sends through Gmail or Outlook shows as a **Send this email?** card with its
recipients, subject and whole text, which the person can edit before **Send
email**. Product results show as cards in the chat.

## Run

```sh
MADANI_VITEST_WORKERS=2 pnpm exec vitest run shared/purchase.test.ts server/purchase-gate.test.ts server/computer-purchase.test.ts server/gmail-draft-read.test.ts server/routes/purchases.test.ts server/outbound-hold.test.ts src/components/ReviewCards.dom.test.ts
```

## What it checks

- `shared/purchase.test.ts`: which app tools buy (create an order, a payment, a
  booking, a subscription, a transfer) and which do not (reads, refunds,
  cancellations, updates); which button names on which pages are a purchase's
  last step, in several languages, and which only look like one (Add to cart,
  Proceed to checkout, Purchase history, Subscribe outside a checkout); the
  summary masks a full card number; the email review reads Gmail and Outlook
  sends and writes the person's edits where each app reads them.
- `server/purchase-gate.test.ts`: the bots' browser refuses Place order, Buy
  now, Pay and the like (by ref, agent-browser `@ref`, selector or text; Enter
  or a submitting fill on a checkout page; a batch step) until a confirmation,
  which lets exactly one through, is given back when that click fails, lasts ten
  minutes and stays with its own browser session.
- `server/routes/purchases.test.ts`: `confirm_purchase` grants the browser its
  one step only after the person's tap; Cancel leaves the browser refusing;
  "buy without asking" stands only on a quote of the person's own latest
  message, and still posts the card as a record.
- `server/outbound-hold.test.ts`: an app tool that buys waits on Confirm purchase
  at Full access and under a daily allowance; an email at Full access with no
  sending rule waits on its review card, and goes out as the person edited it;
  edits with an address that is not one send nothing; a daily allowance the
  person set still sends on its own.
- `src/components/ReviewCards.dom.test.ts`: the cards as the composer and the
  transcript draw them, on desktop and phone alike (the phone renders the same
  chat): the whole order with Cancel and Confirm purchase and no Always allow;
  the email with Edit and Send email carrying the edits; the record once
  answered; product cards whose photos load only when asked.
- `server/computer-purchase.test.ts`: on a computer (This Mac, a Local VM, a
  cloud computer) each driver bridge reads its screen from the driver's own
  answers (page addresses, window titles, element labels by index) and marks a
  click on Place order or Buy now, a click by point or on an unseen element on a
  checkout or payment screen, and Enter or a typed line break there; the harness
  refuses a marked call until the conversation's purchase is confirmed, for ten
  minutes.
- `server/gmail-draft-read.test.ts`: a Gmail draft sent by id is read first, so
  its card shows the recipients, subject and text that go out.
- A purchase card is reviewed on screen: a spoken yes on a voice call and a 👍
  reaction never confirm one (`shared/purchase.test.ts`).

## Limits

No real shop, checkout page, Gmail or Outlook send is exercised: Composio, the
browser and the computer drivers are stand-ins. A click by point in the bot's
browser is named by the element the page has there; a point inside a payment
frame cannot be named and counts as the last step on a checkout page. On a
computer, labels and page context come from the driver's last answers, read in
the shapes its tree and window lines are expected to take; a click by point is
gated only when the last screen the bot read was a checkout or showed a purchase
button.
