/**
 * Local ffmpeg/ffprobe wrapper — Section 2's "prefer the simplest legitimate
 * implementation": ffmpeg is already installed on this deployment target,
 * BSD/LGPL-licensed, the de facto standard for media processing, and needs
 * no cloud service or per-call cost. Every call goes through execFile (never
 * a shell string) with an explicit timeout — no unbounded decode of an
 * arbitrarily large or malicious file (Section 14).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 15_000;
const EXTRACT_TIMEOUT_MS = 60_000;
// Read at call time, not module load (see webFetch.ts) — cap what actually
// gets transcribed/sampled, regardless of the source file's real length.
export const maxProcessDurationSec = () => Number(process.env.RESEARCH_MEDIA_MAX_DURATION_SEC ?? 180);

export type MediaProbe = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  formatName: string | null;
};

/** True only if both binaries actually respond — checked once per pipeline run rather than assumed from PATH alone. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: 5_000_000 },
  );
  const j = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const streams = j.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  return {
    durationSec: j.format?.duration ? Number(j.format.duration) : null,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    hasVideo: !!videoStream,
    formatName: j.format?.format_name ?? null,
  };
}

/** Mono 16kHz WAV — the shape Whisper-family transcription APIs want, capped to maxProcessDurationSec() regardless of source length. */
export async function extractAudio(filePath: string, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-i', filePath,
    '-t', String(maxProcessDurationSec()),
    '-vn', '-ac', '1', '-ar', '16000',
    outPath,
  ], { timeout: EXTRACT_TIMEOUT_MS });
}

/** N evenly-spaced JPEG frames within the first maxProcessDurationSec() — sampled, never every frame (Section 21). */
export async function sampleFrames(filePath: string, outDir: string, count: number, durationSec: number): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });
  const bounded = Math.min(durationSec, maxProcessDurationSec());
  const interval = bounded / (count + 1);
  const paths: string[] = [];
  for (let i = 1; i <= count; i++) {
    const at = (interval * i).toFixed(2);
    const outPath = path.join(outDir, `frame-${i}.jpg`);
    await execFileAsync('ffmpeg', ['-y', '-ss', at, '-i', filePath, '-frames:v', '1', '-q:v', '3', outPath], { timeout: EXTRACT_TIMEOUT_MS });
    paths.push(outPath);
  }
  return paths;
}
