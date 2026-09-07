/**
 * Backend contract for Section 19 ("expose clean backend contracts... media
 * analysis") — the frontend session can wire this up later; nothing in
 * src/app/workforce or src/components was touched to build it. Uploads a
 * media file through StorageService (workspace-scoped — Section 8/10) and
 * returns a mediaId that analyze_uploaded_media (the agent tool) accepts —
 * the tool itself never receives raw bytes, only this id, since a tool's
 * input is plain JSON (Section 11's zod contract).
 */
import { nanoid } from 'nanoid';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { storageFor } from '@/lib/storage';
import { workspaceLimits, checkGaugeQuota } from '@/lib/usage/service';

const MAX_UPLOAD_BYTES = Number(process.env.RESEARCH_UPLOAD_MAX_BYTES ?? 200_000_000); // 200MB
const ALLOWED_MIME_PREFIXES = ['video/', 'audio/'];

export async function POST(req: Request) {
  // Found by a peer session's audit: requireSession() throws for an
  // unauthenticated request, which used to crash uncaught into Next's
  // generic 500 HTML page instead of a clean, real 401.
  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession();
  } catch {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > MAX_UPLOAD_BYTES) {
    return Response.json({ error: `File exceeds the ${MAX_UPLOAD_BYTES}-byte limit.` }, { status: 413 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || !(file instanceof File)) {
    return Response.json({ error: 'Multipart field "file" is required.' }, { status: 400 });
  }
  if (!ALLOWED_MIME_PREFIXES.some((p) => file.type.startsWith(p))) {
    return Response.json({ error: `Unsupported content type "${file.type}" — only video/* or audio/* is accepted.` }, { status: 415 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: `File exceeds the ${MAX_UPLOAD_BYTES}-byte limit.` }, { status: 413 });
  }

  const limits = await workspaceLimits(session.workspaceId);
  const used = (await db.mediaAsset.aggregate({ where: { workspaceId: session.workspaceId }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0;
  try {
    checkGaugeQuota(limits, 'storage_bytes', used, file.size);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 402 });
  }

  const mediaId = nanoid();
  const ext = (file.name.split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 10);
  const subKey = `${mediaId}/original.${ext}`; // workspace-scoped automatically by storageFor() below — never prefixed by hand
  const buffer = Buffer.from(await file.arrayBuffer());
  await storageFor(session.workspaceId).upload(subKey, buffer, file.type);

  const asset = await db.mediaAsset.create({
    data: {
      id: mediaId, workspaceId: session.workspaceId, uploadedBy: session.userId,
      filename: file.name.slice(0, 255), mimeType: file.type, sizeBytes: file.size, storagePath: subKey,
    },
  });

  return Response.json({ mediaId: asset.id, filename: asset.filename, sizeBytes: asset.sizeBytes });
}
