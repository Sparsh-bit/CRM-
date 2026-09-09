import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { db } from '@/lib/db';
import { createSession, getSession } from '@/lib/session';
import { checkLoginRateLimit } from '@/lib/auth/rateLimit';
import bcrypt from 'bcryptjs';

export const dynamic = 'force-dynamic';

async function submit(formData: FormData) {
  'use server';
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const password = String(formData.get('password') || '');
  if (!email || password.length < 8) throw new Error('Email and an 8+ character password are required');

  // Every attempt counts against budget, not just failures — an unrecognized
  // email below silently creates a new workspace, which is itself the
  // resource-exhaustion risk this guards against, not only password guessing.
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  await checkLoginRateLimit(`email:${email}`);
  await checkLoginRateLimit(`ip:${ip}`);

  let user = await db.user.findUnique({ where: { email }, include: { memberships: true } });

  if (!user) {
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
    redirect('/onboarding');
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new Error('Wrong password');
  const membership = user.memberships[0];
  if (!membership) throw new Error('No workspace for this user');
  await createSession({ userId: user.id, workspaceId: membership.workspaceId });
  redirect('/');
}

export default async function Login() {
  if (await getSession()) redirect('/');
  return (
    <div className="max-w-sm mx-auto mt-20 card">
      <h1 className="text-xl font-semibold mb-1">OutreachPilot</h1>
      <p className="text-sm text-muted mb-6">Sign in, or enter a new email to create a workspace.</p>
      <form action={submit} className="space-y-4">
        <div><label className="label">Email</label><input className="input" name="email" type="email" required /></div>
        <div><label className="label">Password</label><input className="input" name="password" type="password" required minLength={8} /></div>
        <button className="btn w-full justify-center">Continue</button>
      </form>
    </div>
  );
}
