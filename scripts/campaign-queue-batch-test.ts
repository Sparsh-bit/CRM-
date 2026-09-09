/**
 * Regression test for buildQueue()'s N+1 fix (src/lib/campaign.ts) found in
 * a production-reliability audit: the old version did up to 3 sequential
 * DB round trips PER LEAD PER CHANNEL (findFirst, create, lead.update)
 * inside a plain loop, all awaited inline in the campaign-launch Server
 * Action — a real request-timeout risk against this app's own quota-
 * supported list sizes (up to 500k leads on the pro plan). Fixed by
 * batching: one upfront existing-message fetch, one createMany, one
 * updateMany — same per-lead decision logic (suppression, unsubscribed,
 * missing/invalid contact info, per-channel expansion for "both"), same
 * external contract (same return shape, same dedup-safety on a rerun).
 * Real Postgres; throwaway workspace deleted in the finally block.
 * Run via `npm run campaign-queue-batch:test`.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildQueue } from '../src/lib/campaign';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

async function main() {
  const ws = await db.workspace.create({ data: { name: 'Queue Batch Test', slug: 'queue-batch-' + Date.now() } });

  try {
    const list = await db.leadList.create({ data: { workspaceId: ws.id, name: 'L' } });

    const normal = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Normal', email: 'normal@test.local', emailValid: true, status: 'new' } });
    const suppressedLead = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Suppressed', email: 'suppressed@test.local', emailValid: true, status: 'new' } });
    await db.suppression.create({ data: { workspaceId: ws.id, value: 'suppressed@test.local' } });
    const unsub = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Unsub', email: 'unsub@test.local', emailValid: true, status: 'unsubscribed' } });
    const noEmail = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'NoEmail', status: 'new' } });
    const invalidEmail = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'Invalid', email: 'bad@test.local', emailValid: false, status: 'new' } });

    const campaign = await db.campaign.create({
      data: { workspaceId: ws.id, name: 'Batch Campaign', channel: 'email', listId: list.id, steps: { create: [{ order: 1, subject: 'S', body: 'B' }] } },
    });

    // Pre-existing Message for this lead+step+channel — proves the dedup check still works with the batched fetch.
    const alreadyQueued = await db.lead.create({ data: { workspaceId: ws.id, listId: list.id, fullName: 'AlreadyQueued', email: 'already@test.local', emailValid: true, status: 'new' } });
    await db.message.create({
      data: { workspaceId: ws.id, campaignId: campaign.id, leadId: alreadyQueued.id, stepOrder: 1, channel: 'email', toAddress: 'already@test.local', body: 'pre-existing', trackingId: 'preexisting-1', status: 'sent' },
    });

    const result = await buildQueue(campaign.id);
    check('buildQueue queues exactly the one contactable, non-excluded, not-already-queued lead', result.queued, 1);

    const normalMessages = await db.message.findMany({ where: { campaignId: campaign.id, leadId: normal.id } });
    check('the normal lead got exactly one queued message', normalMessages.length, 1);
    check('the message is queued, addressed correctly', [normalMessages[0]?.status, normalMessages[0]?.toAddress], ['queued', 'normal@test.local']);
    check('the normal lead\'s status flips to queued', (await db.lead.findUniqueOrThrow({ where: { id: normal.id } })).status, 'queued');

    check('a suppressed lead gets no message', await db.message.count({ where: { campaignId: campaign.id, leadId: suppressedLead.id } }), 0);
    check('an unsubscribed lead gets no message', await db.message.count({ where: { campaignId: campaign.id, leadId: unsub.id } }), 0);
    check('a lead with no email (email-only campaign) gets no message', await db.message.count({ where: { campaignId: campaign.id, leadId: noEmail.id } }), 0);
    check('a lead with an invalid email gets no message', await db.message.count({ where: { campaignId: campaign.id, leadId: invalidEmail.id } }), 0);
    check('the already-queued lead still has exactly its one pre-existing message, no duplicate', await db.message.count({ where: { campaignId: campaign.id, leadId: alreadyQueued.id } }), 1);

    // ═══ idempotency: re-running buildQueue against the same campaign queues nothing new ═══
    const rerun = await buildQueue(campaign.id);
    check('re-running buildQueue queues nothing new — every eligible lead already has a message', rerun.queued, 0);
    check('total messages for this campaign is still exactly 2 (the one queued + the one pre-existing), not duplicated', await db.message.count({ where: { campaignId: campaign.id } }), 2);

    // ═══ 'both' channel expands to email+whatsapp for one contactable lead ═══
    const bothList = await db.leadList.create({ data: { workspaceId: ws.id, name: 'Both L' } });
    const bothCampaign = await db.campaign.create({
      data: { workspaceId: ws.id, name: 'Both Campaign', channel: 'both', listId: bothList.id, steps: { create: [{ order: 1, subject: 'S', body: 'B', channel: 'email' }] } },
    });
    const bothLead = await db.lead.create({ data: { workspaceId: ws.id, listId: bothList.id, fullName: 'Both', email: 'both@test.local', emailValid: true, phone: '+15550001', status: 'new' } });
    const bothResult = await buildQueue(bothCampaign.id);
    check('a "both" channel campaign queues 2 messages (email + whatsapp) for one contactable lead', bothResult.queued, 2);
    check('exactly one email message was created', await db.message.count({ where: { campaignId: bothCampaign.id, leadId: bothLead.id, channel: 'email' } }), 1);
    check('exactly one whatsapp message was created', await db.message.count({ where: { campaignId: bothCampaign.id, leadId: bothLead.id, channel: 'whatsapp' } }), 1);

    console.log('\nall campaign queue batch regression checks completed');
  } finally {
    await db.workspace.delete({ where: { id: ws.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall campaign queue batch regression tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
