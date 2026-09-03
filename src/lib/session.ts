import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { db } from './db';

const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET || 'dev-only-insecure-secret-change-me');
const COOKIE = 'op_session';

export type SessionData = { userId: string; workspaceId: string };

export async function createSession(data: SessionData) {
  const token = await new SignJWT(data)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 30,
  });
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<SessionData | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, secret());
    return { userId: String(payload.userId), workspaceId: String(payload.workspaceId) };
  } catch { return null; }
}

/** Throws if not signed in. Use at the top of every server action / route. */
export async function requireSession(): Promise<SessionData> {
  const s = await getSession();
  if (!s) throw new Error('UNAUTHORIZED');
  return s;
}

export async function currentWorkspace() {
  const s = await getSession();
  if (!s) return null;
  return db.workspace.findUnique({ where: { id: s.workspaceId } });
}
