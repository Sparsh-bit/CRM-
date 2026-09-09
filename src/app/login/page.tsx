import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import Link from 'next/link';
import { db } from '@/lib/db';
import { createSession, getSession } from '@/lib/session';
import { checkLoginRateLimit, RateLimitedError } from '@/lib/auth/rateLimit';
import bcrypt from 'bcryptjs';
import { LoginForm, type LoginState } from './_components/LoginForm';

export const dynamic = 'force-dynamic';

// A generic, safe fallback for anything NOT explicitly recognized below —
// never let a raw exception (a DB error, a Prisma error, any internal
// detail) reach the browser. Server Actions forward a thrown Error's
// .message to the client by default; returning this instead of throwing
// is what keeps that from happening here.
const SERVICE_UNAVAILABLE = 'The service is temporarily unavailable. Please try again in a moment.';

async function submit(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  'use server';
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const password = String(formData.get('password') || '');
  if (!email || password.length < 8) {
    return { error: 'Enter your email and an 8+ character password.' };
  }

  // Every attempt counts against budget, not just failures — an unrecognized
  // email below silently creates a new workspace, which is itself the
  // resource-exhaustion risk this guards against, not only password guessing.
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  try {
    await checkLoginRateLimit(`email:${email}`);
    await checkLoginRateLimit(`ip:${ip}`);
  } catch (e) {
    if (e instanceof RateLimitedError) return { error: e.message };
    return { error: SERVICE_UNAVAILABLE };
  }

  let user;
  try {
    user = await db.user.findUnique({ where: { email }, include: { memberships: true } });
  } catch {
    return { error: SERVICE_UNAVAILABLE };
  }

  if (!user) {
    try {
      const hash = await bcrypt.hash(password, 10);
      const slug = email.split('@')[0].replace(/[^a-z0-9]/g, '') + '-' + Math.random().toString(36).slice(2, 6);
      const created = await db.user.create({ data: { email, passwordHash: hash } });
      const ws = await db.workspace.create({
        data: {
          name: email.split('@')[1] ?? 'My workspace', slug,
          senderName: '', senderCompany: '',
          members: { create: { userId: created.id, role: 'owner' } },
        },
      });
      await createSession({ userId: created.id, workspaceId: ws.id });
    } catch {
      return { error: SERVICE_UNAVAILABLE };
    }
    redirect('/onboarding'); // deliberately outside the try/catch — redirect() throws internally, must not be swallowed
  }

  let ok: boolean;
  try {
    ok = await bcrypt.compare(password, user.passwordHash);
  } catch {
    return { error: SERVICE_UNAVAILABLE };
  }
  if (!ok) return { error: 'Incorrect email or password.' };

  const membership = user.memberships?.[0];
  if (!membership) return { error: SERVICE_UNAVAILABLE }; // a user with no workspace membership is a data anomaly, not something the visitor caused or can fix

  try {
    await createSession({ userId: user.id, workspaceId: membership.workspaceId });
  } catch {
    return { error: SERVICE_UNAVAILABLE };
  }
  redirect('/');
}

export default async function Login() {
  if (await getSession()) redirect('/');
  return (
    <div className="min-h-[100dvh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <Link href="/landing" className="font-display font-semibold tracking-tight text-slate-100 text-lg block text-center">
          OutreachPilot
        </Link>
        <LoginForm action={submit} />
        <p className="text-secondary text-center">
          <Link href="/landing" className="text-accent hover:underline">← Back to the overview</Link>
        </p>
      </div>
    </div>
  );
}
