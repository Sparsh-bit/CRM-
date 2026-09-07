/**
 * The async uploaded-media pipeline (Section 4 & 14): metadata -> audio
 * extraction -> transcription -> optional frame/visual analysis ->
 * structured content analysis. Runs entirely inside the existing worker
 * (src/worker/index.ts), triggered by a `process_media` Job — never inside
 * an AgentRuntime tool call, which is exactly why analyze_uploaded_media
 * (the tool) only enqueues this and returns immediately (Section 4: "keep
 * processing asynchronous for large files"; Section 14: "large processing
 * must go through the job queue").
 */
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { nanoid } from 'nanoid';
import { db } from '../../db';
import { logActivity } from '../../agents/activity';
import { storageFor } from '../../storage';
import { ffmpegAvailable, probeMedia, extractAudio, sampleFrames, maxProcessDurationSec } from './ffmpeg';
import { transcribeAudio } from '../../ai/transcribe';
import { analyzeFrames } from './vision';
import { analyzeReelContent } from '../analyze';
import type { Prisma } from '@/generated/prisma/client';

const frameSampleCount = () => Number(process.env.RESEARCH_MEDIA_FRAME_COUNT ?? 4); // read at call time — this runs inside the long-lived worker process, see webFetch.ts

async function markFailed(id: string, workspaceId: string, agentId: string | null, taskId: string | null, error: string) {
  await db.mediaAnalysis.update({ where: { id }, data: { status: 'failed', error: error.slice(0, 2000) } });
  if (agentId) {
    await logActivity(workspaceId, { agentId, taskId, type: 'media_analysis_failed', meta: { mediaAnalysisId: id, error: error.slice(0, 500) } });
  }
}

/**
 * `workspaceId` is the Job's own (src/worker/index.ts passes job.workspaceId
 * — never trust the payload's mediaAnalysisId alone). Defense in depth, same
 * convention executeAgentTask(workspaceId, taskId) already uses: even though
 * every real caller today only ever enqueues a Job whose payload already
 * agrees with its own workspaceId, a bare id lookup with no workspace check
 * is exactly the shape of bug that silently processes the wrong tenant's
 * data the day that invariant breaks for any reason.
 */
export async function runMediaAnalysis(workspaceId: string, mediaAnalysisId: string): Promise<void> {
  const analysis = await db.mediaAnalysis.findFirst({ where: { id: mediaAnalysisId, workspaceId }, include: { mediaAsset: true } });
  if (!analysis) return; // deleted, never existed, or belongs to a different workspace — nothing to do
  if (analysis.status !== 'queued') return; // already picked up / resolved — idempotent no-op, same convention as executeAgentTask

  await db.mediaAnalysis.update({ where: { id: mediaAnalysisId }, data: { status: 'processing' } });
  const asset = analysis.mediaAsset;
  if (!asset) {
    await markFailed(mediaAnalysisId, analysis.workspaceId, analysis.agentId, analysis.taskId, 'No MediaAsset attached to this analysis.');
    return;
  }

  if (!(await ffmpegAvailable())) {
    await markFailed(mediaAnalysisId, analysis.workspaceId, analysis.agentId, analysis.taskId, 'Capability unavailable with current configuration — ffmpeg/ffprobe are not installed on this worker.');
    return;
  }

  // The original upload: retrieved through StorageService (workspace-scoped,
  // backend-agnostic) — getLocalPath() hands back a real local file
  // regardless of whether the backend is local disk or R2 (R2 downloads to
  // a scratch temp file for this). `originalCleanup` is a no-op on local,
  // real on R2.
  const storage = storageFor(analysis.workspaceId);
  const { path: sourcePath, cleanup: originalCleanup } = await storage.getLocalPath(asset.storagePath);
  // Derived audio/frames are pure processing SCRATCH (Section 9: distinct
  // from the persistent original) — always plain local disk, regardless of
  // storage backend; there is no reason to ever persist these anywhere.
  const workDir = path.join(os.tmpdir(), 'outreachpilot-media-work', nanoid());

  try {
    const probe = await probeMedia(sourcePath);
    if (!probe.hasAudio && !probe.hasVideo) {
      throw new Error('The uploaded file has neither an audio nor a video stream — not a media file.');
    }

    let transcript: string | null = null;
    if (probe.hasAudio) {
      const audioPath = path.join(workDir, 'audio.wav');
      await extractAudio(sourcePath, audioPath);
      const t = await transcribeAudio(audioPath);
      if (t.status === 'ok') transcript = t.text;
      // not_configured/error: transcript stays null — the analysis still runs on whatever else is available (caption/description), never fabricated.
    }

    let visionDescription: string | null = null;
    if (probe.hasVideo && probe.durationSec) {
      const frameDir = path.join(workDir, 'frames');
      const frames = await sampleFrames(sourcePath, frameDir, frameSampleCount(), probe.durationSec);
      const v = await analyzeFrames(frames);
      if (v.status === 'ok') visionDescription = v.description;
      // 'unavailable': visionDescription stays null — reported honestly in metadata below, never faked.
    }

    if (!transcript && !visionDescription) {
      throw new Error('No transcript could be produced (no configured transcription provider or no audio track) and no visual analysis is available — nothing to analyze.');
    }

    const content = await analyzeReelContent(
      { transcript, description: visionDescription, durationSec: probe.durationSec },
      analysis.workspaceId,
    );

    const result = {
      metadata: { durationSec: probe.durationSec, width: probe.width, height: probe.height, hasAudio: probe.hasAudio, hasVideo: probe.hasVideo, cappedAtSec: maxProcessDurationSec() },
      transcriptAvailable: !!transcript,
      visualAnalysisAvailable: !!visionDescription,
      analysis: content,
    };

    await db.mediaAnalysis.update({ where: { id: mediaAnalysisId }, data: { status: 'completed', result: result as unknown as Prisma.InputJsonValue } });
    if (analysis.agentId) {
      await logActivity(analysis.workspaceId, { agentId: analysis.agentId, taskId: analysis.taskId, type: 'media_analysis_completed', meta: { mediaAnalysisId } });
    }
  } catch (e) {
    await markFailed(mediaAnalysisId, analysis.workspaceId, analysis.agentId, analysis.taskId, e instanceof Error ? e.message : String(e));
  } finally {
    // Section 9/20: never keep large temporary processing files around once
    // done. Three things to clean up, all best-effort (a cleanup failure
    // must never mask the real result above): the local processing scratch
    // (audio/frames, always local regardless of backend), the R2 scratch
    // download if the backend is R2 (a no-op on local), and the persistent
    // original itself — this build has no "keep the customer's video"
    // retention policy yet (docs/research.md), so it's deleted too.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await originalCleanup().catch(() => {});
    await storage.delete(asset.storagePath).catch(() => {});
  }
}
