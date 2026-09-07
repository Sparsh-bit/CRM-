import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyClickUrl } from '@/lib/email/tracking';

/**
 * Fixed (found by a peer session's audit): `u` used to be redirected to
 * unconditionally as long as it had an http(s) scheme — a real open
 * redirect, since it was never checked against what this `tid` actually
 * linked to. `u` must now carry a valid `sig` (src/lib/email/tracking.ts's
 * signClickUrl/verifyClickUrl, HMAC'd with AUTH_SECRET when the link was
 * generated) tying it to this exact trackingId — an unsigned or forged
 * target is refused outright, never followed, and the click is not
 * recorded for it either (it was never a real click on a real message).
 */
export async function GET(req: Request, { params }: { params: Promise<{ tid: string }> }) {
  const { tid } = await params;
  const url = new URL(req.url);
  const target = url.searchParams.get('u');
  const sig = url.searchParams.get('sig');
  const validTarget = !!target && /^https?:\/\//i.test(target) && verifyClickUrl(tid, target, sig);

  if (!validTarget) return NextResponse.redirect(new URL('/', req.url));

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
  } catch { /* ignore — tracking the click is best-effort, must never block the actual redirect */ }

  return NextResponse.redirect(target);
}
