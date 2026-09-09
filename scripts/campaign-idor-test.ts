/**
 * Regression test for the cross-workspace/cross-campaign IDOR found in a
 * security audit: saveStep/saveDraft (src/app/campaigns/[id]/page.tsx) used
 * to trust a raw stepId/draftId from the form without checking it belonged
 * to the campaign the caller had already been verified to own, and
 * create() (src/app/campaigns/page.tsx) used to attach a raw listId to a
 * new campaign without checking it belonged to the caller's workspace.
 * Fixed at the root in src/lib/campaign.ts: updateCampaignStep/
 * updateCampaignDraft now scope the update by (id, campaignId) together,
 * not id alone, and assertListOwnership verifies a listId before it can
 * ever be attached to a campaign. Real Postgres; throwaway workspaces
 * deleted in the finally block. Run via `npm run campaign-idor:test`.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { updateCampaignStep, updateCampaignDraft, assertListOwnership } from '../src/lib/campaign';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
async function checkThrows(name: string, fn: () => Promise<unknown>) {
  try { await fn(); fails++; console.log(`FAIL ${name}\n  expected a throw, got none`); }
  catch { console.log(`pass ${name}`); }
}

async function main() {
  const wsA = await db.workspace.create({ data: { name: 'IDOR Test A', slug: 'idor-a-' + Date.now() } });
  const wsB = await db.workspace.create({ data: { name: 'IDOR Test B', slug: 'idor-b-' + Date.now() } });

  try {
    const listA = await db.leadList.create({ data: { workspaceId: wsA.id, name: 'List A' } });
    const listB = await db.leadList.create({ data: { workspaceId: wsB.id, name: 'List B' } });

    const campaignA = await db.campaign.create({
      data: { workspaceId: wsA.id, name: 'Campaign A', listId: listA.id, steps: { create: [{ order: 1, subject: 'A subject', body: 'A body' }] } },
      include: { steps: true },
    });
    const campaignB = await db.campaign.create({
      data: { workspaceId: wsB.id, name: 'Campaign B', listId: listB.id, steps: { create: [{ order: 1, subject: 'B subject', body: 'B body' }] } },
      include: { steps: true },
    });
    const stepA = campaignA.steps[0];
    const stepB = campaignB.steps[0];

    const leadA = await db.lead.create({ data: { workspaceId: wsA.id, listId: listA.id, fullName: 'Lead A', email: 'lead-a@test.local', status: 'new' } });
    const leadB = await db.lead.create({ data: { workspaceId: wsB.id, listId: listB.id, fullName: 'Lead B', email: 'lead-b@test.local', status: 'new' } });
    const draftA = await db.draft.create({ data: { campaignId: campaignA.id, leadId: leadA.id, subject: 'A draft subject', body: 'A draft body' } });
    const draftB = await db.draft.create({ data: { campaignId: campaignB.id, leadId: leadB.id, subject: 'B draft subject', body: 'B draft body' } });

    // ═══ PRIORITY 1: saveStep IDOR — workspace A's campaign id + workspace B's stepId ═══
    await checkThrows(
      'updateCampaignStep rejects workspace A\'s campaignId paired with workspace B\'s stepId',
      () => updateCampaignStep(campaignA.id, stepB.id, { subject: 'HACKED', body: 'HACKED', delayDays: 0, condition: 'always' }),
    );
    const stepBAfter = await db.campaignStep.findUniqueOrThrow({ where: { id: stepB.id } });
    check('workspace B\'s step body is unchanged after the rejected cross-campaign attempt', stepBAfter.body, 'B body');
    check('workspace B\'s step subject is unchanged after the rejected cross-campaign attempt', stepBAfter.subject, 'B subject');

    // Legitimate same-campaign update still works.
    await updateCampaignStep(campaignA.id, stepA.id, { subject: 'A subject v2', body: 'A body v2', delayDays: 2, condition: 'no_open' });
    const stepAAfter = await db.campaignStep.findUniqueOrThrow({ where: { id: stepA.id } });
    check('a legitimate same-campaign step update still succeeds', stepAAfter.body, 'A body v2');
    check('a legitimate same-campaign step update persists delayDays/condition too', [stepAAfter.delayDays, stepAAfter.condition], [2, 'no_open']);

    // ═══ PRIORITY 2: saveDraft IDOR — workspace A's campaign id + workspace B's draftId ═══
    await checkThrows(
      'updateCampaignDraft rejects workspace A\'s campaignId paired with workspace B\'s draftId',
      () => updateCampaignDraft(campaignA.id, draftB.id, { subject: 'HACKED', body: 'HACKED' }),
    );
    const draftBAfter = await db.draft.findUniqueOrThrow({ where: { id: draftB.id } });
    check('workspace B\'s draft body is unchanged after the rejected cross-campaign attempt', draftBAfter.body, 'B draft body');
    check('workspace B\'s draft was never marked approved by the rejected attempt', draftBAfter.approved, false);

    // Legitimate same-campaign draft update still works, and marks it approved+edited.
    await updateCampaignDraft(campaignA.id, draftA.id, { subject: 'A draft subject v2', body: 'A draft body v2' });
    const draftAAfter = await db.draft.findUniqueOrThrow({ where: { id: draftA.id } });
    check('a legitimate same-campaign draft update still succeeds', draftAAfter.body, 'A draft body v2');
    check('a legitimate draft update marks it approved', draftAAfter.approved, true);
    check('a legitimate draft update marks it edited', draftAAfter.edited, true);

    // ═══ PRIORITY 3: lead-list cross-workspace attachment ═══
    await checkThrows('assertListOwnership rejects a list belonging to another workspace', () => assertListOwnership(wsA.id, listB.id));
    await assertListOwnership(wsA.id, listA.id); // must not throw for a list the caller actually owns

    // The only path that ever sets Campaign.listId is create() (src/app/campaigns/page.tsx), which now calls
    // assertListOwnership before db.campaign.create — so a campaign attached to a foreign list can never exist
    // in the first place, and preflight()/buildQueue() (both trusting campaign.listId) never see foreign leads.
    check('no campaign in workspace A references workspace B\'s list (nothing ever got the chance to attach it)',
      await db.campaign.count({ where: { workspaceId: wsA.id, listId: listB.id } }), 0);

    console.log('\nall campaign IDOR regression checks completed');
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [wsA.id, wsB.id] } } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall campaign IDOR regression tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
