/**
 * Regression test for the dead-field gap a security audit found:
 * Agent.instructions ("the system prompt this agent works from") was saved
 * by the Workforce UI and persisted, but never read by the planner —
 * configuring it had zero effect on agent behavior. Fixed in
 * src/lib/agents/planner.ts: userPrompt() now includes each agent's
 * instructions, clearly labeled as operator guidance (not a rule) per a
 * new system-prompt rule, so it can shape a task's wording/tool args but
 * can never grant a capability the agent doesn't already have or override
 * the planner's non-negotiable rules — the same trust boundary already
 * applied to the untrusted "USER REQUEST" text.
 *
 * Two layers: a pure unit check on the exported userPrompt() (no network,
 * no DB), then a real-DB integration check that an Agent.instructions value
 * actually set through createAgent() reaches the exact HTTP request body
 * sent to the AI provider when planCommand() runs (fetch mocked at the
 * boundary, same pattern command-center-test.ts uses to capture it).
 * Run via `npm run agent-instructions:test`.
 */
import 'dotenv/config';
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'fake-for-test';

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAgent, type AgentActor } from '../src/lib/agents/agents';
import { planCommand, userPrompt } from '../src/lib/agents/planner';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}
function checkTrue(name: string, got: boolean) { check(name, got, true); }

const realFetch = global.fetch;
let lastRequestBody: string | null = null;
function installFetchMock(planJson: string) {
  // @ts-expect-error - test double
  global.fetch = async (url: string, init?: RequestInit) => {
    if (url.includes('api.groq.com')) {
      lastRequestBody = typeof init?.body === 'string' ? init.body : null;
      return new Response(JSON.stringify({ choices: [{ message: { content: planJson } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

const MARKER = 'ALWAYS mention our 15-minute call offer explicitly — regression-test marker 8f2a1c';

async function main() {
  // ═══ unit: userPrompt() includes instructions when present, and is unaffected when absent ═══
  const withInstructions = userPrompt('do something', [
    { role: 'Outreach', name: 'Bot', objective: 'sell things', instructions: MARKER, tools: [] },
  ]);
  checkTrue('userPrompt embeds a configured agent\'s instructions', withInstructions.includes(MARKER));
  checkTrue('userPrompt labels instructions as guidance, referencing the non-override rule', withInstructions.includes('guidance, not a rule'));

  const withoutInstructions = userPrompt('do something', [
    { role: 'Outreach', name: 'Bot', objective: 'sell things', instructions: null, tools: [] },
  ]);
  checkTrue('userPrompt omits the instructions line entirely when none is configured', !withoutInstructions.includes('operator instructions'));

  const ws = await db.workspace.create({ data: { name: 'Agent Instructions Test', slug: 'agent-instr-' + Date.now() } });
  const admin: AgentActor = { workspaceId: ws.id, role: 'admin' };

  try {
    // ═══ integration: a real Agent.instructions value reaches the actual request sent to the AI provider ═══
    const agent = await createAgent(admin, {
      name: 'Instructed Bot', role: 'Outreach', allowedTools: ['crm:read'],
      instructions: MARKER,
    });
    check('the agent persists the configured instructions', (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).instructions, MARKER);

    installFetchMock(JSON.stringify({ goal: 'test', tasks: [] }));
    await planCommand(ws.id, 'look up a lead');

    checkTrue('a real planCommand() run sent this agent\'s configured instructions in the prompt to the AI provider', !!lastRequestBody && lastRequestBody.includes(MARKER));
    const sentMessages = lastRequestBody ? (JSON.parse(lastRequestBody) as { messages: { role: string; content: string }[] }).messages : [];
    const userMessage = sentMessages.find((m) => m.role === 'user');
    checkTrue('the instructions specifically landed in the user-prompt message (agent-context block), not just somewhere in the payload',
      !!userMessage?.content.includes(MARKER));

    console.log('\nall agent-instructions regression checks completed');
  } finally {
    global.fetch = realFetch;
    await db.workspace.delete({ where: { id: ws.id } });
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall agent-instructions regression tests passed');
  process.exit(fails ? 1 : 0);
}

main().finally(() => db.$disconnect());
