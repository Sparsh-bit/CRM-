/**
 * Background worker.  Run alongside the web app:   npm run worker
 *
 * It does four things, forever:
 *   1. drains AI draft-generation jobs
 *   2. sends due messages, obeying per-mailbox caps, warmup, throttle and sending windows
 *   3. polls WhatsApp instance connection state
 *   4. executes queued AI agent tasks (AgentRuntime) — never sends anything
 *      itself; a task that needs to send goes through the exact same
 *      Message/mailbox/WaInstance path as (2), never a shortcut.
 */
import 'dotenv/config';
import { db } from '../lib/db';
import { claimJob, completeJob, failJob, reclaimStale, rescheduleJob, enqueue } from '../lib/queue';
import { sendDueMessages } from './sender';
import { generateDrafts } from './drafts';
import { syncWaStatus } from './wa';
import { executeAgentTask } from '../lib/agents/runtime';

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 5000);

async function tick() {
  await reclaimStale();

  const job = await claimJob();
  if (job) {
    try {
      const payload = job.payload as Record<string, unknown>;
      if (job.type === 'generate_drafts') {
        await generateDrafts(String(payload.campaignId));
      } else if (job.type === 'sync_wa_status') {
        await syncWaStatus(job.workspaceId);
      } else if (job.type === 'send_message') {
        const result = await sendDueMessages(job.workspaceId);
        if (result.pending > 0) {
          // more to send, but we're capped/throttled — come back later
          await rescheduleJob(job.id, result.retryAt ?? new Date(Date.now() + 60_000));
          return;
        }
      } else if (job.type === 'run_agent_task') {
        // executeAgentTask handles its own domain-level retry (re-enqueueing
        // a fresh run_agent_task job on a retryable failure) and only lets an
        // unexpected/infrastructure error reach this catch block, where it
        // gets the same generic Job-level retry every other job type does.
        await executeAgentTask(job.workspaceId, String((payload as { taskId?: string }).taskId));
      }
      await completeJob(job.id);
    } catch (e) {
      console.error(`[job ${job.type}]`, e);
      await failJob(job.id, e instanceof Error ? e.message : String(e));
    }
    return;
  }

  // No queued job: still sweep for messages whose scheduledFor has come round
  // (follow-up steps land here without an explicit job).
  const due = await db.message.findFirst({
    where: { status: 'queued', scheduledFor: { lte: new Date() } },
    select: { workspaceId: true },
  });
  if (due) await enqueue(due.workspaceId, 'send_message', {});
}

async function main() {
  console.log('worker up — polling every', TICK_MS, 'ms');
  for (;;) {
    try { await tick(); } catch (e) { console.error('[tick]', e); }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main();
