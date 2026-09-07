/**
 * Local-disk storage for uploaded media (Section 20). No object-storage
 * provider (R2/S3) is configured in this deployment yet — this is the
 * simplest legitimate implementation for what exists today, kept behind a
 * narrow enough interface (save/read/remove by key) that swapping in R2
 * later is a one-file change, not a rewrite of every caller.
 *
 * Files live under STORAGE_ROOT (default a temp dir, never inside the repo
 * or a web-served path) and are removed as soon as the media pipeline is
 * done with them — see media/pipeline.ts's cleanup step. Nothing here is a
 * long-term store.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function root(): string {
  return process.env.STORAGE_ROOT || path.join(os.tmpdir(), 'outreachpilot-media');
}

/** A storage key is workspace-scoped and never allowed to escape its own directory (no "..", no absolute path). */
function assertSafeKey(key: string): void {
  if (!key || key.includes('..') || path.isAbsolute(key)) {
    throw new Error(`Unsafe storage key: "${key}"`);
  }
}

export async function saveFile(key: string, data: Buffer): Promise<string> {
  assertSafeKey(key);
  const full = path.join(root(), key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
  return full;
}

export function resolvePath(key: string): string {
  assertSafeKey(key);
  return path.join(root(), key);
}

export async function removeFile(key: string): Promise<void> {
  assertSafeKey(key);
  await fs.rm(path.join(root(), key), { force: true });
}

/** Removes an entire workspace/media directory tree — used once a MediaAnalysis is done with its working files. */
export async function removeDir(key: string): Promise<void> {
  assertSafeKey(key);
  await fs.rm(path.join(root(), key), { recursive: true, force: true });
}

/** Real stat, not a fabricated size — null (not a throw) for a key that doesn't exist, so a caller can treat it as a normal "not found" case. Added for the StorageService abstraction (index.ts); the functions above are unchanged. */
export async function statFile(key: string): Promise<{ sizeBytes: number; lastModified: Date } | null> {
  assertSafeKey(key);
  try {
    const s = await fs.stat(path.join(root(), key));
    return { sizeBytes: s.size, lastModified: s.mtime };
  } catch {
    return null;
  }
}
