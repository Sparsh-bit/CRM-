/**
 * StorageService (Section 8) — the one place anything in this codebase
 * reads/writes a stored file, local disk or R2. `storageFor(workspaceId)`
 * is the ONLY way to get a handle: every operation it returns silently
 * prefixes the key with that workspace's id, so a caller physically cannot
 * construct a key that reaches another workspace's files — workspace
 * authorization is structural, not a check a caller could forget to add
 * (Section 10). No internal filesystem/R2 path is ever handed back to a
 * caller — only the sub-key the caller itself chose.
 *
 * Provider selection: STORAGE_PROVIDER=r2 (+ R2_ACCOUNT_ID/
 * R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET) or local (default — "do
 * not make R2 mandatory yet", Section 8). An explicit STORAGE_PROVIDER=r2
 * with missing config fails fast and loud, not a silent fallback to local.
 */
import { saveFile, resolvePath, removeFile, removeDir, statFile } from './local';
import { r2Upload, r2Download, r2Delete, r2Stat, r2DownloadToTempFile, type R2Config } from './r2';

export type StorageMetadata = { sizeBytes: number; lastModified: Date; contentType?: string };

function assertSafeSubKey(subKey: string): void {
  if (!subKey || subKey.includes('..') || subKey.startsWith('/')) {
    throw new Error(`Unsafe storage sub-key: "${subKey}"`);
  }
}

function r2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID, accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY, bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

function provider(): 'local' | 'r2' {
  const p = (process.env.STORAGE_PROVIDER ?? 'local').toLowerCase();
  if (p === 'r2') {
    if (!r2Config()) throw new Error('STORAGE_PROVIDER=r2 but R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET are not all set — refusing to silently fall back to local storage.');
    return 'r2';
  }
  return 'local';
}

export type WorkspaceStorage = {
  /** Real, immediate, workspace-scoped operations — a caller passes only a sub-key, never sees the real prefixed key or filesystem/R2 path. */
  upload(subKey: string, data: Buffer, contentType?: string): Promise<void>;
  download(subKey: string): Promise<Buffer>;
  delete(subKey: string): Promise<void>;
  exists(subKey: string): Promise<boolean>;
  getMetadata(subKey: string): Promise<StorageMetadata | null>;
  /** For a caller (ffmpeg) that needs a REAL local file regardless of backend — local returns its real path directly; R2 downloads to a scratch temp file. Always call cleanup(). */
  getLocalPath(subKey: string): Promise<{ path: string; cleanup: () => Promise<void> }>;
  /** Deletes every object under this workspace's `dirKey` prefix — local-only today (R2 has no native "directory"; a future R2 deployment would list-then-batch-delete by prefix here). */
  removeDir(dirKey: string): Promise<void>;
};

export function storageFor(workspaceId: string): WorkspaceStorage {
  const key = (subKey: string) => { assertSafeSubKey(subKey); return `${workspaceId}/${subKey}`; };
  const backend = provider();

  if (backend === 'r2') {
    const cfg = r2Config()!;
    return {
      upload: (subKey, data, contentType) => r2Upload(cfg, key(subKey), data, contentType),
      download: (subKey) => r2Download(cfg, key(subKey)),
      delete: (subKey) => r2Delete(cfg, key(subKey)),
      exists: async (subKey) => (await r2Stat(cfg, key(subKey))) !== null,
      getMetadata: (subKey) => r2Stat(cfg, key(subKey)),
      getLocalPath: (subKey) => r2DownloadToTempFile(cfg, key(subKey)),
      removeDir: () => { throw new Error('removeDir is not supported on the R2 backend yet — see src/lib/storage/index.ts.'); },
    };
  }

  return {
    upload: async (subKey, data) => { await saveFile(key(subKey), data); },
    download: async (subKey) => { const fs = await import('node:fs/promises'); return fs.readFile(resolvePath(key(subKey))); },
    delete: (subKey) => removeFile(key(subKey)),
    exists: async (subKey) => (await statFile(key(subKey))) !== null,
    getMetadata: (subKey) => statFile(key(subKey)),
    getLocalPath: async (subKey) => ({ path: resolvePath(key(subKey)), cleanup: async () => {} }),
    removeDir: (dirKey) => removeDir(key(dirKey)),
  };
}
