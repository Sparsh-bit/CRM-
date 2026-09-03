# 05 — QA, deliverability and launch

## Test plan

**Unit (shipped, runnable now)**

```
npx tsx scripts/template-test.ts    # 12 assertions — merge tags, filters, fallbacks, spintax collision
npx tsx scripts/mapping-test.ts     # 18 assertions — header heuristics, honorifics, role placeholders, phones
npx tsx scripts/import-test.ts samples/Outreach_Kit_Tier13.xlsx
```

**Unit (to add)**

- Governor: warmup ramp across a date boundary; midnight reset in a non-UTC
  timezone; jitter stays inside its bound; a mailbox at cap is skipped, not blocked.
- Preflight: each blocker type produces exactly one issue, names the company,
  and states the fix.
- Sentinel round-trip: a merge value containing `{a|b}` survives spintax.

**Integration**

- Import → campaign → preflight → launch → worker send, against MailHog or a
  Resend test key. Assert one Message row per lead per step per channel.
- Kill the worker mid-campaign. Restart. Assert zero duplicate sends.
- Unsubscribe mid-campaign. Assert every queued message for that lead, on every
  channel, becomes `skipped`.
- Reply webhook from Evolution. Assert the sequence stops for that lead only.

**Manual, before charging anyone**

- Send yourself one email from each of the four providers. Check the raw source
  for: List-Unsubscribe, List-Unsubscribe-Post, a working pixel, rewritten
  links, and a physical address.
- Click every link in a sent email, including the unsubscribe, from a fresh browser.
- Render the email in Gmail, Outlook web, Outlook desktop and iOS Mail.

## Deliverability checklist — the pre-sale gate

Nothing here is optional. A tool that burns a customer's domain does not get a
second customer.

- [ ] Sending domain is a **secondary** domain, not the company's primary one.
- [ ] SPF, DKIM and DMARC all pass. DMARC starts at `p=none` and tightens.
- [ ] Domain and mailbox are at least 2 weeks old before any cold send.
- [ ] Warmup ramp is on: 10/day, +5/day, to a ceiling of 30–50 per mailbox.
- [ ] Minimum 90 seconds between sends, plus jitter. Never a fixed interval.
- [ ] Sending window matches the recipients' working hours, not the sender's.
- [ ] Bounce rate stays under 3%. Above that, stop and clean the list.
- [ ] Complaint rate stays under 0.1%.
- [ ] Every email has a working one-click unsubscribe and a physical address.
- [ ] Tracking domain is per-customer, not shared.
- [ ] No link shorteners, no attachments, no image-only emails.
- [ ] Lists are verified before the first send, not after the first bounce spike.

## WhatsApp, stated honestly

The Evolution/Baileys transport is an **unofficial WhatsApp Web client**. It is
convenient and it is against WhatsApp's terms of service. Numbers used for cold
outreach get banned, sometimes within a day. Several jurisdictions also treat
unsolicited commercial WhatsApp messages as a regulatory matter, not just a
platform one.

What the product must therefore do, and does:
- say this in the UI at the point of connecting a number;
- default to low caps and long gaps;
- honour opt-out on WhatsApp exactly as it does on email;
- offer the official Meta Cloud API as the compliant path for customers who need
  scale (approved templates, 80 msg/s, a real business account).

Do not market this as "WhatsApp blasting". The customers that phrase attracts are
the ones who will get your Evolution infrastructure blocklisted.

## Go-to-market

The wedge is the import experience. Every competitor makes a user configure a
mapping wizard; this one reads their file. Lead with a 30-second video: drag in
a messy four-sheet workbook, watch 68 leads and their research columns appear,
click generate, read three drafts that each say something true about a different
business.

The second hook is WhatsApp at entry price. In the Gulf, India and SEA it is
where replies actually happen, and no competitor includes it below their
mid-tier.

First 10 customers: agencies already running cold email who are paying
Smartlead or Instantly and want WhatsApp too. Offer to migrate their lists —
which is a five-minute demo of the thing you are best at.
