/**
 * Built-in AI employee configurations — least-privilege tool grants per
 * role, matching the permission groups tools register under (see
 * docs/agent-tools.md for the full tool -> permission map).
 *
 * These are configuration, not seed data: nothing here writes to the
 * database. A future onboarding flow creates Agent rows from these
 * templates for a new workspace; Phase 4's job was making sure the grants
 * themselves are correct and minimal, not building that onboarding flow.
 *
 * Deliberately excluded everywhere: any messaging/sending permission (no
 * tool in this build grants one yet) and 'research:analysis' for roles that
 * don't need company/lead-history synthesis.
 */
import type { AutonomyLevel } from '@/generated/prisma/enums';

export type AgentTemplate = {
  role: string;
  name: string;
  department: string;
  objective: string;
  allowedTools: string[];
  autonomyLevel: AutonomyLevel;
};

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    role: 'CEO / Strategy',
    name: 'Strategy',
    department: 'Leadership',
    objective: 'Track how campaigns and pipeline are performing across the workspace and surface what needs attention.',
    allowedTools: ['campaign:read', 'campaign:analytics', 'crm:read', 'crm:companies', 'research:analysis'],
    autonomyLevel: 'SuggestOnly',
  },
  {
    role: 'Research',
    name: 'Research',
    department: 'Research',
    objective: 'Build a clear picture of a lead or company from the data already in the CRM.',
    allowedTools: ['crm:read', 'crm:companies', 'research:analysis'],
    autonomyLevel: 'SuggestOnly',
  },
  {
    role: 'Sales',
    name: 'Sales',
    department: 'Sales',
    objective: 'Find and prioritize the leads worth contacting today.',
    allowedTools: ['crm:read', 'sales:prioritization', 'campaign:read', 'campaign:analytics'],
    autonomyLevel: 'SuggestOnly',
  },
  {
    role: 'Marketing',
    name: 'Marketing',
    department: 'Marketing',
    objective: 'Compare campaign performance and understand the audience being reached.',
    allowedTools: ['campaign:read', 'campaign:analytics', 'crm:read', 'crm:companies'],
    autonomyLevel: 'SuggestOnly',
  },
  {
    role: 'Operations',
    name: 'Operations',
    department: 'Operations',
    objective: 'Keep an eye on campaign state across the workspace.',
    // Job/worker/system-health tools don't exist yet in this build — see
    // docs/agent-tools.md "Deferred" for what a future phase should add here.
    allowedTools: ['campaign:read'],
    autonomyLevel: 'SuggestOnly',
  },
  {
    role: 'Outreach',
    name: 'Outreach',
    department: 'Sales',
    objective: 'Draft personalized outreach and propose sending it — every send is approval-controlled by default; it never sends directly.',
    allowedTools: ['crm:read', 'campaign:read', 'outreach:draft', 'outreach:propose'],
    // DraftAndRequestApproval, not SuggestOnly: propose_send refuses to run
    // at all for a SuggestOnly agent (src/lib/agents/outreach.ts), and this
    // agent's whole objective requires being able to propose. Every
    // proposal still creates a real Approval regardless — this default
    // does not skip human review; only an explicit, admin-set
    // ApprovalPolicy per action type can do that (see docs/agent-outreach.md).
    autonomyLevel: 'DraftAndRequestApproval',
  },
  {
    role: 'Social/Content Research',
    name: 'Content Research',
    department: 'Research',
    objective: 'Analyze external content for adaptation ideas once a research provider is configured.',
    // research_external_content is real, registered, and honest about not
    // being implemented yet — this agent has nothing else to do until it is.
    allowedTools: ['research:analysis'],
    autonomyLevel: 'SuggestOnly',
  },
];
