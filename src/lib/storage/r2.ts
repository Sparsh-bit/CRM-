/**
 * S3-compatible object storage backend — Cloudflare R2 by default, or ANY
 * other S3-compatible service (e.g. a Railway-hosted MinIO bucket) via an
 * explicit endpoint override. The official, actively maintained AWS SDK
 * (@aws-sdk/client-s3, Apache-2.0) is the real client either way — R2 and
 * MinIO both speak the same S3 API, so no second client library or second
 * storage abstraction was needed to support both. Not activated unless
 * STORAGE_PROVIDER=r2 and the required env vars are actually set (index.ts)
 * — "do not make R2 mandatory yet" (Section 8) applies equally to this.
 *
 * Two ways to configure `endpoint`:
 *  - R2_ACCOUNT_ID set, R2_ENDPOINT unset: constructs Cloudflare's own R2
 *    endpoint pattern automatically (unchanged default behavior).
 *  - R2_ENDPOINT set (e.g. a Railway bucket's S3 endpoint): used verbatim,
 *    R2_ACCOUNT_ID is not needed at all. Real third-party S3-compatible
 *    services (MinIO included) almost always need path-style addressing
 *    (bucket in the URL path, not a subdomain) rather than R2/AWS's
 *    virtual-hosted style — forcePathStyle defaults to true whenever a
 *    custom endpoint is used, overridable via R2_FORCE_PATH_STYLE.
 */
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';

export type R2Config = {
  /** Cloudflare account id — used only to construct the default R2 endpoint when `endpoint` is not given. */
  accountId?: string;
  /** Explicit S3-compatible endpoint URL (e.g. a Railway bucket's own endpoint) — takes priority over accountId when set. */
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
};

// Cached, not rebuilt per call — the same lesson src/lib/db.ts's connection-
// pooling bug taught this pass: a fresh S3Client per operation means a fresh
// underlying HTTPS agent (and a fresh TLS handshake) every single time
// instead of reusing keep-alive connections, for a config that in practice
// never changes within one running process (credentials come from env, read
// once). Lower stakes than the Postgres bug (no hard connection-count
// ceiling to exhaust the way a database does), but the same shape of waste,
// found while auditing for it — fixed the same way.
let cached: { key: string; client: S3Client } | null = null;

// Every other outbound integration in this codebase (AI provider, WhatsApp,
// SMS, research fetch/search) wires an explicit timeout so a hung connection
// can't block a worker tick indefinitely — the S3Client was the one outlier,
// relying entirely on the AWS SDK's own (much longer, and less predictable
// across versions) defaults. connectionTimeout bounds the TCP+TLS handshake;
// requestTimeout bounds the whole request once sent — larger than the other
// integrations' since a media upload/download can legitimately be tens of MB.
const CONNECT_TIMEOUT_MS = Number(process.env.STORAGE_R2_CONNECT_TIMEOUT_MS ?? 10_000);
const REQUEST_TIMEOUT_MS = Number(process.env.STORAGE_R2_REQUEST_TIMEOUT_MS ?? 30_000);

function resolveEndpoint(cfg: R2Config): string {
  if (cfg.endpoint) return cfg.endpoint;
  if (cfg.accountId) return `https://${cfg.accountId}.r2.cloudflarestorage.com`;
  throw new Error('R2Config needs either `endpoint` (a generic S3-compatible URL) or `accountId` (Cloudflare R2) — neither was given.');
}

function client(cfg: R2Config): S3Client {
  const endpoint = resolveEndpoint(cfg);
  const key = `${endpoint}:${cfg.accessKeyId}:${cfg.bucket}`;
  if (cached && cached.key === key) return cached.client;
  const built = new S3Client({
    region: cfg.region || 'auto',
    endpoint,
    forcePathStyle: cfg.forcePathStyle ?? !!cfg.endpoint, // third-party S3-compatible services (MinIO included) almost always need this; R2's own default (no custom endpoint) does not
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // throwOnRequestTimeout is NOT the default — without it, NodeHttpHandler
    // only logs a warning when requestTimeout is exceeded and lets the
    // request hang anyway (confirmed empirically: scripts/outbound-timeout-
    // test.ts hung well past its configured 600ms until this was added).
    // The timeout config alone does nothing on its own SDK version; this
    // flag is what actually makes it abort.
    requestHandler: new NodeHttpHandler({
      connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, throwOnRequestTimeout: true,
    }),
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
