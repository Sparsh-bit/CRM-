/**
 * Background worker.  Run alongside the web app:   npm run worker
 *
 * It does five things, forever:
 *   1. drains AI draft-generation jobs
 *   2. sends due messages, obeying per-mailbox caps, warmup, throttle and sending windows
 *   3. polls WhatsApp instance connection state
 *   4. executes queued AI agent tasks (AgentRuntime) — never sends anything
 *      itself; a task that needs to send goes through the exact same
 *      Message/mailbox/WaInstance path as (2), never a shortcut.
 *   5. runs queued media analysis (Phase 9: ffmpeg + transcription + optional
 *      frame analysis) — kept off the AgentRuntime timeout entirely, since a
 *      video can take longer to process than one tool call's budget allows.
 */
import 'dotenv/config';
import { db } from '../lib/db';
import { claimJob, completeJob, failJob, reclaimStale, rescheduleJob, enqueue } from '../lib/queue';
import { sendDueMessages } from './sender';
import { generateDrafts } from './drafts';
import { syncWaStatus } from './wa';
import { executeAgentTask } from '../lib/agents/runtime';
import { runMediaAnalysis } from '../lib/research/media/pipeline';

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 5000);

// Graceful shutdown: a platform restart/deploy (Railway sends SIGTERM) used
// to kill this process mid-poll-interval with no warning — whatever job was
// `running` at that instant just sat there until reclaimStale()'s 5-minute
// window on the NEXT worker instance's first tick. Now a signal stops the
// loop from starting a new tick and wakes an in-progress sleep immediately
// (rather than waiting out the rest of TICK_MS), so the process exits
// promptly instead of relying on the platform's kill timeout.
let shuttingDown = false;
let wakeForShutdown: (() => void) | null = null;
function requestShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`worker received ${signal} — finishing the current tick, then exiting`);
  wakeForShutdown?.();
}
process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGINT', () => requestShutdown('SIGINT'));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeForShutdown = () => { clearTimeout(timer); resolve(); };
  });
}

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
      } else if (job.type === 'process_media') {
        // Phase 9: the async uploaded-media pipeline (metadata, audio,
        // transcription, optional frame analysis) — never runs inline inside
        // an AgentRuntime tool call (analyze_uploaded_media only enqueues
        // this and returns immediately). runMediaAnalysis is itself
        // idempotent (a MediaAnalysis not still `queued` is a no-op), so a
        // Job-level retry after a crash is safe.
        await runMediaAnalysis(job.workspaceId, String((payload as { mediaAnalysisId?: string }).mediaAnalysisId));
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
  // Warm the DB connection BEFORE announcing readiness and entering the
  // loop. Found while testing the shutdown fix above: a SIGTERM landing
  // during Prisma's very first query in a process's lifetime (engine
  // init on that first call) does not reach the handler registered above
  // at all — confirmed empirically (a second, already-warm query does not
  // have this problem; neither does plain node-postgres without Prisma).
  // Connecting here, before "worker up", means that fragile window closes
  // during startup — before there is any job in flight to lose — rather
  // than being able to land at any arbitrary later moment a real deploy
  // restart's SIGTERM could plausibly arrive.
  await db.$connect();
  console.log('worker up — polling every', TICK_MS, 'ms');
  while (!shuttingDown) {
    try { await tick(); } catch (e) { console.error('[tick]', e); }
    if (shuttingDown) break;
    await sleep(TICK_MS);
  }
  console.log('worker shutting down cleanly');
  await db.$disconnect().catch(() => {});
  process.exit(0);
}

main();
