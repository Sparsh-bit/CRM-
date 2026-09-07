/**
 * Outreach tools: draft a message (reuses the existing AI writer, no second
 * generation engine) and propose sending it (creates an Approval — never
 * sends directly). This is the ONLY place an agent can initiate outbound
 * contact, and it never reaches lower than an Approval: the actual send is
 * the existing worker/scheduler/provider path, untouched.
 */
import { z } from 'zod';
import { db } from '../../db';
import { registerTool } from '../registry';
import { writeMessage, type WrittenMessage } from '../../ai/writer';
import { proposeOutreach } from '../outreach';
import { resultSchema, toolResult } from './shared';

async function loadLead(workspaceId: string, leadId: string) {
  const lead = await db.lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) throw new Error('Lead not found in this workspace.');
  return lead;
}

async function senderConfig(workspaceId: string) {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return { senderName: ws.senderName || 'Sales', senderCompany: ws.senderCompany || 'Our company', companyBlurb: ws.companyBlurb };
}

const draftOutputSchema = z.object({
  subject: z.string(), body: z.string(), personalizationNote: z.string(), confidence: z.number(),
});

const draftInputSchema = z.object({
  leadId: z.string().min(1),
  purpose: z.string().min(1).max(2000),
  tone: z.string().max(200).optional(),
  maxWords: z.number().int().min(1).max(600).optional(),
});

function registerDraftTool(name: string, channel: 'email' | 'whatsapp' | 'sms', description: string, requiredPermission: string) {
  registerTool({
    name,
    description,
    inputSchema: draftInputSchema,
    outputSchema: resultSchema(draftOutputSchema),
    requiredPermission,
    category: 'outreach',
    readOnly: false, // calls a real AI provider — not a DB read, but no business record is mutated
    idempotent: true, // safe to call again: produces a fresh draft, never a duplicate record
    handler: async (input, ctx): Promise<ReturnType<typeof toolResult<WrittenMessage>>> => {
      const lead = await loadLead(ctx.workspaceId, input.leadId);
      const sender = await senderConfig(ctx.workspaceId);
      const draft = await writeMessage(
        {
          firstName: lead.firstName, fullName: lead.fullName, company: lead.company, title: lead.title,
          industry: lead.industry, city: lead.city, country: lead.country, website: lead.website,
          tier: lead.tier, custom: lead.custom as Record<string, unknown>,
        },
        { purpose: input.purpose, tone: input.tone, maxWords: input.maxWords, channel, workspaceId: ctx.workspaceId, ...sender },
      );
      return toolResult(draft, 1, `Draft prepared for ${lead.fullName ?? lead.email ?? lead.id} (confidence ${draft.confidence}).`);
    },
  });
}

registerDraftTool('prepare_email', 'email', 'Draft a personalized cold email for one lead using only their real CRM facts. Does not send anything.', 'outreach:draft');
registerDraftTool('prepare_whatsapp', 'whatsapp', 'Draft a personalized first-contact WhatsApp message for one lead using only their real CRM facts. Does not send anything.', 'outreach:draft');
registerDraftTool('prepare_sms', 'sms', 'Draft a personalized first-contact SMS for one lead using only their real CRM facts. Does not send anything.', 'outreach:draft');

registerTool({
  name: 'propose_send',
  description:
    'Propose sending a specific, already-written message to a specific lead on a specific channel. This creates an Approval — nothing is ever sent directly by this tool. A standing workspace policy may auto-approve or auto-reject it; otherwise a human decides. The provider/mailbox/gateway used is chosen automatically by the existing send governor at actual send time — this tool never selects one.',
  inputSchema: z.object({
    leadId: z.string().min(1),
    channel: z.enum(['email', 'whatsapp', 'sms']),
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(5000),
    reason: z.string().min(1).max(1000),
    personalizationNote: z.string().max(500).optional(),
    campaignId: z.string().optional(),
    scheduledFor: z.string().datetime().optional(),
  }),
  outputSchema: resultSchema(z.object({ approvalId: z.string(), status: z.string(), messageId: z.string().nullable() })),
  requiredPermission: 'outreach:propose',
  category: 'outreach',
  readOnly: false,
  // Every failure mode of this tool (autonomy denial, suppression, missing
  // recipient, cross-workspace lead) is a permanent validation failure, not
  // a transient one — there is no network call in proposeOutreach() for a
  // retry to plausibly fix. `idempotent` in the runtime's retry policy
  // means "safe to automatically retry the whole task", which only makes
  // sense when a retry might get a different outcome; it is not the same
  // property as "a repeat call is safe" (that's proposeOutreach()'s own
  // dedup check, which holds regardless of this flag). Marking this
  // idempotent:true was wrong and caused permanent failures to be silently
  // requeued instead of reported — see docs/agent-outreach.md.
  idempotent: false,
  handler: async (input, ctx) => {
    const result = await proposeOutreach(ctx.workspaceId, ctx.agentId, ctx.taskId, input);
    return toolResult(
      { approvalId: result.approval.id, status: result.approval.status, messageId: result.approval.messageId },
      1,
      result.summary,
    );
  },
});
