import { db } from '../lib/db';
import { writeMessage } from '../lib/ai/writer';

const CONCURRENCY = Number(process.env.AI_CONCURRENCY ?? 4);

/** Generate one personalised draft per lead. Idempotent — existing drafts are left alone. */
export async function generateDrafts(campaignId: string) {
  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { workspace: true },
  });
  if (!campaign.listId) throw new Error('Campaign has no list');

  const existing = new Set(
    (await db.draft.findMany({ where: { campaignId }, select: { leadId: true } })).map((d) => d.leadId),
  );
  const leads = (await db.lead.findMany({ where: { listId: campaign.listId } }))
    .filter((l) => !existing.has(l.id));

  const channel: 'email' | 'whatsapp' = campaign.channel === 'whatsapp' ? 'whatsapp' : 'email';
  const cfg = {
    purpose: campaign.aiPurpose || 'Introduce our services and ask for a short call.',
    senderName: campaign.workspace.senderName || 'Sales',
    senderCompany: campaign.workspace.senderCompany || 'Our company',
    companyBlurb: campaign.workspace.companyBlurb,
    tone: campaign.aiTone,
    language: campaign.aiLanguage,
    maxWords: campaign.aiMaxWords,
    cta: campaign.aiCta,
    channel,
    model: campaign.aiModel,
    workspaceId: campaign.workspaceId,
  };

  let cursor = 0;
  async function worker() {
    for (;;) {
      const lead = leads[cursor++];
      if (!lead) return;
      try {
        const out = await writeMessage(
          {
            firstName: lead.firstName, fullName: lead.fullName, company: lead.company,
            title: lead.title, industry: lead.industry, city: lead.city, country: lead.country,
            website: lead.website, tier: lead.tier, custom: lead.custom as Record<string, unknown>,
          },
          cfg,
        );
        await db.draft.upsert({
          where: { campaignId_leadId_stepOrder: { campaignId, leadId: lead.id, stepOrder: 1 } },
          create: {
            campaignId, leadId: lead.id, stepOrder: 1, channel,
            subject: out.subject, body: out.body, model: out.model,
            approved: out.confidence >= 70,
          },
          update: { subject: out.subject, body: out.body, model: out.model },
        });
      } catch (e) {
        console.error('[draft]', lead.id, e instanceof Error ? e.message : e);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}
