import { db } from '@/lib/db';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export async function GET(_req: Request, { params }: { params: Promise<{ tid: string }> }) {
  const { tid } = await params;
  try {
    const m = await db.message.findUnique({ where: { trackingId: tid } });
    if (m && !m.openedAt) {
      await db.$transaction([
        db.message.update({ where: { id: m.id }, data: { openedAt: new Date() } }),
        db.event.create({ data: { messageId: m.id, type: 'open' } }),
      ]);
    }
  } catch { /* never let tracking break image loading */ }

  return new Response(PIXEL, {
    headers: {
      'content-type': 'image/gif',
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      pragma: 'no-cache',
    },
  });
}
