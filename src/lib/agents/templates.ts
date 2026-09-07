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
    objective: 'Build a clear picture of a lead or company from the data already in the CRM, plus real public web research.',
    // research:web (Phase 9) grants web_search/fetch_web_page/analyze_web_content
    // only — not research:social (Instagram/uploaded media), which is a
    // materially different, higher-effort capability this role has no
    // objective needing it. See docs/research.md's permission table.
    allowedTools: ['crm:read', 'crm:companies', 'research:analysis', 'research:web', 'research:knowledge'],
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
    objective: 'Analyze public web pages, Instagram posts, and uploaded Reels/videos for business-model, audience, and adaptation-idea signals — real extraction and AI analysis, never fabricated.',
    // Both web and social/media tools (Section 12: "Social/Content Research
    // Agent may receive: social analysis, media analysis, web research").
    // Deliberately no research:analysis — this role does lead/company
    // synthesis for nobody; it researches EXTERNAL content, not the CRM.
    allowedTools: ['research:web', 'research:social', 'research:knowledge'],
    autonomyLevel: 'SuggestOnly',
  },
];
