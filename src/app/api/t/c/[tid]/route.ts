import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: Request, { params }: { params: Promise<{ tid: string }> }) {
  const { tid } = await params;
  const target = new URL(req.url).searchParams.get('u');
  try {
    const m = await db.message.findUnique({ where: { trackingId: tid } });
    if (m) {
      await db.$transaction([
        db.message.update({
          where: { id: m.id },
          data: { clickedAt: m.clickedAt ?? new Date(), openedAt: m.openedAt ?? new Date() },
        }),
        db.event.create({ data: { messageId: m.id, type: 'click', meta: { url: target } } }),
      ]);
    }
  } catch { /* ignore */ }
  if (!target || !/^https?:\/\//i.test(target)) return NextResponse.redirect(new URL('/', req.url));
  return NextResponse.redirect(target);
}
