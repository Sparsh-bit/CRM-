/**
 * Cloudflare R2 backend — R2 speaks the S3 API, so the official, actively
 * maintained AWS SDK (@aws-sdk/client-s3, Apache-2.0) is the real client
 * here, pointed at R2's S3-compatible endpoint. Not activated unless
 * STORAGE_PROVIDER=r2 and the R2_* env vars are actually set (index.ts) —
 * "do not make R2 mandatory yet" (Section 8).
 */
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';

export type R2Config = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };

// Cached, not rebuilt per call — the same lesson src/lib/db.ts's connection-
// pooling bug taught this pass: a fresh S3Client per operation means a fresh
// underlying HTTPS agent (and a fresh TLS handshake) every single time
// instead of reusing keep-alive connections, for a config that in practice
// never changes within one running process (R2 credentials come from env,
// read once). Lower stakes than the Postgres bug (R2 has no hard
// connection-count ceiling to exhaust the way a database does), but the
// same shape of waste, found while auditing for it — fixed the same way.
let cached: { key: string; client: S3Client } | null = null;

function client(cfg: R2Config): S3Client {
  const key = `${cfg.accountId}:${cfg.accessKeyId}:${cfg.bucket}`;
  if (cached && cached.key === key) return cached.client;
  const built = new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  cached = { key, client: built };
  return built;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function r2Upload(cfg: R2Config, key: string, data: Buffer, contentType?: string): Promise<void> {
  await client(cfg).send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: data, ContentType: contentType }));
}

export async function r2Download(cfg: R2Config, key: string): Promise<Buffer> {
  const res = await client(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return streamToBuffer(res.Body as NodeJS.ReadableStream);
}

export async function r2Delete(cfg: R2Config, key: string): Promise<void> {
  await client(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

export async function r2Stat(cfg: R2Config, key: string): Promise<{ sizeBytes: number; lastModified: Date; contentType?: string } | null> {
  try {
    const res = await client(cfg).send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return { sizeBytes: res.ContentLength ?? 0, lastModified: res.LastModified ?? new Date(), contentType: res.ContentType };
  } catch (e) {
    if ((e as { name?: string }).name === 'NotFound') return null;
    throw e;
  }
}

/** R2 has no "local path" — download to a scratch temp file so a caller (ffmpeg) that needs a real file can work identically regardless of backend. Caller MUST invoke the returned cleanup(). */
export async function r2DownloadToTempFile(cfg: R2Config, key: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const data = await r2Download(cfg, key);
  const tmp = path.join(os.tmpdir(), `outreachpilot-r2-${nanoid()}${path.extname(key)}`);
  await fs.writeFile(tmp, data);
  return { path: tmp, cleanup: () => fs.rm(tmp, { force: true }) };
}
