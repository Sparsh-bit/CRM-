import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getSession } from '@/lib/session';
import { listCommandsAction } from './actions';
import { CommandCenterClient } from './_components/CommandCenterClient';

export const dynamic = 'force-dynamic';

export default async function CommandCenterPage() {
  const s = await getSession();
  if (!s) redirect('/login');

  const [historyResult, agentCount] = await Promise.all([
    listCommandsAction(),
    // Excludes the Command Center's own internal bookkeeping agent (see the
    // ensureCommandCenterAgent() comment in src/lib/agents/commandCenter.ts)
    // so the empty state never implies real employees exist when only that
    // system agent does.
    db.agent.count({ where: { workspaceId: s.workspaceId, status: 'active', role: { not: 'Command Center' } } }),
  ]);

  return (
    <CommandCenterClient
      initialHistory={historyResult.ok ? historyResult.data : []}
      initialHistoryError={historyResult.ok ? null : historyResult.error}
      hasAgents={agentCount > 0}
    />
  );
}
