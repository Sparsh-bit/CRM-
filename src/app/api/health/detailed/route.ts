/**
 * Authenticated, per-workspace detail behind the public /api/health above.
 * Admin-gated (same rank as mailboxes/settings/whatsapp) rather than a
 * global "platform admin" concept — this app's role model has no such
 * role, so this is scoped to the caller's own workspace, not the whole
 * deployment. Job counts/failures are workspace-scoped for that reason
 * (src/lib/health.ts's checkJobs); database/ai/storage/search are
 * deployment-wide config facts, not tenant data, so those stay global.
 */
import { requireRole } from '@/lib/session';
import { checkDatabase, checkAiProvider, checkJobs } from '@/lib/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  let workspaceId: string;
  try {
    ({ session: { workspaceId } } = await requireRole('admin'));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Unauthorized' }, { status: 401 });
  }

  const [database, jobs] = await Promise.all([checkDatabase(), checkJobs(workspaceId)]);
  const ai = checkAiProvider();
  const storageProvider = (process.env.STORAGE_PROVIDER ?? 'local').toLowerCase();
  const searchProvider = process.env.SEARCH_PROVIDER || null;
  const healthy = database.ok;

  return Response.json(
    {
      status: healthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      database, ai, jobs,
      storage: { provider: storageProvider },
      search: { provider: searchProvider, configured: !!searchProvider },
    },
    { status: healthy ? 200 : 503 },
  );
}
