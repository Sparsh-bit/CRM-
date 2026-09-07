/**
 * Regression test for the bug found and fixed while building Phase 5 SMS
 * (src/worker/sender.ts): sendDueMessages's `if (!r)` check never caught a
 * blocked send because the governor's "try again later" return value is a
 * Date object, which is always truthy — so a message blocked by a mailbox's
 * daily cap or a WhatsApp instance's minimum gap was incorrectly counted as
 * sent, scheduleFollowUp ran for a message nothing was sent for, and the
 * lead was marked "contacted" regardless. Pre-existing in the email/WhatsApp
 * path since before this project's Phase 0; the fix (`r !== true` instead of
 * `!r`) applies to all three channels — this proves email and WhatsApp
 * specifically, since scripts/sms-test.ts already proves it for sms.
 *
 * Real Postgres, external HTTP mocked. Run via `npm run sender:test`.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { encrypt } from '../src/lib/crypto';
import { localDay } from '../src/lib/scheduler';
import { sendDueMessages } from '../src/worker/sender';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

const realFetch = global.fetch;
function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  // @ts-expect-error - test double
  global.fetch = async (url: string) => handler(url);
}
function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

// Always-open window, matching sms-test.ts, so only the governor condition under test can block.
const OPEN_WINDOW = { sendStartHour: 0, sendEndHour: 24, sendDays: [0, 1, 2, 3, 4, 5, 6] };

async function main() {
  const ws = await db.workspace.create({ data: { name: 'Sender Governor Test', slug: 'sender-gov-' + Date.now() } });

  try {
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'L' } });
    const lead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'L', email: 'l@test.local', phone: '+15550002', status: 'new' } });

    // ── email: a mailbox at its daily cap must not be misreported as sent ──
    const mailbox = await db.mailbox.create({
      data: { workspaceId: ws.id, label: 'MB', fromName: 'F', fromEmail: 'f@test.local', provider: 'resend', apiKeyEnc: encrypt('k'), dailyLimit: 1, warmupEnabled: false, sentToday: 1, sentTodayDate: localDay('Asia/Kolkata') },
    });
    const emailCampaign = await db.campaign.create({ data: { workspaceId: ws.id, listId: list.id, name: 'E', channel: 'email', ...OPEN_WINDOW } });
    await db.campaignStep.create({ data: { campaignId: emailCampaign.id, order: 1, body: 'hi', delayDays: 1 } });
    await db.campaignStep.create({ data: { campaignId: emailCampaign.id, order: 2, body: 'follow up', delayDays: 1 } });
    await db.message.create({ data: { workspaceId: ws.id, campaignId: emailCampaign.id, leadId: lead.id, channel: 'email', stepOrder: 1, toAddress: lead.email!, body: 'hi', trackingId: 'trk-email-' + Date.now(), status: 'queued' } });

    mockFetch(() => jsonResponse({ id: 'should-not-be-called' })); // if this fires, the mailbox cap was not enforced
    const emailResult = await sendDueMessages(ws.id);
    check('a capped mailbox reports zero sent, not a false positive', emailResult.sent, 0);
    check('a capped mailbox reports the message still pending', emailResult.pending, 1);
    check('the blocked message stays queued', (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status, 'new');
    check('scheduleFollowUp did not fire for a message nothing was sent for', await db.message.count({ where: { campaignId: emailCampaign.id, stepOrder: 2 } }), 0);
    await db.message.deleteMany({ where: { campaignId: emailCampaign.id } });

    // ── whatsapp: an instance inside its minimum gap must not be misreported as sent ──
    const wa = await db.waInstance.create({
      data: { workspaceId: ws.id, label: 'WA', instanceName: 'wa-gov-test-' + Date.now(), status: 'connected', minGapSeconds: 999_999, lastSentAt: new Date() },
    });
    const waCampaign = await db.campaign.create({ data: { workspaceId: ws.id, listId: list.id, name: 'W', channel: 'whatsapp', ...OPEN_WINDOW } });
    await db.campaignStep.create({ data: { campaignId: waCampaign.id, order: 1, channel: 'whatsapp', body: 'hi', delayDays: 1 } });
    await db.campaignStep.create({ data: { campaignId: waCampaign.id, order: 2, channel: 'whatsapp', body: 'follow up', delayDays: 1 } });
    await db.message.create({ data: { workspaceId: ws.id, campaignId: waCampaign.id, leadId: lead.id, channel: 'whatsapp', stepOrder: 1, toAddress: lead.phone!, body: 'hi', trackingId: 'trk-wa-' + Date.now(), status: 'queued' } });

    mockFetch(() => jsonResponse({ key: { id: 'should-not-be-called' } }));
    const waResult = await sendDueMessages(ws.id);
    check('a throttled WhatsApp instance reports zero sent, not a false positive', waResult.sent, 0);
    check('scheduleFollowUp did not fire for the WhatsApp message either', await db.message.count({ where: { campaignId: waCampaign.id, stepOrder: 2 } }), 0);
    await db.message.deleteMany({ where: { campaignId: waCampaign.id } });

    // ── smoke: a genuinely sendable email still sends correctly after the fix ──
    await db.mailbox.update({ where: { id: mailbox.id }, data: { dailyLimit: 50, sentToday: 0, sentTodayDate: null } });
    await db.message.create({ data: { workspaceId: ws.id, campaignId: emailCampaign.id, leadId: lead.id, channel: 'email', stepOrder: 1, toAddress: lead.email!, body: 'hi', trackingId: 'trk-email-ok-' + Date.now(), status: 'queued' } });
    mockFetch(() => jsonResponse({ id: 'resend-ok-1' }));
    const okResult = await sendDueMessages(ws.id);
    check('an unblocked email still sends correctly after the fix', okResult.sent, 1);
    check('a real send still marks the lead contacted', (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status, 'contacted');
    check('a real send still schedules the follow-up step', await db.message.count({ where: { campaignId: emailCampaign.id, stepOrder: 2 } }), 1);

    console.log('\nall sender governor checks completed');
  } finally {
    global.fetch = realFetch;
    await db.workspace.delete({ where: { id: ws.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall sender governor regression tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
